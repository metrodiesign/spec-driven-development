// GateReport must bind to the TESTED tree, not just HEAD: gates run against a
// dirty worktree mid-loop (WRITE_FILE stages files without committing), so a
// report whose only tree binding is `git rev-parse HEAD` would name code that
// cannot reproduce the pass (REQ-4.2). The report therefore also carries
// worktreeHash — the git tree hash of the tracked+untracked content the gate
// actually ran on.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createCoreCommandExecutor } from '../executor/command-executor.ts';
import { createDefaultPathPolicy } from '../executor/path-policy.ts';
import { createCommandRunner } from '../security/command-runner.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import { createGateRunner } from './runner.ts';
import { openEventLog } from '../state/event-log.ts';
import { git, makeClock, makeFixture, makeReportIntegrity } from '../../test/helpers/fixture.ts';

test('GateReport.worktreeHash binds the tested (dirty) tree; commitHash alone cannot', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const gates = createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: 'RUN-1',
      taskId: 'T-1',
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
    });

    const before = await gates.run('T0');

    // Dirty the tree WITHOUT committing — exactly what a WRITE_FILE action does.
    writeFileSync(join(fix.worktree, 'src', 'impl.txt'), 'correct\n');
    const after = await gates.run('T0');

    assert.equal(
      after.commitHash,
      before.commitHash,
      'HEAD did not move — commitHash cannot distinguish the two tested trees',
    );
    assert.match(
      String(before.worktreeHash ?? ''),
      /^[0-9a-f]{40}$/,
      'report carries a real git tree hash',
    );
    assert.notEqual(
      after.worktreeHash,
      before.worktreeHash,
      'worktreeHash reflects the tree the gate actually ran on',
    );

    // Independently recompute: the report hash IS the tree hash of the dirty tree.
    git(fix.worktree, 'add', '-A');
    const expected = git(fix.worktree, 'write-tree').trim();
    assert.equal(
      after.worktreeHash,
      expected,
      'worktreeHash = git write-tree over tracked+untracked content',
    );
  } finally {
    fix.cleanup();
  }
});

function runnerFor(fix: ReturnType<typeof makeFixture>, clock: ReturnType<typeof makeClock>) {
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const passthrough: SandboxWrap = {
    kind: 'available',
    wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
  };
  return createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence),
    clock,
    commandExecutor: createCoreCommandExecutor({
      evidence,
      policy: createDefaultPathPolicy(),
      sandbox: passthrough,
      commandRunner: createCommandRunner({ sandbox: passthrough, evidence }),
    }),
  });
}

interface InjectedCommand {
  command: string;
  workspaceRoot: string;
  cwd: string;
  writableRoots: string[];
  protectedRoots: string[];
  allowNetwork: boolean;
  timeoutMs: number;
}

interface InjectedCommandRunner {
  run(input: InjectedCommand): Promise<
    | {
        status: 'completed';
        exitCode: number;
        evidenceRef: string;
        egressBlocked: boolean;
      }
    | {
        status: 'rejected';
        reason: 'sandbox_unavailable' | 'sandbox_violation';
        detail: string;
        evidenceRef: string;
        exitCode: number;
        egressBlocked: boolean;
        observedViolation?: {
          source: 'enforcement_owned_direct' | 'backend_owned';
          operation: 'filesystem' | 'network';
        };
      }
  >;
}

function runnerWithInjectedCommand(
  fix: ReturnType<typeof makeFixture>,
  commandRunner: InjectedCommandRunner,
) {
  const clock = makeClock();
  const log = openEventLog(fix.dbPath, clock);
  const evidence = createEvidenceStore(fix.evidenceDir);
  const options = {
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence),
    clock,
    commandExecutor: createCoreCommandExecutor({
      evidence,
      policy: createDefaultPathPolicy(),
      sandbox: {
        kind: 'available',
        wrap: ({ shellCmd }: { shellCmd: string }) => ({
          cmd: '/bin/sh',
          args: ['-c', shellCmd],
        }),
      },
      commandRunner,
    }),
  };
  return { gates: createGateRunner(options), evidence };
}

test('REQ-2.1/2.2/2.11/2.29: T1 raw-IP egress keeps typed policy and backend evidence', async () => {
  const fix = makeFixture({ fullTests: '/usr/bin/nc -z -G 3 -w 3 1.1.1.1 443' });
  try {
    let calls = 0;
    const evidence = createEvidenceStore(fix.evidenceDir);
    const denialRef = evidence.put('sandbox:enforced\negress-blocked:true\nexit:1\n');
    const commandRunner: InjectedCommandRunner = {
      async run(input) {
        calls += 1;
        assert.equal(input.allowNetwork, false);
        return {
          status: 'rejected',
          reason: 'sandbox_violation',
          detail: 'network denied by enforcing sandbox',
          evidenceRef: denialRef,
          exitCode: 1,
          egressBlocked: true,
          observedViolation: {
            source: 'backend_owned',
            operation: 'network',
          },
        };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(calls, 1, 'one high-level gate lifecycle owns both shell attempts');
    assert.equal(report.pass, false);
    const fullTests = report.checks.find((check) => check.name === 'fullTests');
    assert.equal(fullTests?.pass, false);
    assert.ok(fullTests?.evidenceRef);
    const captured = evidence.getText(fullTests?.evidenceRef as string);
    assert.equal(captured.match(/egress-blocked:true/g)?.length, 1);
    assert.match(captured, /"networkPolicyHash":"[0-9a-f]{64}"/);
    assert.match(captured, /"denialObservation":"direct_only"/);
    assert.match(captured, /"revocableDescendantContainment":false/);
    assert.match(captured, /"descendantTermination":"unproven_new_session"/);
    assert.match(
      captured,
      /"observedViolation":\{"source":"backend_owned","operation":"network"\}/,
    );
  } finally {
    fix.cleanup();
  }
});

test('gate retry wrapper preserves a configured command ending in a shell comment', async () => {
  const fix = makeFixture({ fullTests: 'true # trusted configuration comment' });
  try {
    const report = await runnerFor(fix, makeClock()).run('T1');

    assert.equal(report.pass, true);
    assert.equal(report.checks.find((check) => check.name === 'fullTests')?.pass, true);
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.8/2.9/2.12: gate mutation is disposable and receives frozen golden protection', async () => {
  const fix = makeFixture({ fullTests: 'printf changed > src/impl.txt; printf tampered > test/golden/expected.txt' });
  try {
    const originalSource = readFileSync(join(fix.worktree, 'src', 'impl.txt'), 'utf8');
    const originalGolden = readFileSync(join(fix.worktree, 'test', 'golden', 'expected.txt'), 'utf8');
    const evidence = createEvidenceStore(fix.evidenceDir);
    const denialRef = evidence.put('sandbox:enforced\nfilesystem-write-denied:true\nexit:1\n');
    const seenRoots: string[] = [];
    const commandRunner: InjectedCommandRunner = {
      async run(input) {
        seenRoots.push(input.workspaceRoot);
        assert.notEqual(input.workspaceRoot, fix.worktree, 'the command never receives the durable tree');
        if (seenRoots.length === 1) {
          assert.equal(readFileSync(join(input.workspaceRoot, 'src', 'impl.txt'), 'utf8'), originalSource);
        }
        assert.deepEqual(input.writableRoots, ['.']);
        assert.deepEqual(input.protectedRoots, ['test/golden']);
        writeFileSync(join(input.workspaceRoot, 'src', 'impl.txt'), 'changed\n');
        return {
          status: 'rejected',
          reason: 'sandbox_violation',
          detail: 'golden write denied',
          evidenceRef: denialRef,
          exitCode: 1,
          egressBlocked: true,
          observedViolation: {
            source: 'backend_owned',
            operation: 'filesystem',
          },
        };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(report.pass, false);
    assert.equal(seenRoots.length, 1, 'one high-level lifecycle owns the retry shell');
    assert.ok(seenRoots.every((root) => root !== fix.worktree));
    assert.ok(seenRoots.every((root) => !existsSync(root)), 'every disposable checkout is discarded');
    assert.equal(readFileSync(join(fix.worktree, 'src', 'impl.txt'), 'utf8'), originalSource);
    assert.equal(readFileSync(join(fix.worktree, 'test', 'golden', 'expected.txt'), 'utf8'), originalGolden);
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.7: gate fails closed when the injected sandbox boundary is unavailable', async () => {
  const fix = makeFixture();
  try {
    const evidence = createEvidenceStore(fix.evidenceDir);
    const unavailableRef = evidence.put('sandbox:unavailable\nexit:not-run\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        return {
          status: 'rejected',
          reason: 'sandbox_unavailable',
          detail: 'no enforcing sandbox',
          evidenceRef: unavailableRef,
          exitCode: -1,
          egressBlocked: true,
        };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T0');

    assert.equal(report.pass, false);
    assert.ok(report.checks.length > 0);
    assert.ok(report.checks.every((check) => check.pass === false));
    assert.ok(
      report.checks.every((check) =>
        check.evidenceRef === unavailableRef,
      ),
    );
    assert.ok(report.checks.every((check) => /sandbox_unavailable/.test(check.detail ?? '')));
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.10: empty T0 and T1 configurations report explicit non-vacuous failures', async () => {
  for (const tier of ['T0', 'T1'] as const) {
    const fix = makeFixture();
    try {
      writeFileSync(fix.gateConfigPath, JSON.stringify({ t0: {}, t1: {} }));
      const report = await runnerFor(fix, makeClock()).run(tier);
      assert.equal(report.pass, false, `${tier} cannot pass with zero required checks`);
      assert.deepEqual(report.checks.map((check) => check.name), ['config']);
      assert.match(report.checks[0]?.detail ?? '', /missing|required|empty/i);
    } finally {
      fix.cleanup();
    }
  }
});

test('REQ-2.10: malformed Phase 0 configuration becomes a failing report instead of throwing', async () => {
  const fix = makeFixture();
  try {
    writeFileSync(fix.gateConfigPath, '{"t0":');
    let gates: ReturnType<typeof createGateRunner> | undefined;
    assert.doesNotThrow(() => {
      gates = runnerFor(fix, makeClock());
    });
    const report = await gates?.run('T0');
    assert.equal(report?.pass, false);
    assert.deepEqual(report?.checks.map((check) => check.name), ['config']);
    assert.match(report?.checks[0]?.detail ?? '', /malformed|parse|json/i);
  } finally {
    fix.cleanup();
  }
});

function setT2(fix: ReturnType<typeof makeFixture>, t2: Record<string, unknown>): void {
  const ladder = JSON.parse(readFileSync(fix.gateConfigPath, 'utf8')) as Record<string, unknown>;
  ladder['t2'] = t2;
  writeFileSync(fix.gateConfigPath, JSON.stringify(ladder));
}

test('T2 {status} config stays not_enabled — the explicit stub (REQ-12.1)', async () => {
  const fix = makeFixture();
  try {
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, 'not_enabled');
    assert.deepEqual(report.checks, []);
  } finally {
    fix.cleanup();
  }
});

test('T3 Phase-0 stub is explicit and core-logged with the ladder hash', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const gates = createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: 'RUN-1',
      taskId: 'T-1',
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
    });

    const report = await gates.run('T3');

    assert.equal(report.pass, 'not_enabled');
    assert.deepEqual(report.checks, []);
    const events = log.all({ type: 'GATE_RESULT' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload['tier'], 'T3');
    const expectedConfigHash = createHash('sha256').update(readFileSync(fix.gateConfigPath)).digest('hex');
    assert.equal(events[0]?.payload['gateConfigHash'], expectedConfigHash);
  } finally {
    fix.cleanup();
  }
});

test('T2 real config executes build/scopedE2e/secretScan via the shared spawn+retry machinery (REQ-12.2)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { build: 'true', scopedE2e: 'true', secretScan: 'false' });
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, false, 'secretScan (false) fails the tier');
    assert.deepEqual(report.checks.map((c) => c.name), ['build', 'scopedE2e', 'secretScan']);
    assert.equal(report.checks.find((c) => c.name === 'build')?.pass, true);
    assert.equal(report.checks.find((c) => c.name === 'secretScan')?.pass, false);
  } finally {
    fix.cleanup();
  }
});

test('T2 fullGolden:builtin verifies through verifyGoldenManifest (REQ-12.4)', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { fullGolden: 'builtin' });
    const report = await runnerFor(fix, makeClock()).run('T2');
    assert.equal(report.pass, true);
    assert.equal(report.checks[0]?.name, 'fullGolden');
  } finally {
    fix.cleanup();
  }
});

test('T2 GATE_RESULT is core-logged like every other tier', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    const log = openEventLog(fix.dbPath, clock);
    setT2(fix, { build: 'true' });
    const evidence = createEvidenceStore(fix.evidenceDir);
    await createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: 'RUN-1',
      taskId: 'T-1',
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
    }).run('T2');
    const events = log.all({ type: 'GATE_RESULT' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload['tier'], 'T2');
  } finally {
    fix.cleanup();
  }
});

test('gateConfigHash changes when the ladder file changes — governance-coupled (REQ-12.3)', async () => {
  const fix = makeFixture();
  try {
    const before = await runnerFor(fix, makeClock()).run('T2');
    setT2(fix, { build: 'true' });
    const after = await runnerFor(fix, makeClock()).run('T2');
    assert.notEqual(after.gateConfigHash, before.gateConfigHash);
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.8: freezing and materializing a tree never executes target Git filters or hooks', async () => {
  const fix = makeFixture();
  const marker = join(fix.root, 'filter-executed.txt');
  try {
    writeFileSync(join(fix.worktree, '.gitattributes'), '*.txt filter=target-owned\n');
    git(
      fix.worktree,
      'config',
      'filter.target-owned.clean',
      `printf CLEAN >> "${marker}"; cat`,
    );
    git(
      fix.worktree,
      'config',
      'filter.target-owned.smudge',
      `printf SMUDGE >> "${marker}"; cat`,
    );
    git(fix.worktree, 'config', 'filter.target-owned.required', 'true');

    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(report.pass, true);
    assert.equal(existsSync(marker), false, 'clean/smudge/process helpers never execute');
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.8: convention and golden builtins read the frozen tree, never the later authoritative worktree', async () => {
  const fix = makeFixture();
  try {
    const golden = join(fix.worktree, 'test', 'golden', 'expected.txt');
    const badTest = join(fix.worktree, 'test', 'bad.test.ts');
    writeFileSync(golden, 'tampered\n');
    writeFileSync(badTest, 'test.only("must remain frozen", () => {});\n');

    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    let calls = 0;
    const commandRunner: InjectedCommandRunner = {
      async run() {
        calls += 1;
        writeFileSync(golden, 'golden truth\n');
        writeFileSync(badTest, 'test("authoritative tree changed later", () => {});\n');
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(calls, 1);
    assert.equal(report.checks.find((check) => check.name === 'convention')?.pass, false);
    assert.equal(report.checks.find((check) => check.name === 'golden')?.pass, false);
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.8: T2 fullGolden reads the same frozen tree as its command checks', async () => {
  const fix = makeFixture();
  try {
    setT2(fix, { build: 'true', fullGolden: 'builtin' });
    const golden = join(fix.worktree, 'test', 'golden', 'expected.txt');
    writeFileSync(golden, 'tampered\n');
    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        writeFileSync(golden, 'golden truth\n');
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T2');

    assert.equal(report.checks.find((check) => check.name === 'fullGolden')?.pass, false);
  } finally {
    fix.cleanup();
  }
});

test('freezing a dirty tree preserves the caller staged state', async () => {
  const fix = makeFixture();
  try {
    const source = join(fix.worktree, 'src', 'impl.txt');
    writeFileSync(source, 'staged\n');
    git(fix.worktree, 'add', 'src/impl.txt');
    writeFileSync(source, 'working\n');
    const stagedBefore = git(fix.worktree, 'diff', '--cached', '--binary');

    await runnerFor(fix, makeClock()).run('T0');

    assert.equal(git(fix.worktree, 'diff', '--cached', '--binary'), stagedBefore);
  } finally {
    fix.cleanup();
  }
});

test('frozen materialization preserves executable mode and safe symlinks', async () => {
  const fix = makeFixture();
  try {
    const executable = join(fix.worktree, 'src', 'tool.sh');
    const link = join(fix.worktree, 'src', 'tool-link');
    const nestedLink = join(fix.worktree, 'src', 'nested', 'parent-link');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    symlinkSync('tool.sh', link);
    mkdirSync(join(fix.worktree, 'src', 'nested'), { recursive: true });
    symlinkSync('../tool.sh', nestedLink);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    let inspected = false;
    const commandRunner: InjectedCommandRunner = {
      async run(input) {
        inspected = true;
        assert.notEqual(lstatSync(join(input.workspaceRoot, 'src', 'tool.sh')).mode & 0o111, 0);
        assert.equal(lstatSync(join(input.workspaceRoot, 'src', 'tool-link')).isSymbolicLink(), true);
        assert.equal(readlinkSync(join(input.workspaceRoot, 'src', 'tool-link')), 'tool.sh');
        assert.equal(
          readlinkSync(join(input.workspaceRoot, 'src', 'nested', 'parent-link')),
          '../tool.sh',
        );
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(report.pass, true);
    assert.equal(inspected, true);
  } finally {
    fix.cleanup();
  }
});

test('unsafe symlink targets fail the frozen gate closed before command execution', async () => {
  const fix = makeFixture();
  try {
    symlinkSync('../../outside.txt', join(fix.worktree, 'src', 'escape-link'));
    let calls = 0;
    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        calls += 1;
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(report.pass, false);
    assert.equal(calls, 0);
    assert.match(report.checks[0]?.detail ?? '', /symlink|escape|materializ/i);
  } finally {
    fix.cleanup();
  }
});

test('submodule gitlinks fail the frozen gate closed before command execution', async () => {
  const fix = makeFixture();
  try {
    const head = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(fix.worktree, 'vendor', 'submodule'), { recursive: true });
    git(
      fix.worktree,
      'update-index',
      '--add',
      '--cacheinfo',
      '160000',
      head,
      'vendor/submodule',
    );
    git(fix.worktree, 'commit', '-q', '-m', 'fixture gitlink');
    let calls = 0;
    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    const commandRunner: InjectedCommandRunner = {
      async run() {
        calls += 1;
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const { gates } = runnerWithInjectedCommand(fix, commandRunner);

    const report = await gates.run('T1');

    assert.equal(report.pass, false);
    assert.equal(calls, 0);
    assert.match(report.checks[0]?.detail ?? '', /submodule|gitlink|materializ/i);
  } finally {
    fix.cleanup();
  }
});

test('GateReport.envHash binds the actual command-runner environment identity', async () => {
  const fix = makeFixture();
  try {
    const evidence = createEvidenceStore(fix.evidenceDir);
    const outputRef = evidence.put('sandbox:enforced\nexit:0\n');
    const commandRunnerA: InjectedCommandRunner & { environmentHash: string } = {
      environmentHash: 'a'.repeat(64),
      async run() {
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };
    const commandRunnerB: InjectedCommandRunner & { environmentHash: string } = {
      environmentHash: 'b'.repeat(64),
      async run() {
        return { status: 'completed', exitCode: 0, evidenceRef: outputRef, egressBlocked: true };
      },
    };

    const first = await runnerWithInjectedCommand(fix, commandRunnerA).gates.run('T1');
    const second = await runnerWithInjectedCommand(fix, commandRunnerB).gates.run('T1');

    assert.notEqual(first.envHash, second.envHash);
  } finally {
    fix.cleanup();
  }
});
