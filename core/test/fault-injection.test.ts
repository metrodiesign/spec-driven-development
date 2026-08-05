// Fault-injection suite — the Phase 0 DoD (loop-engineering-implementation-spec.md §11, 9 scenarios).
// Written RED-FIRST (spec §0.4): these tests define what the core must catch
// BEFORE the core exists. Never weaken a scenario to make it pass (INV-16).
//
// Hardened after an adversarial review of the suite itself (18 confirmed/split
// findings applied): every scenario now discriminates a REAL mechanism from a
// fabricated one — honest paths prove gates actually run against the worktree,
// evidence refs must resolve in the store, recovery is exercised for partial
// applies and re-entrancy, dedupe must survive a process restart, and the lease
// race runs across two real processes.
//
// Scenarios that exercise RUN_COMMAND need the deny-network sandbox, which
// Phase 0 implements on darwin only (docs/DEVIATIONS.md D-003 — CI pinned to a
// darwin runner). On other hosts those paths assert the fail-closed refusal.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createBudget } from '../src/budget/budget.ts';
import { createCoreCommandExecutor } from '../src/executor/command-executor.ts';
import { createDefaultPathPolicy } from '../src/executor/path-policy.ts';
import { createEvidenceStore } from '../src/evidence/store.ts';
import { createExecutor, CrashInjected, recoverWorktree } from '../src/executor/executor.ts';
import { createGateRunner, type GateRunner } from '../src/gates/runner.ts';
import { ReportIntegrityError } from '../src/gates/report-integrity.ts';
import { createLeaseManager } from '../src/state/lease.ts';
import { createCommandRunner } from '../src/security/command-runner.ts';
import { denyNetworkSandbox } from '../src/security/sandbox.ts';
import { openEventLog } from '../src/state/event-log.ts';
import { runTaskLoop } from '../src/orchestrator/loop.ts';
import type { Failpoints } from '../src/executor/executor.ts';
import type { Proposal, ProposalInput, ProposalSource } from '../src/ports.ts';
import type { Action, BudgetLimits, GateCheck } from '../src/types.ts';
import {
  git,
  installAlwaysFailTests,
  installFlakyTests,
  makeClock,
  makeFixture,
  makeReportIntegrity,
  PASSTHROUGH_TEST_SANDBOX,
  makeTestLeaseSession,
  sha256Hex,
  type Fixture,
} from './helpers/fixture.ts';

const execFileAsync = promisify(execFile);
const realMacOS =
  process.platform === 'darwin' && process.env['PHASE0_REAL_MACOS_TESTS'] === '1';
const realMacOSOnly = {
  skip: !realMacOS ? 'requires explicit execution outside a nested sandbox' : false,
};

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';

const DEFAULT_LIMITS: BudgetLimits = {
  maxIterations: 8,
  maxCostUnits: 500,
  maxWallclockMs: 60_000,
};

function buildCore(fix: Fixture, clock = makeClock(), failpoints?: Failpoints) {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const policy = createDefaultPathPolicy();
  const sandbox = realMacOS
    ? denyNetworkSandbox(process.platform)
    : PASSTHROUGH_TEST_SANDBOX;
  const commandRunner = createCommandRunner({ sandbox, evidence });
  const commandExecutor = createCoreCommandExecutor({
    evidence,
    policy,
    sandbox,
    commandRunner,
  });
  const executor = createExecutor({
    worktreeDir: fix.worktree,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    policy,
    sandbox,
    commandRunner,
    coreCommandExecutor: commandExecutor,
    clock,
    ...(failpoints ? { failpoints } : {}),
  });
  const gates = createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence),
    clock,
    commandExecutor,
  });
  return { log, evidence, policy, sandbox, executor, gates, clock };
}

function taskStates(log: ReturnType<typeof openEventLog>): string[] {
  return log.all({ type: 'TASK_STATE' }).map((e) => String(e.payload['state']));
}

function loopFor(
  c: ReturnType<typeof buildCore>,
  source: ProposalSource,
  budget = createBudget(DEFAULT_LIMITS, c.clock),
  gates: GateRunner = c.gates,
) {
  return runTaskLoop({
    runId: RUN_ID,
    taskId: TASK_ID,
    role: 'implementer',
    source,
    executor: c.executor,
    gates,
    log: c.log,
    budget,
    clock: c.clock,
    lease: makeTestLeaseSession(TASK_ID),
  });
}

function honestSource(c: ReturnType<typeof buildCore>): ProposalSource {
  return {
    async propose(input: ProposalInput): Promise<Proposal> {
      if (input.state === 'IMPLEMENTING') {
        return {
          claim: 'READY_FOR_VERIFICATION',
          actions: [{
            type: 'WRITE_FILE',
            actionId: 'a-auth-fix',
            path: 'src/impl.txt',
            contentRef: c.evidence.put('correct\n'),
          }],
          costUnits: 1,
        };
      }
      return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
    },
  };
}

/** Every GATE_RESULT must be bound to real, resolvable evidence (INV-10). */
function assertGateEventsBacked(c: ReturnType<typeof buildCore>, fix: Fixture): void {
  const expectedConfigHash = sha256Hex(readFileSync(fix.gateConfigPath));
  const gateEvents = c.log.all({ type: 'GATE_RESULT' });
  assert.ok(gateEvents.length >= 1, 'at least one core-run gate result');
  for (const e of gateEvents) {
    assert.equal(
      e.payload['gateConfigHash'],
      expectedConfigHash,
      'gate config hash = sha256 of the actual config bytes (REQ-8.3)',
    );
    assert.match(
      String(e.payload['worktreeHash'] ?? ''),
      /^[0-9a-f]{40}$/,
      'gate result binds the tested (possibly dirty) tree via worktreeHash (REQ-4.2)',
    );
    const checks = e.payload['checks'] as GateCheck[];
    for (const check of checks) {
      assert.ok(
        c.evidence.has(check.evidenceRef),
        `check ${check.name}: evidenceRef resolves in the store (no fabricated results)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DoD#1 — the agent lies about success: core runs the gates itself and refuses
// to believe the claim (REQ-7.2/7.3; INV-1/2). Paired with the honest path so a
// loop that fabricates gate events (or refuses everything) dies one way or the
// other: outcomes must depend on the real worktree.
// ---------------------------------------------------------------------------
test('DoD#1: lying READY_FOR_VERIFICATION claim never produces PASSED', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = buildCore(fix, clock);
    let proposeCalls = 0;
    const liar: ProposalSource = {
      async propose(): Promise<Proposal> {
        proposeCalls += 1;
        // Claims done, changes nothing — target tests genuinely fail.
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };
    const result = await loopFor(c, liar, createBudget({ ...DEFAULT_LIMITS, maxIterations: 2 }, clock));

    assert.ok(c.log.all({ type: 'CLAIM_RECORDED' }).length >= 1, 'claim recorded as data');
    assertGateEventsBacked(c, fix);
    const states = taskStates(c.log);
    assert.ok(!states.includes('PASSED'), 'never PASSED on a lie');
    assert.ok(!states.includes('REVIEWING'), 'never reached REVIEWING on a lie');
    assert.ok(!states.includes('COMPLETED'), 'never COMPLETED (INV-2)');
    assert.ok(states.includes('FAILED'), 'core-run gate produced FAILED');
    assert.equal(result.finalState, 'ESCALATED', 'repeated lying exhausts budget -> ESCALATED');
    assert.equal(proposeCalls, 2, 'loop halted at the iteration budget');
  } finally {
    fix.cleanup();
  }
});

test('DoD#1b (honest control): real green work reaches REVIEWING with backed evidence (REQ-7.6)', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const honest: ProposalSource = {
      async propose(input: ProposalInput): Promise<Proposal> {
        if (input.state === 'IMPLEMENTING') {
          return {
            claim: 'READY_FOR_VERIFICATION',
            actions: [
              {
                type: 'WRITE_FILE',
                actionId: 'a-honest',
                path: 'src/impl.txt',
                contentRef: c.evidence.put('correct\n'),
              },
            ],
            costUnits: 1,
          };
        }
        return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
      },
    };
    const result = await loopFor(c, honest);

    assert.equal(result.finalState, 'REVIEWING', 'honest work reaches the Phase 0 terminal');
    assert.equal(result.terminalMarker, 'awaiting_human_phase0');
    const greens = c.log
      .all({ type: 'GATE_RESULT' })
      .filter((e) => e.payload['pass'] === true && e.payload['tier'] === 'T1');
    assert.ok(greens.length >= 1, 'a genuinely green T1 exists');
    assertGateEventsBacked(c, fix);
    // The outcome depended on the worktree: the file really changed.
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#2 — actions outside the allowlist / touching golden are rejected as
// structured feedback, not applied, and never crash the loop (REQ-1.2/1.3/1.5).
// The allowlist is proven POSITIVE (in-worktree but non-allowlisted paths are
// rejected — including the gate script itself, the fake-green rewrite route).
// ---------------------------------------------------------------------------
test('DoD#2: out-of-policy actions are rejected as structured feedback', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const contentRef = c.evidence.put('malicious content\n');
    const originalGateScript = readFileSync(join(fix.worktree, 'run-tests.sh'), 'utf8');

    const cases: { action: Action; role: 'planner' | 'implementer'; expect: string }[] = [
      {
        action: { type: 'WRITE_FILE', actionId: 'a-escape', path: '../outside.txt', contentRef },
        role: 'implementer',
        expect: 'path_outside_allowlist',
      },
      {
        action: {
          type: 'WRITE_FILE',
          actionId: 'a-escape2',
          path: 'src/../../outside2.txt',
          contentRef,
        },
        role: 'implementer',
        expect: 'path_outside_allowlist',
      },
      {
        action: { type: 'WRITE_FILE', actionId: 'a-abs', path: '/tmp/pwn-fi.txt', contentRef },
        role: 'implementer',
        expect: 'path_outside_allowlist',
      },
      {
        action: {
          type: 'WRITE_FILE',
          actionId: 'a-golden',
          path: 'test/golden/expected.txt',
          contentRef,
        },
        role: 'implementer',
        expect: 'golden_write_denied',
      },
      {
        action: {
          type: 'WRITE_FILE',
          actionId: 'a-golden2',
          path: 'src/../test/golden/expected.txt',
          contentRef,
        },
        role: 'implementer',
        expect: 'golden_write_denied',
      },
      {
        // POSITIVE allowlist: inside the worktree but not writable by any role —
        // rewriting the gate script is the classic fake-green route.
        action: { type: 'WRITE_FILE', actionId: 'a-gate', path: 'run-tests.sh', contentRef },
        role: 'implementer',
        expect: 'path_outside_allowlist',
      },
      {
        action: { type: 'WRITE_FILE', actionId: 'a-planner', path: 'src/impl.txt', contentRef },
        role: 'planner',
        expect: 'path_outside_allowlist',
      },
    ];

    for (const { action, role, expect } of cases) {
      const out = await c.executor.execute(action, role);
      assert.equal(out.status, 'rejected', `${action.actionId} must be rejected`);
      if (out.status === 'rejected') {
        assert.equal(out.rejection.reason, expect, `${action.actionId} reason`);
      }
    }

    assert.ok(!existsSync(join(fix.root, 'outside.txt')), 'escape file was not written');
    assert.ok(!existsSync(join(fix.root, 'outside2.txt')), 'prefix-escape file was not written');
    assert.ok(!existsSync('/tmp/pwn-fi.txt'), 'absolute-path file was not written');
    assert.equal(
      readFileSync(join(fix.worktree, 'test/golden/expected.txt'), 'utf8'),
      'golden truth\n',
      'golden content untouched',
    );
    assert.equal(
      readFileSync(join(fix.worktree, 'run-tests.sh'), 'utf8'),
      originalGateScript,
      'gate script untouched',
    );
    assert.equal(c.log.all({ type: 'ACTION_REJECTED' }).length, cases.length, 'every rejection logged');
    assert.equal(c.log.all({ type: 'ACTION_APPLIED' }).length, 0, 'nothing applied');
  } finally {
    fix.cleanup();
  }
});

test('DoD#2b: a failed T0 takes the deterministic diagnosis path after action rejection (REQ-1.5/REQ-5.5)', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const seenFeedback: ProposalInput['feedback'][] = [];
    const source: ProposalSource = {
      async propose(input: ProposalInput): Promise<Proposal> {
        seenFeedback.push(input.feedback);
        if (seenFeedback.length === 1) {
          return {
            claim: 'WORKING',
            actions: [
              {
                type: 'WRITE_FILE',
                actionId: 'a-bad',
                path: '../escape.txt',
                contentRef: c.evidence.put('x'),
              },
            ],
            costUnits: 1,
          };
        }
        return { claim: 'BLOCKED', actions: [], costUnits: 1 };
      },
    };
    const result = await loopFor(c, source);

    assert.equal(result.finalState, 'ESCALATED', 'T0 failure cannot be bypassed by a later BLOCKED claim');
    const secondRound = seenFeedback[1];
    assert.ok(
      secondRound && !Array.isArray(secondRound) && 'tier' in secondRound && secondRound.tier === 'T0',
      'diagnostician receives the authenticated failed T0 report',
    );
    assert.equal(c.log.all({ type: 'ACTION_REJECTED' }).length, 1, 'the structured action rejection remains logged');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#2c — RUN_COMMAND side effects are contained by the sandbox: file writes
// outside the task worktree and onto test/golden are denied even THROUGH a
// shell (REQ-1.2/1.3 at the command layer). Escape writes would be invisible
// to worktreeHash/rollback/golden-manifest, so they must be impossible at run
// time, not merely detected later.
// ---------------------------------------------------------------------------
test('DoD#2c: RUN_COMMAND cannot write outside the worktree or onto golden', realMacOSOnly, async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const escapeTarget = join(fix.root, 'cmd-escape.txt');

    const outEscape = await c.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'a-cmd-escape',
        cmd: `printf x > "${escapeTarget}"`,
        network: 'none',
      },
      'implementer',
    );
    assert.equal(outEscape.status, 'rejected', 'sandbox denial returns structured feedback');
    if (outEscape.status === 'rejected') {
      assert.equal(outEscape.rejection.reason, 'sandbox_violation');
    }
    assert.ok(!existsSync(escapeTarget), 'no file materialized outside the worktree');

    const outGolden = await c.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'a-cmd-golden',
        cmd: 'echo tampered >> test/golden/expected.txt',
        network: 'none',
      },
      'implementer',
    );
    assert.equal(outGolden.status, 'rejected');
    if (outGolden.status === 'rejected') {
      assert.equal(outGolden.rejection.reason, 'sandbox_violation');
    }
    assert.equal(
      readFileSync(join(fix.worktree, 'test/golden/expected.txt'), 'utf8'),
      'golden truth\n',
      'golden content untouched even via shell',
    );

    // Control: writes INSIDE the worktree still work — containment, not breakage.
    const outOk = await c.executor.execute(
      {
        type: 'RUN_COMMAND',
        actionId: 'a-cmd-ok',
        cmd: 'printf ok > src/cmd-out.txt',
        network: 'none',
      },
      'implementer',
    );
    assert.equal(outOk.status, 'applied');
    if (outOk.status === 'applied') {
      assert.equal(outOk.exitCode, 0, 'legit in-worktree write succeeded');
    }
    assert.equal(readFileSync(join(fix.worktree, 'src/cmd-out.txt'), 'utf8'), 'ok');
  } finally {
    fix.cleanup();
  }
});

test('DoD#2d / REQ-2.4 + spec §6.1: planner and test_designer cannot run ANY command — denied before spawn', realMacOSOnly, async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    // checkCommand (spec §6.1) rejects every non-implementer/diagnostician role BEFORE
    // spawn, so neither a write nor a read command runs — a real macOS spawn would have
    // created the marker files if the gate leaked. The former "planner retains read-only
    // command access" behaviour is intentionally removed: only implementer and
    // diagnostician may run commands at all.
    const cases = [
      {
        role: 'planner' as const,
        actionId: 'planner-command-write',
        cmd: 'printf bypass > src/planner-owned.txt',
        target: join(fix.worktree, 'src', 'planner-owned.txt'),
      },
      {
        role: 'test_designer' as const,
        actionId: 'test-command-write',
        cmd: 'printf bypass > src/test-owned.txt',
        target: join(fix.worktree, 'src', 'test-owned.txt'),
      },
      {
        // A test_designer command targeting its OWN former write root is now denied too:
        // the role gate is on the command, not the path.
        role: 'test_designer' as const,
        actionId: 'test-command-allowed-write',
        cmd: 'printf allowed > test/ai-generated/allowed.txt',
        target: join(fix.worktree, 'test', 'ai-generated', 'allowed.txt'),
      },
      {
        // A pure read command by planner is denied as well (no read-only exemption).
        role: 'planner' as const,
        actionId: 'planner-command-read',
        cmd: 'test -f src/impl.txt',
        target: undefined,
      },
    ];
    for (const item of cases) {
      const out = await c.executor.execute(
        { type: 'RUN_COMMAND', actionId: item.actionId, cmd: item.cmd, network: 'none' },
        item.role,
      );
      assert.equal(out.status, 'rejected', `${item.actionId} is a structured rejection`);
      if (out.status === 'rejected') assert.equal(out.rejection.reason, 'command_role_denied');
      if (item.target !== undefined) assert.equal(existsSync(item.target), false);
    }
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#3 — a command that sneaks toward the network is blocked at connect and
// the block is logged with core-captured evidence (REQ-2.1/2.2); hosts without
// an enforcing sandbox refuse to run at all (REQ-2.3, fail-closed).
// Probe uses a raw IP + no proxy dependence: nc to 1.1.1.1:443 succeeds on any
// open network, so only a REAL kernel-level deny makes it fail (child procs
// inherit the profile — a proxy-env "sandbox" cannot pass this).
// ---------------------------------------------------------------------------
test('DoD#3: egress attempt under network:"none" is blocked (or refused fail-closed)', realMacOSOnly, async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const action: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-egress',
      cmd: '/usr/bin/nc -z -G 3 -w 3 1.1.1.1 443',
      network: 'none',
    };
    const out = await c.executor.execute(action, 'implementer');

    if (realMacOS) {
      assert.equal(out.status, 'rejected', 'kernel denial becomes a structured rejection');
      if (out.status === 'rejected') {
        assert.equal(out.rejection.reason, 'sandbox_violation');
        const evidenceRef = out.rejection.detail.match(/evidence=(blob:\/\/[0-9a-f]{64})/)?.[1];
        assert.ok(evidenceRef, 'structured denial carries the core-owned evidence ref');
        const text = c.evidence.getText(evidenceRef);
        assert.ok(text.length > 0, 'captured evidence is non-empty');
        assert.match(text, /status:sandbox_violation/, 'evidence records the enforcement status');
        assert.match(text, /egress-blocked:true/, 'evidence records the requested network deny');
      }
      const rejected = c.log.all({ type: 'ACTION_REJECTED' });
      assert.ok(
        rejected.some((e) => e.payload['reason'] === 'sandbox_violation'),
        'egress denial is visible as a rejection in the event log',
      );
    } else {
      assert.equal(out.status, 'rejected', 'no enforcing sandbox -> refuse to run');
      if (out.status === 'rejected') {
        assert.equal(out.rejection.reason, 'sandbox_unavailable');
      }
    }
  } finally {
    fix.cleanup();
  }
});

test('DoD#3b / REQ-2.1: T0 and T1 raw-IP egress are denied by the same core child boundary', realMacOSOnly, async () => {
  const rawIpProbe = '/usr/bin/nc -z -G 3 -w 3 1.1.1.1 443';
  const scenarios = [
    { tier: 'T0' as const, checkName: 'lint', fixture: { t0Lint: rawIpProbe } },
    { tier: 'T1' as const, checkName: 'fullTests', fixture: { fullTests: rawIpProbe } },
  ];

  for (const scenario of scenarios) {
    const fix = makeFixture(scenario.fixture);
    try {
      const c = buildCore(fix);
      const report = await c.gates.run(scenario.tier);
      const check = report.checks.find((candidate) => candidate.name === scenario.checkName);

      assert.equal(report.pass, false);
      assert.equal(check?.pass, false);
      assert.ok(check?.evidenceRef);
      assert.match(c.evidence.getText(check?.evidenceRef as string), /sandbox:enforced/);
      assert.match(c.evidence.getText(check?.evidenceRef as string), /egress-blocked:true/);
    } finally {
      fix.cleanup();
    }
  }
});

test('DoD#3c / REQ-2.8: gate source and golden mutation is discarded from the durable artifact', realMacOSOnly, async () => {
  const fix = makeFixture({
    fullTests: 'printf correct > src/impl.txt; printf tampered > test/golden/expected.txt',
  });
  try {
    const sourceBefore = readFileSync(join(fix.worktree, 'src', 'impl.txt'), 'utf8');
    const goldenBefore = readFileSync(join(fix.worktree, 'test', 'golden', 'expected.txt'), 'utf8');
    const c = buildCore(fix);

    const report = await c.gates.run('T1');

    assert.equal(report.pass, false);
    assert.equal(readFileSync(join(fix.worktree, 'src', 'impl.txt'), 'utf8'), sourceBefore);
    assert.equal(
      readFileSync(join(fix.worktree, 'test', 'golden', 'expected.txt'), 'utf8'),
      goldenBefore,
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#4 — fake-green via golden tampering: every tamper route (edit, delete,
// add) fails T1 with golden_manifest_mismatch (REQ-9.2; scope note REQ-9.3).
// ---------------------------------------------------------------------------
test('DoD#4: golden tampering (edit) is caught by the manifest check at T1', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);

    // Make the target tests legitimately pass first...
    const outLegit = await c.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'a-fix',
        path: 'src/impl.txt',
        contentRef: c.evidence.put('correct\n'),
      },
      'implementer',
    );
    assert.equal(outLegit.status, 'applied');

    // ...then tamper with golden OUT-OF-BAND (direct fs write). In-loop shell
    // tampering is blocked by the sandbox itself (proven in DoD#2c); the
    // manifest check exists for tamper that bypasses the executor entirely —
    // another process, a human, a bug. Detection stays the gate's job.
    writeFileSync(join(fix.worktree, 'test/golden/expected.txt'), 'golden truth\ntampered\n');

    const report = await c.gates.run('T1');
    assert.equal(report.pass, false, 'T1 fails on tampered golden');
    const goldenCheck = report.checks.find((ch) => ch.name === 'golden');
    assert.ok(goldenCheck, 'golden check present in T1');
    assert.equal(goldenCheck?.pass, false, 'golden check failed');
    assert.match(goldenCheck?.detail ?? '', /golden_manifest_mismatch/);
    assert.equal(
      report.gateConfigHash,
      sha256Hex(readFileSync(fix.gateConfigPath)),
      'config hash is the real sha256, not a placeholder (REQ-8.3)',
    );
    assert.match(report.scopeNote, /tamper/i, 'DoD#4 scope note names its tampering-only scope');
  } finally {
    fix.cleanup();
  }
});

test('DoD#4b: golden delete and add routes also fail T1 (set-equality both directions)', async () => {
  // delete a manifest-listed file
  let fix = makeFixture();
  try {
    const c = buildCore(fix);
    await c.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'a-fix',
        path: 'src/impl.txt',
        contentRef: c.evidence.put('correct\n'),
      },
      'implementer',
    );
    unlinkSync(join(fix.worktree, 'test/golden/expected.txt'));
    const report = await c.gates.run('T1');
    assert.equal(report.pass, false, 'deleting a golden file fails T1');
    assert.match(
      report.checks.find((ch) => ch.name === 'golden')?.detail ?? '',
      /golden_manifest_mismatch/,
    );
  } finally {
    fix.cleanup();
  }
  // add an unlisted file
  fix = makeFixture();
  try {
    const c = buildCore(fix);
    await c.executor.execute(
      {
        type: 'WRITE_FILE',
        actionId: 'a-fix',
        path: 'src/impl.txt',
        contentRef: c.evidence.put('correct\n'),
      },
      'implementer',
    );
    writeFileSync(join(fix.worktree, 'test/golden/sneaky.txt'), 'planted\n');
    const report = await c.gates.run('T1');
    assert.equal(report.pass, false, 'adding an unlisted golden file fails T1');
    assert.match(
      report.checks.find((ch) => ch.name === 'golden')?.detail ?? '',
      /golden_manifest_mismatch/,
    );
  } finally {
    fix.cleanup();
  }
});

for (const scenario of [
  { name: 'forged signed verdict', mode: 'forged', why: 'evidence_auth_mismatch', code: 'signature_mismatch' },
  { name: 'missing referenced blob', mode: 'missing', why: 'evidence_auth_unavailable', code: 'evidence_blob_missing' },
  { name: 'tampered referenced blob', mode: 'tampered', why: 'evidence_auth_mismatch', code: 'evidence_hash_mismatch' },
] as const) {
  test(`REQ-4.9-4.13 fault injection: ${scenario.name} cannot advance state`, async () => {
    const fix = makeFixture();
    try {
      const c = buildCore(fix);
      const gates: GateRunner = {
        async run(tier) {
          const report = await c.gates.run(tier);
          if (tier !== 'T1') return report;
          if (scenario.mode === 'forged') return { ...report, pass: false };
          const ref = report.checks[0]?.evidenceRef;
          assert.ok(ref, 'T1 report carries evidence to inject against');
          const path = join(fix.evidenceDir, ref.slice('blob://'.length));
          if (scenario.mode === 'missing') unlinkSync(path);
          else writeFileSync(path, 'tampered after signed publication\n');
          return report;
        },
        verify(report) {
          return c.gates.verify(report);
        },
      };

      const result = await loopFor(c, honestSource(c), undefined, gates);

      assert.equal(result.finalState, 'ESCALATED');
      const states = taskStates(c.log);
      assert.ok(!states.includes('PASSED'));
      assert.ok(!states.includes('REVIEWING'));
      assert.ok(!states.includes('COMPLETED'));
      const escalated = c.log.all({ type: 'ESCALATED' }).at(-1);
      assert.equal(escalated?.payload['why'], scenario.why);
      assert.equal(escalated?.payload['boundary'], 'state_advancement');
      assert.equal(escalated?.payload['code'], scenario.code);
    } finally {
      fix.cleanup();
    }
  });
}

test('REQ-4.12/5.5 fault injection: T0 evidence authentication failure fails closed before T1', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    let t1Calls = 0;
    const gates: GateRunner = {
      async run(tier) {
        if (tier === 'T1') t1Calls += 1;
        return c.gates.run(tier);
      },
      verify(report) {
        if (report.tier === 'T0') {
          throw new ReportIntegrityError('signature_mismatch', 'injected T0 evidence-auth failure');
        }
        return c.gates.verify(report);
      },
    };

    const result = await loopFor(c, honestSource(c), undefined, gates);

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(t1Calls, 0, 'T1 is unreachable after T0 authentication failure');
    const states = taskStates(c.log);
    assert.ok(!states.includes('PASSED'));
    assert.ok(!states.includes('REVIEWING'));
    assert.ok(!states.includes('COMPLETED'));
    const escalated = c.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalated?.payload['why'], 'evidence_auth_mismatch');
    assert.equal(escalated?.payload['boundary'], 'state_advancement');
    assert.equal(escalated?.payload['code'], 'signature_mismatch');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#5 — flaky test: fail-then-pass on retry is flagged flaky_suspect for a
// human; never silently passed, never auto-quarantined (REQ-8.5, INV-16).
// The retry must REALLY happen (run count proven), and a deterministic failure
// must NOT be labeled flaky (control).
// ---------------------------------------------------------------------------
test('DoD#5: flaky test -> real retry, flagged, no silent pass, no auto-quarantine', async () => {
  const fix = makeFixture();
  try {
    installFlakyTests(fix);
    const c = buildCore(fix);
    const report = await c.gates.run('T1');

    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.ok(fullTests, 'fullTests check present');
    const evidence = c.evidence.getText(fullTests?.evidenceRef as string);
    assert.equal(
      evidence.match(/^GATE_RUN$/gm)?.length,
      2,
      'core-captured evidence proves the suite ran exactly twice',
    );
    assert.equal(existsSync(join(fix.worktree, '.runs')), false, 'retry markers stay disposable');
    assert.equal(fullTests?.flakySuspect, true, 'flagged flaky_suspect');
    assert.equal(report.pass, false, 'flaky result does not silently pass');
    assert.equal(
      c.log.all({ type: 'GOVERNANCE_CHANGE' }).length,
      0,
      'no auto-quarantine (governance untouched — INV-16)',
    );
    const gateEvents = c.log.all({ type: 'GATE_RESULT' });
    assert.ok(
      gateEvents.some((e) => JSON.stringify(e.payload).includes('flaky')),
      'flaky flag visible for a human in the event log',
    );
  } finally {
    fix.cleanup();
  }
});

test('DoD#5b (control): deterministic failure is NOT labeled flaky', async () => {
  const fix = makeFixture();
  try {
    installAlwaysFailTests(fix);
    const c = buildCore(fix);
    const report = await c.gates.run('T1');
    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.equal(fullTests?.pass, false);
    assert.ok(!fullTests?.flakySuspect, 'stable failure carries no flaky label');
    const evidence = c.evidence.getText(fullTests?.evidenceRef as string);
    assert.equal(
      evidence.match(/^GATE_RUN$/gm)?.length,
      2,
      'retry attempted once, then reported as a real failure',
    );
    assert.equal(existsSync(join(fix.worktree, '.runs')), false, 'failed gate leaves no marker');
    assert.equal(
      fullTests?.command,
      'sh run-tests.sh',
      'GateCheck.command carries the resolved command, not the retry wrapper (AC-2)',
    );
    assert.equal(
      fullTests?.outputTail?.match(/^GATE_RUN$/gm)?.length,
      2,
      'GateCheck.outputTail surfaces the real captured output, not just "exit 1" (AC-1)',
    );
  } finally {
    fix.cleanup();
  }
});

test('DoD#5c: silent command failure -> outputTail empty, command still captured (AC-4)', async () => {
  const fix = makeFixture();
  try {
    // Default fixture run-tests.sh is `grep -q correct src/impl.txt`, which is
    // POSIX-silent on both stdout and stderr regardless of match, and impl.txt
    // does not yet contain "correct" — a naturally silent, deterministic failure.
    const c = buildCore(fix);
    const report = await c.gates.run('T1');
    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.equal(fullTests?.pass, false);
    assert.equal(
      fullTests?.command,
      'sh run-tests.sh',
      'command is still captured even when the command is silent (AC-2/AC-4)',
    );
    assert.equal(fullTests?.outputTail, '', 'a silent command yields an empty outputTail, no error (AC-4)');
  } finally {
    fix.cleanup();
  }
});

test('DoD#5d: outputTail carrying a secret shape is omitted entirely, never redacted-and-sent (GOVERN)', async () => {
  // Runtime-assembled so the repo's own secret guard finds no contiguous token in this file's bytes.
  const fakeToken = 'ghp'.concat('_', 'abcdefghijklmnopqrstuvwxyz1234');
  const fix = makeFixture({
    fullTests: `echo "token=${fakeToken}"; exit 1`,
  });
  try {
    const c = buildCore(fix);
    const report = await c.gates.run('T1');
    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.equal(fullTests?.pass, false);
    assert.equal(
      fullTests?.command,
      `echo "token=${fakeToken}"; exit 1`,
      'command is still populated on a secret hit',
    );
    assert.ok(fullTests?.detail, 'detail is still populated on a secret hit');
    assert.ok(fullTests?.evidenceRef, 'evidenceRef is still populated on a secret hit');
    assert.equal(
      fullTests?.outputTail,
      undefined,
      'outputTail is omitted entirely when the captured output matches a secret shape',
    );
  } finally {
    fix.cleanup();
  }
});

test('DoD#5e: flaky_suspect check also carries command/outputTail, same fields as a stable failure', async () => {
  const fix = makeFixture();
  try {
    installFlakyTests(fix);
    const c = buildCore(fix);
    const report = await c.gates.run('T1');
    const fullTests = report.checks.find((ch) => ch.name === 'fullTests');
    assert.equal(fullTests?.flakySuspect, true);
    assert.equal(
      fullTests?.command,
      'sh run-tests.sh',
      'flaky_suspect is a gate-command failure too (exit 79) and carries the resolved command (AC-2)',
    );
    assert.ok(
      fullTests?.outputTail?.match(/^GATE_RUN$/gm)?.length,
      'flaky_suspect still carries captured output, not zero-signal (AC-1)',
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#6 — crash between INTENT and APPLIED: recovery is rollback-then-rerun and
// even a NON-IDEMPOTENT command's effect appears exactly once (REQ-6.1/6.2).
// Includes: effect proven applied BEFORE the crash (blind replay would double),
// snapshotRef resolvable, garbage from a partial apply cleaned, and recovery
// itself idempotent (crash-during-recovery story).
// ---------------------------------------------------------------------------
test('DoD#6: crash after apply, before APPLIED event -> recovery yields exactly-once', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterApply: true });
    const append: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-append',
      cmd: 'echo line >> src/notes.txt',
      network: 'none',
    };
    await assert.rejects(crashing.executor.execute(append, 'implementer'), CrashInjected);

    // The effect WAS applied before the crash — this is what makes blind
    // re-execution a double-apply and forces rollback-then-rerun.
    assert.equal(
      readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8'),
      'line\n',
      'effect applied before crash',
    );
    const intents = crashing.log.all({ type: 'ACTION_INTENT' });
    assert.equal(intents.length, 1, 'INTENT recorded');
    const snapshotRef = String(intents[0]?.payload['snapshotRef']);
    assert.ok(snapshotRef.length >= 7, 'INTENT carries a snapshot ref');
    assert.equal(
      git(fix.worktree, 'cat-file', '-t', snapshotRef).trim(),
      'commit',
      'snapshot ref resolves to a real commit in the worktree',
    );
    assert.equal(crashing.log.all({ type: 'ACTION_APPLIED' }).length, 0, 'no APPLIED yet');

    // Fresh process after the crash: recover, then verify exactly-once.
    const recovered = buildCore(fix, clock);
    const report = await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });
    assert.equal(report.action, 'replayed_intent');
    assert.equal(
      readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8'),
      'line\n',
      'non-idempotent effect appears EXACTLY once',
    );
    const applieds = recovered.log.all({ type: 'ACTION_APPLIED' });
    assert.equal(applieds.length, 1, 'APPLIED reconciled');
    assert.equal(applieds[0]?.payload['actionId'], 'a-append');

    // Recovery is idempotent: running it again changes nothing.
    const second = await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });
    assert.equal(second.action, 'none', 'second recovery is a no-op');
    assert.equal(readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8'), 'line\n');
    assert.equal(recovered.log.all({ type: 'ACTION_APPLIED' }).length, 1);
  } finally {
    fix.cleanup();
  }
});

test('DoD#6b: crash after INTENT (partial apply garbage) -> rollback cleans, rerun applies once', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterIntent: true });
    const append: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-append2',
      cmd: 'echo line >> src/notes.txt',
      network: 'none',
    };
    await assert.rejects(crashing.executor.execute(append, 'implementer'), CrashInjected);
    assert.ok(!existsSync(join(fix.worktree, 'src/notes.txt')), 'nothing applied before crash');
    // Simulate a HALF-APPLIED action: garbage landed before the process died.
    writeFileSync(join(fix.worktree, 'src/notes.txt'), 'garbage-from-partial-apply\n');

    const recovered = buildCore(fix, clock);
    const report = await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });
    assert.equal(report.action, 'replayed_intent');
    assert.equal(
      readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8'),
      'line\n',
      'rollback removed the garbage BEFORE rerun — effect exactly once, no residue',
    );
    const applieds = recovered.log.all({ type: 'ACTION_APPLIED' });
    assert.equal(applieds.length, 1, 'APPLIED written by recovery');
    assert.equal(applieds[0]?.payload['actionId'], 'a-append2');
  } finally {
    fix.cleanup();
  }
});

test('DoD#6c/REQ-3.7: a later accepted patch cannot bury an earlier dangling generation', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterApply: true });
    const actionA: Action = {
      type: 'APPLY_PATCH',
      actionId: 'wired-dangling-a',
      diffRef: crashing.evidence.put(
        [
          'diff --git a/src/impl.txt b/src/impl.txt',
          '--- a/src/impl.txt',
          '+++ b/src/impl.txt',
          '@@ -1 +1 @@',
          '-wrong',
          '+correct',
          '',
        ].join('\n'),
      ),
    };
    await assert.rejects(
      crashing.executor.execute(actionA, 'implementer'),
      CrashInjected,
    );

    const restarted = buildCore(fix, clock);
    const actionB: Action = {
      type: 'APPLY_PATCH',
      actionId: 'wired-later-b',
      diffRef: restarted.evidence.put(
        [
          'diff --git a/src/later.txt b/src/later.txt',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/src/later.txt',
          '@@ -0,0 +1 @@',
          '+later',
          '',
        ].join('\n'),
      ),
    };
    assert.equal(
      (await restarted.executor.execute(actionB, 'implementer')).status,
      'applied',
    );

    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
    assert.equal(readFileSync(join(fix.worktree, 'src/later.txt'), 'utf8'), 'later\n');
    const intents = restarted.log.all({ type: 'ACTION_INTENT' });
    const causalApplied = restarted.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['duplicate'] !== true);
    assert.deepEqual(
      causalApplied.map((event) => event.payload['intentSeq']),
      intents.map((event) => event.seq),
      'admission recovery terminates A before B can append a new intent',
    );
    assert.equal(
      causalApplied[0]?.payload['recovered'],
      true,
      'the buried boundary is reconstructed by recovery',
    );
    const beforeRestart = restarted.log.all().length;
    assert.equal(
      (
        await recoverWorktree({
          worktreeDir: fix.worktree,
          runId: RUN_ID,
          taskId: TASK_ID,
          log: restarted.log,
          evidence: restarted.evidence,
          policy: restarted.policy,
          sandbox: restarted.sandbox,
          clock,
        })
      ).action,
      'none',
    );
    assert.equal(restarted.log.all().length, beforeRestart);
  } finally {
    fix.cleanup();
  }
});

test('REQ-3.7/3.8: crashed APPLY_PATCH recovers once and later duplicate skips', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const crashing = buildCore(fix, clock, { crashAfterApply: true });
    const diffRef = crashing.evidence.put(
      [
        'diff --git a/src/impl.txt b/src/impl.txt',
        '--- a/src/impl.txt',
        '+++ b/src/impl.txt',
        '@@ -1 +1 @@',
        '-wrong',
        '+correct',
        '',
      ].join('\n'),
    );
    const action: Action = {
      type: 'APPLY_PATCH',
      actionId: 'a-patch-recovery',
      diffRef,
    };

    await assert.rejects(
      crashing.executor.execute(action, 'implementer'),
      CrashInjected,
    );
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
    assert.equal(crashing.log.all({ type: 'ACTION_APPLIED' }).length, 0);

    const recovered = buildCore(fix, clock);
    const report = await recoverWorktree({
      worktreeDir: fix.worktree,
      runId: RUN_ID,
      taskId: TASK_ID,
      log: recovered.log,
      evidence: recovered.evidence,
      policy: recovered.policy,
      sandbox: recovered.sandbox,
      clock,
    });

    assert.equal(report.action, 'replayed_intent');
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
    assert.equal(
      (await recovered.executor.execute(action, 'implementer')).status,
      'skipped_duplicate',
    );
    const events = recovered.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((event) => event.payload['actionId'] === action.actionId);
    assert.equal(events.filter((event) => event.payload['duplicate'] !== true).length, 1);
    assert.equal(events.filter((event) => event.payload['duplicate'] === true).length, 1);
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#7 — duplicate actionId is an idempotent skip (REQ-6.3): proven with a
// NON-idempotent command (re-applying would visibly double) and across a
// process restart (the real-world context where duplicates arrive).
// ---------------------------------------------------------------------------
test('DoD#7: duplicate actionId -> idempotent skip, applied exactly once', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = buildCore(fix, clock);
    const ref = c.evidence.put('hello\n');
    const action: Action = {
      type: 'WRITE_FILE',
      actionId: 'a-dup',
      path: 'src/hello.txt',
      contentRef: ref,
    };
    const first = await c.executor.execute(action, 'implementer');
    assert.equal(first.status, 'applied');
    const second = await c.executor.execute(action, 'implementer');
    assert.equal(second.status, 'skipped_duplicate');
    assert.equal(readFileSync(join(fix.worktree, 'src/hello.txt'), 'utf8'), 'hello\n');

    // Across a process restart: a NEW executor over the SAME log must still skip.
    const restarted = buildCore(fix, clock);
    const third = await restarted.executor.execute(action, 'implementer');
    assert.equal(third.status, 'skipped_duplicate', 'dedupe survives restart (log, not memory)');

    const appliedEvents = restarted.log
      .all({ type: 'ACTION_APPLIED' })
      .filter((e) => e.payload['actionId'] === 'a-dup');
    assert.equal(
      appliedEvents.filter((e) => e.payload['duplicate'] !== true).length,
      1,
      'exactly one real application',
    );
  } finally {
    fix.cleanup();
  }
});

test('REQ-3.9/3.10/3.11: READ_FILE is evidence-backed, intent-free, and contained', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const outcome = await c.executor.execute(
      { type: 'READ_FILE', actionId: 'a-read', path: 'src/impl.txt' },
      'diagnostician',
    );
    assert.equal(outcome.status, 'applied');
    assert.ok(outcome.status === 'applied' && outcome.outputRef);
    if (outcome.status === 'applied' && outcome.outputRef !== undefined) {
      assert.equal(c.evidence.getText(outcome.outputRef), 'wrong\n');
    }
    assert.deepEqual(
      c.log.all({ taskId: TASK_ID }).map((event) => event.type),
      ['ACTION_APPLIED'],
    );

    const rejected = await c.executor.execute(
      { type: 'READ_FILE', actionId: 'a-read-escape', path: '../outside.txt' },
      'diagnostician',
    );
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') {
      assert.equal(rejected.rejection.reason, 'path_outside_allowlist');
    }
    assert.equal(c.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    fix.cleanup();
  }
});

// backlog: rejected-feedback (AC-3) — a missing-file READ_FILE used to reject with
// zero hint about what actually exists; the model burned 4/10 live iterations
// re-guessing paths blind. The detail now carries a bounded, deterministically
// sorted listing of the real paths the executor sees.
test('REQ-5.4: READ_FILE-not-found carries a bounded, deterministic available-paths hint', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const rejected = await c.executor.execute(
      { type: 'READ_FILE', actionId: 'a-read-missing', path: 'src/missing.txt' },
      'implementer',
    );
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') {
      assert.equal(rejected.rejection.reason, 'schema_violation');
      const [message, listPart] = rejected.rejection.detail.split(' | available: ');
      assert.equal(message, 'file not found: src/missing.txt');
      assert.deepEqual(
        listPart?.split(', '),
        [
          'gate-ladder.json',
          'run-tests.sh',
          'src/impl.txt',
          'test/ai-generated/.gitkeep',
          'test/golden/_MANIFEST.sha256',
          'test/golden/expected.txt',
        ],
        'real, sorted paths — no .git internals',
      );
    }
    assert.equal(c.log.all({ type: 'ACTION_INTENT' }).length, 0);
  } finally {
    fix.cleanup();
  }
});

// backlog: rejected-feedback (nit) — the catch around the descriptor-safe read
// used to swallow every failure as "file not found", so a path that exists but
// can't be read as a regular file (permission denied, spawn failure, ...) got
// the same misleading label plus an available-paths listing that contradicted
// it (the path was right there in the listing). A directory target hits the
// same non-ENOENT branch deterministically without needing chmod/spawn tricks.
test('REQ-5.4: READ_FILE non-ENOENT failure is not mislabeled as file-not-found', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const rejected = await c.executor.execute(
      { type: 'READ_FILE', actionId: 'a-read-dir', path: 'src' },
      'implementer',
    );
    assert.equal(rejected.status, 'rejected');
    if (rejected.status === 'rejected') {
      assert.equal(rejected.rejection.reason, 'schema_violation');
      assert.ok(
        rejected.rejection.detail.startsWith('read failed: '),
        `expected a "read failed:" label, got: ${rejected.rejection.detail}`,
      );
      assert.ok(
        !rejected.rejection.detail.includes('file not found'),
        'a real (non-missing) path must not be mislabeled as file-not-found',
      );
      assert.ok(
        !rejected.rejection.detail.includes(' | available: '),
        'available-paths hint is ENOENT-only — attaching it here would contradict the failure',
      );
    }
  } finally {
    fix.cleanup();
  }
});

test('DoD#7b: duplicate NON-idempotent RUN_COMMAND does not re-run', async () => {
  const fix = makeFixture();
  try {
    const c = buildCore(fix);
    const action: Action = {
      type: 'RUN_COMMAND',
      actionId: 'a-dup-cmd',
      cmd: 'echo line >> src/notes.txt',
      network: 'none',
    };
    const first = await c.executor.execute(action, 'implementer');
    assert.equal(first.status, 'applied');
    const second = await c.executor.execute(action, 'implementer');
    assert.equal(second.status, 'skipped_duplicate');
    assert.equal(
      readFileSync(join(fix.worktree, 'src/notes.txt'), 'utf8'),
      'line\n',
      'a re-applied duplicate would read line\\nline\\n — it must not',
    );
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#8 — lease contention: CAS admits exactly one writer; the loser executes
// nothing; TTL boundary is pinned; expiry frees the lease (REQ-5.1/5.2/5.3);
// and the race holds across two REAL processes hitting the same database.
// ---------------------------------------------------------------------------
test('DoD#8: two claimants, one lease — single writer enforced by CAS', () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const a = createLeaseManager(fix.dbPath, clock, 'RUN-A');
    const b = createLeaseManager(fix.dbPath, clock, 'RUN-B');

    assert.equal(a.claim(TASK_ID, 'owner-a', 60_000), true, 'first claim wins');
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), false, 'second claim denied (CAS=0 rows)');

    let claimed = log.all({ type: 'LEASE_CLAIMED' });
    assert.equal(claimed.length, 1, 'exactly one LEASE_CLAIMED event');
    assert.equal(claimed[0]?.payload['ownerId'], 'owner-a');

    // TTL boundary pinned: held strictly until now > leaseUntil.
    clock.tick(59_999);
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), false, '1ms before expiry: still held');
    clock.tick(1); // now == leaseUntil
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), false, 'at exact expiry instant: still held');
    clock.tick(1); // now > leaseUntil
    assert.equal(b.claim(TASK_ID, 'owner-b', 60_000), true, 'past expiry: claimable');
    claimed = log.all({ type: 'LEASE_CLAIMED' });
    assert.equal(claimed.length, 2, 'second claim logged after expiry');

    a.close();
    b.close();
    log.close();
  } finally {
    fix.cleanup();
  }
});

test('DoD#8b: cross-process race — two real processes, one winner per round', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const leaseUrl = pathToFileURL(join(import.meta.dirname, '../src/state/lease.ts')).href;
    const childScript = join(fix.root, 'claim-child.ts');
    writeFileSync(
      childScript,
      `import { createLeaseManager } from '${leaseUrl}';\n` +
        `const [dbPath, owner, taskId] = process.argv.slice(2) as [string, string, string];\n` +
        `const lm = createLeaseManager(dbPath, { now: () => 1_000_000 }, 'RUN-' + owner);\n` +
        `process.stdout.write(lm.claim(taskId, owner, 60_000) ? 'WON' : 'LOST');\n` +
        `lm.close();\n`,
    );

    for (let round = 0; round < 5; round += 1) {
      const taskId = `T-race-${round}`;
      const [p1, p2] = await Promise.all([
        execFileAsync(process.execPath, [childScript, fix.dbPath, 'owner-1', taskId]),
        execFileAsync(process.execPath, [childScript, fix.dbPath, 'owner-2', taskId]),
      ]);
      const results = [p1.stdout.trim(), p2.stdout.trim()].sort();
      assert.deepEqual(results, ['LOST', 'WON'], `round ${round}: exactly one winner`);
      const claimedForTask = log
        .all({ type: 'LEASE_CLAIMED' })
        .filter((e) => e.payload['taskId'] === taskId);
      assert.equal(claimedForTask.length, 1, `round ${round}: exactly one LEASE_CLAIMED event`);
    }
    log.close();
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#9 — budget exhaustion halts the loop provably: ESCALATED, no further
// proposals (REQ-10.1/10.2).
// ---------------------------------------------------------------------------
test('DoD#9: exceeding the iteration budget -> BUDGET_EXCEEDED + ESCALATED, loop halts', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const c = buildCore(fix, clock);
    let proposeCalls = 0;
    const spinner: ProposalSource = {
      async propose(): Promise<Proposal> {
        proposeCalls += 1;
        // Keep T0 green so this scenario reaches the independent iteration cap;
        // a failing T0 is intentionally consumed by the deterministic diagnosis
        // path before the budget backstop can be exercised.
        if (proposeCalls === 1) {
          return {
            claim: 'WORKING',
            actions: [{
              type: 'WRITE_FILE',
              actionId: 'budget-seed',
              path: 'src/impl.txt',
              contentRef: c.evidence.put('correct\n'),
            }],
            costUnits: 10,
          };
        }
        return { claim: 'WORKING', actions: [], costUnits: 10 };
      },
    };
    const result = await loopFor(c, spinner, createBudget({ ...DEFAULT_LIMITS, maxIterations: 3 }, clock));

    assert.equal(result.finalState, 'ESCALATED');
    assert.equal(proposeCalls, 3, 'not one proposal past the budget');
    assert.ok(c.log.all({ type: 'BUDGET_EXCEEDED' }).length >= 1, 'BUDGET_EXCEEDED logged');
    assert.equal(c.log.all({ type: 'BUDGET_EXCEEDED' }).at(-1)?.payload['limit'], 'iterations');
    assert.ok(taskStates(c.log).includes('ESCALATED'), 'ESCALATED transition logged');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// DoD#10 (Phase 2) — auto_approved / merge / COMPLETED are unreachable through
// ports (REQ-7.3, REQ-8.5, INV-2). The auto-merge chain fires ONLY from the
// core/merge policy (runAutoMerge), which no ProposalClaim can invoke. Across the
// whole claim space — honest-green, lying, blocking — the loop must never advance
// a task past REVIEWING or emit an AUTO_APPROVED event. Phase-2 wiring of
// runAutoMerge into the supervised loop is a later task; this pins the invariant
// that the doorway (ProposalSource) has no path to those triggers.
// ---------------------------------------------------------------------------
test('DoD#10: no ProposalClaim reaches auto_approved / merge_queued / COMPLETED (REQ-7.3, INV-2)', async () => {
  const honest: ProposalSource = {
    async propose(input: ProposalInput): Promise<Proposal> {
      if (input.state === 'IMPLEMENTING') {
        return {
          claim: 'READY_FOR_VERIFICATION',
          actions: [
            { type: 'WRITE_FILE', actionId: 'a-ok', path: 'src/impl.txt', contentRef: '' },
          ],
          costUnits: 1,
        };
      }
      return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
    },
  };
  const liar: ProposalSource = {
    async propose(): Promise<Proposal> {
      return { claim: 'READY_FOR_VERIFICATION', actions: [], costUnits: 1 };
    },
  };
  const blocker: ProposalSource = {
    async propose(): Promise<Proposal> {
      return { claim: 'BLOCKED', actions: [], costUnits: 1 };
    },
  };
  const forbidden = ['APPROVED', 'MERGE_QUEUED', 'AUDITED', 'COMPLETED'];

  for (const src of [honest, liar, blocker]) {
    const fix = makeFixture();
    try {
      const clock = makeClock();
      const c = buildCore(fix, clock);
      // The honest source's WRITE needs a real contentRef in this store.
      const wired: ProposalSource =
        src === honest
          ? {
              async propose(input) {
                const p = await honest.propose(input);
                for (const a of p.actions) if (a.type === 'WRITE_FILE') a.contentRef = c.evidence.put('correct\n');
                return p;
              },
            }
          : src;
      await loopFor(c, wired, createBudget({ ...DEFAULT_LIMITS, maxIterations: 3 }, clock));

      const st = taskStates(c.log);
      for (const state of forbidden) {
        assert.ok(!st.includes(state), `claim path must never reach ${state} (INV-2)`);
      }
      assert.equal(
        c.log.all({ type: 'AUTO_APPROVED' }).length,
        0,
        'no claim fires the core-only auto_approved policy decision (REQ-7.3)',
      );
    } finally {
      fix.cleanup();
    }
  }
});
