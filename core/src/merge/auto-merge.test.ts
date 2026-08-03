// Auto-merge L0–L1 + sampling audit (REQ-7/8). The pure decision gate is table-
// tested; the merge/audit orchestration drives the REAL git of the fixture repo
// (task branch -> main --no-ff, clean-checkout re-run, revert-on-mismatch). Gate
// re-runs use /bin/sh directly (not the deny-network sandbox), so these run on any
// host — no darwin gate.

import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from '../gates/runner.ts';
import { ReportIntegrityError, type ReportIntegrity } from '../gates/report-integrity.ts';
import { createLeaseManager } from '../state/lease.ts';
import { openEventLog } from '../state/event-log.ts';
import { createMergeQueue } from './queue.ts';
import {
  auditSampleValue,
  decideAutoApprove,
  matchesDepManifest,
  runApprovedMerge,
  runAutoMerge,
  type MappedAc,
} from './auto-merge.ts';
import { bindGateReportToTaskArtifact } from './artifact-binding.ts';
import type { EventLog } from '../state/event-log.ts';
import type { GateReport } from '../types.ts';
import {
  git,
  makeClock,
  makeFixture,
  makeReportIntegrity,
  PASSTHROUGH_TEST_SANDBOX,
  type Fixture,
} from '../../test/helpers/fixture.ts';

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';
const TASK_BRANCH = 'task/T-1';
const GOLDEN_AC: MappedAc[] = [{ id: 'AC-1', golden: true }];
const NO_DEP: string[] = [];

// ---------------------------------------------------------------------------
// Pure gate (REQ-7.2/7.6/7.7/7.9) — the agent claim is never an input.
// ---------------------------------------------------------------------------
test('decideAutoApprove: L0/L1 + green + all-golden + no dep-diff auto-approves', () => {
  for (const riskClass of ['L0', 'L1'] as const) {
    const d = decideAutoApprove({
      riskClass,
      gatesGreen: true,
      acceptanceCriteria: GOLDEN_AC,
      diffPaths: ['src/a.ts'],
      depManifestPatterns: ['package.json'],
    });
    assert.equal(d.autoApprove, true, `${riskClass} auto-approves`);
    assert.equal(d.effectiveRisk, riskClass);
    assert.equal(d.reason, 'auto_approved');
  }
});

test('decideAutoApprove: routes to the approval package for every non-qualifying case', () => {
  const base = {
    riskClass: 'L1' as const,
    gatesGreen: true,
    acceptanceCriteria: GOLDEN_AC,
    diffPaths: ['src/a.ts'],
    depManifestPatterns: ['package.json', 'pnpm-lock.yaml'],
  };
  // gates not green (REQ-7.2)
  assert.deepEqual(sub(decideAutoApprove({ ...base, gatesGreen: false })), [false, 'gates_not_green']);
  // L2+ declared (REQ-7.2)
  assert.deepEqual(sub(decideAutoApprove({ ...base, riskClass: 'L2' })), [false, 'risk_above_l1']);
  // absent risk -> L2 (REQ-7.6)
  const nullRisk = decideAutoApprove({ ...base, riskClass: null });
  assert.deepEqual(sub(nullRisk), [false, 'risk_above_l1']);
  assert.equal(nullRisk.effectiveRisk, 'L2');
  // zero ACs -> never a vacuous auto-merge (REQ-7.9)
  assert.deepEqual(sub(decideAutoApprove({ ...base, acceptanceCriteria: [] })), [false, 'zero_acceptance_criteria']);
  // a non-golden AC forces the package (REQ-7.7)
  assert.deepEqual(
    sub(decideAutoApprove({ ...base, acceptanceCriteria: [{ id: 'AC-1', golden: true }, { id: 'AC-2' }] })),
    [false, 'non_golden_ac'],
  );
  // a dependency-manifest diff floors L1 -> L2 (REQ-7.6)
  const dep = decideAutoApprove({ ...base, diffPaths: ['src/a.ts', 'pnpm-lock.yaml'] });
  assert.deepEqual(sub(dep), [false, 'dep_touching_diff']);
  assert.equal(dep.effectiveRisk, 'L2', 'floored to L2');
});

function sub(d: ReturnType<typeof decideAutoApprove>): [boolean, string] {
  return [d.autoApprove, d.reason];
}

test('matchesDepManifest: basename anywhere; slash pattern by suffix', () => {
  assert.ok(matchesDepManifest('a/b/package.json', ['package.json']), 'basename match in a subdir');
  assert.ok(!matchesDepManifest('src/package.json.ts', ['package.json']), 'not a partial-name match');
  assert.ok(matchesDepManifest('vendor/go.sum', ['vendor/go.sum']), 'slash pattern by suffix');
  assert.ok(!matchesDepManifest('src/app.ts', ['package.json', 'go.sum']), 'ordinary file untouched (REQ-11.6 spirit)');
});

test('decideAutoApprove uses the real .ai/policies/security-plane.json pattern list (AZ-17)', () => {
  const policyPath = join(import.meta.dirname, '../../../.ai/policies/security-plane.json');
  const { depManifestPatterns } = JSON.parse(readFileSync(policyPath, 'utf8')) as {
    depManifestPatterns: string[];
  };
  assert.ok(depManifestPatterns.includes('package-lock.json'), 'policy lists lockfiles');
  const d = decideAutoApprove({
    riskClass: 'L1',
    gatesGreen: true,
    acceptanceCriteria: GOLDEN_AC,
    diffPaths: ['services/api/package-lock.json'],
    depManifestPatterns,
  });
  assert.equal(d.autoApprove, false, 'a lockfile diff is never auto-merged');
  assert.equal(d.reason, 'dep_touching_diff');
});

test('auditSampleValue: deterministic and in [0,100)', () => {
  const a = auditSampleValue(RUN_ID, TASK_ID);
  const b = auditSampleValue(RUN_ID, TASK_ID);
  assert.equal(a, b, 'replayable — same inputs, same value (REQ-8.1)');
  assert.ok(a >= 0 && a < 100);
  assert.notEqual(auditSampleValue(RUN_ID, 'T-other'), auditSampleValue(RUN_ID, TASK_ID));
});

// ---------------------------------------------------------------------------
// Orchestration over the real fixture git.
// ---------------------------------------------------------------------------
function openLog(fix: Fixture, clock = makeClock()): { log: EventLog; clock: ReturnType<typeof makeClock> } {
  return { log: openEventLog(fix.dbPath, clock), clock };
}

/** Create task/<id> off main, apply changes, commit. Returns to the task branch. */
function setupTaskBranch(fix: Fixture, files: Record<string, string>): void {
  git(fix.worktree, 'checkout', '-q', '-b', TASK_BRANCH);
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(fix.worktree, rel), content);
  git(fix.worktree, 'add', '-A');
  git(fix.worktree, 'commit', '-q', '-m', 'task work');
}

function runT1(fix: Fixture, log: EventLog, evidence: ReturnType<typeof createEvidenceStore>, clock: ReturnType<typeof makeClock>): Promise<GateReport> {
  const gates = createGateRunner({
    worktreeDir: fix.worktree,
    configPath: fix.gateConfigPath,
    runId: RUN_ID,
    taskId: TASK_ID,
    log,
    evidence,
    reportIntegrity: makeReportIntegrity(fix, evidence),
    clock,
    sandbox: PASSTHROUGH_TEST_SANDBOX,
  });
  return gates.run('T1');
}

function states(log: EventLog): string[] {
  return log.all({ type: 'TASK_STATE' }).map((e) => String(e.payload['state']));
}

test('L1 task auto-merges and a sampled audit reproduces -> COMPLETED (REQ-7, REQ-8)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const signedArtifact = git(fix.worktree, 'rev-parse', TASK_BRANCH).trim();
    const signedBase = git(fix.worktree, 'rev-parse', 'main').trim();
    const originalReport = await runT1(fix, log, evidence, clock);
    assert.equal(originalReport.pass, true, 'task branch is genuinely green');

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.decision, 'auto_approve');
    assert.equal(out.sampled, true);
    assert.equal(out.reproduced, true, 'clean-checkout re-run reproduced the recorded verdicts + evidence');
    assert.equal(out.finalState, 'COMPLETED');
    // Events are labeled policy decisions, not human approvals.
    const autoEv = log.all({ type: 'AUTO_APPROVED' });
    assert.equal(autoEv.length, 1);
    assert.equal(autoEv[0]?.payload['by'], 'auto_merge_policy');
    assert.equal(log.all({ type: 'AUDIT_SAMPLED' }).length, 1);
    assert.equal(log.all({ type: 'AUDIT_RESULT' }).at(-1)?.payload['reproduced'], true);
    assert.ok(states(log).includes('MERGE_QUEUED') && states(log).includes('AUDITED'));

    // The merge really landed on main as a single --no-ff merge commit.
    git(fix.worktree, 'checkout', '-q', 'main');
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
    const parents = git(fix.worktree, 'rev-list', '--parents', '-1', 'HEAD').trim().split(/\s+/);
    assert.equal(parents.length, 3, 'HEAD is a merge commit (2 parents) — --no-ff');
    assert.equal(parents[1], signedBase, 'direct merge first parent is the exact signed base');
    assert.equal(parents[2], signedArtifact, 'direct merge second parent is the exact signed task artifact');
  } finally {
    fix.cleanup();
  }
});

test('unsampled merged task proceeds audited -> COMPLETED without a re-run (REQ-8.4)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const originalReport = await runT1(fix, log, evidence, clock);
    const gateEventsBefore = log.all({ type: 'GATE_RESULT' }).length;

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L0', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 0, // sha256(...) mod 100 < 0 is never true -> unsampled
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.sampled, false);
    assert.equal(out.reproduced, null);
    assert.equal(out.finalState, 'COMPLETED');
    assert.equal(log.all({ type: 'AUDIT_SAMPLED' }).length, 0, 'no audit sampled');
    assert.equal(log.all({ type: 'AUDIT_RESULT' }).at(-1)?.payload['sampled'], false);
    assert.equal(log.all({ type: 'GATE_RESULT' }).length, gateEventsBefore, 'no gate re-run when unsampled');
  } finally {
    fix.cleanup();
  }
});

test('P0-04 C1: a signed green report cannot authorize a later red task-branch commit', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const signedGreen = await runT1(fix, log, evidence, clock);
    assert.equal(signedGreen.pass, true, 'control: commit A is genuinely green');

    writeFileSync(join(fix.worktree, 'src/impl.txt'), 'wrong\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'commit B invalidates the signed artifact');
    const redCommit = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const mainBefore = git(fix.worktree, 'rev-parse', 'main').trim();

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L0', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport: signedGreen,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 0,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(out.mergeCommit, null, 'the stale report never reaches the merge callback');
    assert.ok(!states(log).includes('COMPLETED'));
    assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['code'], 'artifact_identity_mismatch');
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), mainBefore, 'main is not advanced to commit B');
    assert.notEqual(git(fix.worktree, 'rev-parse', 'main').trim(), redCommit);
  } finally {
    fix.cleanup();
  }
});

test('P0-04 Task 39: a concurrent main advance after direct verification loses the signed-base CAS', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const gated = await runT1(fix, log, evidence, clock);
    const authorized = bindGateReportToTaskArtifact(gated, reportIntegrity, {
      runId: RUN_ID,
      taskId: TASK_ID,
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
    });
    const signedBase = authorized.baseCommitHash as string;
    let concurrentCommit = '';
    let injected = false;
    const interleavingLog: EventLog = {
      append(event) {
        const appended = log.append(event);
        if (!injected && event.type === 'TASK_STATE' && event.payload['state'] === 'MERGE_QUEUED') {
          injected = true;
          git(fix.worktree, 'checkout', '-q', 'main');
          writeFileSync(join(fix.worktree, 'src', 'concurrent.txt'), 'must survive\n');
          git(fix.worktree, 'add', '-A');
          git(fix.worktree, 'commit', '-q', '-m', 'concurrent main advance');
          concurrentCommit = git(fix.worktree, 'rev-parse', 'main').trim();
        }
        return appended;
      },
      appendFenced(event, claim, now) {
        return log.appendFenced(event, claim, now);
      },
      all: (filter) => log.all(filter),
      exportJsonl: () => log.exportJsonl(),
      projection: () => log.projection(),
      close: () => log.close(),
    };

    const out = await runApprovedMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'APPROVED',
      approvalBasis: 'human_approved',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      originalReport: authorized,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 0,
      log: interleavingLog,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.ok(injected);
    assert.notEqual(concurrentCommit, signedBase);
    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(out.mergeCommit, null);
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), concurrentCommit);
    assert.equal(log.all({ type: 'EVIDENCE_AUTHORIZED' }).length, 0);
    assert.ok(!states(log).includes('COMPLETED'));
    const escalation = log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalation?.payload['boundary'], 'direct_merge_update');
    assert.equal(escalation?.payload['code'], 'artifact_identity_mismatch');
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.9-4.13: unsigned evidence cannot trigger auto-approval or merge', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const mainBefore = git(fix.worktree, 'rev-parse', 'main').trim();
    const unsigned: GateReport = {
      tier: 'T1',
      pass: true,
      gateConfigHash: 'x',
      commitHash: 'x',
      worktreeHash: 'x',
      envHash: 'x',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'x',
    };

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport: unsigned,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 0,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.decision, 'evidence_invalid');
    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(out.mergeCommit, null);
    assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0);
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), mainBefore);
    assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['code'], 'signature_missing');
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.9-4.13: completion re-verifies and cannot advance after authentication fails', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const originalReport = await runT1(fix, log, evidence, clock);
    const base = makeReportIntegrity(fix, evidence);
    let verifications = 0;
    const reportIntegrity: ReportIntegrity = {
      signGateReport: (report, identity) => base.signGateReport(report, identity),
      verifyGateReport(report, identity) {
        verifications += 1;
        if (verifications === 5) {
          throw new ReportIntegrityError('signature_mismatch', 'injected completion-boundary failure');
        }
        return base.verifyGateReport(report, identity);
      },
      verifyGateReportRef: (ref, identity) => base.verifyGateReportRef(ref, identity),
      verifyEvidenceRef: (ref) => base.verifyEvidenceRef(ref),
    };

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 0,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verifications, 5);
    assert.equal(out.finalState, 'ESCALATED');
    assert.ok(out.mergeCommit, 'merge happened before the separate completion boundary');
    assert.ok(!states(log).includes('COMPLETED'));
    assert.equal(log.all({ type: 'AUDIT_RESULT' }).length, 0);
    assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['boundary'], 'completion');
  } finally {
    fix.cleanup();
  }
});

test('sampled audit that does NOT reproduce -> single escalate(audit_mismatch) + merge reverted (REQ-8.3)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    // The gated Git bytes remain immutable, while an external probe prerequisite
    // disappears before the clean-checkout audit. This is a genuine non-repro,
    // not a stale signed report (which is now rejected before merge).
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n', 'src/feature.txt': 'ship\n' });
    const marker = join(fix.root, 'external-service-ready');
    writeFileSync(marker, 'ready\n');
    writeFileSync(join(fix.worktree, 'run-tests.sh'), `#!/bin/sh\ntest -f '${marker}'\n`);
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'gate against external prerequisite');
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    const originalReport = await runT1(fix, log, evidence, clock);
    assert.equal(originalReport.pass, true);
    unlinkSync(marker);

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.reproduced, false);
    assert.equal(out.finalState, 'ESCALATED');
    const esc = log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'audit_mismatch');
    // Exactly one escalate on this path (no separate roll_back — AZ-5).
    assert.equal(states(log).filter((s) => s === 'ESCALATED').length, 1);

    // The revert undid the merge: feature.txt is gone from main's tip.
    git(fix.worktree, 'checkout', '-q', 'main');
    assert.ok(
      git(fix.worktree, 'ls-files', 'src/feature.txt').trim() === '',
      'merge reverted — the auto-merged file no longer tracked on main',
    );
  } finally {
    fix.cleanup();
  }
});

test('a conflicting merge escalates merge_conflict with no auto-resolution (REQ-7.5)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    // Task edits impl.txt; then main edits the SAME line -> --no-ff conflicts.
    setupTaskBranch(fix, { 'src/impl.txt': 'task-side\n' });
    const originalReport = await runT1(fix, log, evidence, clock);
    git(fix.worktree, 'checkout', '-q', 'main');
    writeFileSync(join(fix.worktree, 'src/impl.txt'), 'main-side\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'main diverges');

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.mergeCommit, null);
    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'merge_conflict');
    // Merge aborted cleanly: main untouched, no conflict markers, tree clean.
    git(fix.worktree, 'checkout', '-q', 'main');
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'main-side\n');
    assert.equal(git(fix.worktree, 'status', '--porcelain').trim(), '', 'no half-merged state left behind');
  } finally {
    fix.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Queue-routed path (REQ-13.6): the queue owns merge+T2; sampled audit/revert
// below stay exactly as tested above — unchanged either way.
// ---------------------------------------------------------------------------
function setupIntegrationWorktree(fix: Fixture): string {
  const dir = join(fix.root, 'integration');
  git(fix.worktree, 'worktree', 'add', '--detach', dir, 'main');
  return dir;
}

test('runAutoMerge routed through the queue: T2 not_enabled -> merges, sampled audit reproduces -> COMPLETED (REQ-13.2/13.3/13.6/13.9)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const originalReport = await runT1(fix, log, evidence, clock);

    const integrationDir = setupIntegrationWorktree(fix);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const gates = createGateRunner({
      worktreeDir: integrationDir,
      configPath: join(integrationDir, 'gate-ladder.json'),
      runId: RUN_ID,
      taskId: TASK_ID,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });
    const queue = createMergeQueue({
      runId: RUN_ID,
      repoDir: fix.worktree,
      mainBranch: 'main',
      worktreeDir: integrationDir,
      gates,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      log,
      lease,
    });

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
      queue,
    });

    assert.equal(out.decision, 'auto_approve');
    assert.equal(out.reproduced, true, 'clean-checkout re-run still reproduces through the queue path');
    assert.equal(out.finalState, 'COMPLETED');
    assert.equal(log.all({ type: 'MERGE_ENQUEUED' }).length, 1);
    const mr = log.all({ type: 'MERGE_RESULT' }).at(-1);
    assert.equal(mr?.payload['outcome'], 'merged');
    assert.equal(mr?.payload['tier'], 't1_only');

    git(fix.worktree, 'checkout', '-q', 'main');
    assert.equal(readFileSync(join(fix.worktree, 'src/impl.txt'), 'utf8'), 'correct\n');
  } finally {
    fix.cleanup();
  }
});

test('runAutoMerge routed through the queue: T2 fails -> ESCALATED(t2_failed), main untouched (REQ-13.4)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const originalReport = await runT1(fix, log, evidence, clock);

    git(fix.worktree, 'checkout', '-q', 'main');
    const ladder = JSON.parse(readFileSync(fix.gateConfigPath, 'utf8')) as Record<string, unknown>;
    ladder['t2'] = { secretScan: 'false' };
    writeFileSync(fix.gateConfigPath, JSON.stringify(ladder));
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'enable failing t2');
    const mainTipBefore = git(fix.worktree, 'rev-parse', 'main').trim();

    const integrationDir = setupIntegrationWorktree(fix);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const gates = createGateRunner({
      worktreeDir: integrationDir,
      configPath: join(integrationDir, 'gate-ladder.json'),
      runId: RUN_ID,
      taskId: TASK_ID,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });
    const queue = createMergeQueue({
      runId: RUN_ID,
      repoDir: fix.worktree,
      mainBranch: 'main',
      worktreeDir: integrationDir,
      gates,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      log,
      lease,
    });

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
      queue,
    });

    assert.equal(out.mergeCommit, null);
    assert.equal(out.finalState, 'ESCALATED');
    const esc = log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 't2_failed');
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), mainTipBefore, 'main untouched — T2 failure never lands');
  } finally {
    fix.cleanup();
  }
});

test('runAutoMerge routed through the queue: sampled audit does NOT reproduce -> revert lands on main, not whatever opts.repoDir had checked out (PR #50 review)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    // The task bytes are genuinely gated, then an external prerequisite disappears
    // so the sampled clean-checkout audit produces a real non-repro.
    // The queue never checks out main in fix.worktree (only integrationDir + an
    // update-ref) — fix.worktree stays on TASK_BRANCH from setupTaskBranch, which is
    // exactly the state the revert-target bug needs to be caught.
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n', 'src/feature.txt': 'ship\n' });
    const marker = join(fix.root, 'external-service-ready-queue');
    writeFileSync(marker, 'ready\n');
    writeFileSync(join(fix.worktree, 'run-tests.sh'), `#!/bin/sh\ntest -f '${marker}'\n`);
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'gate against external prerequisite');
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    const originalReport = await runT1(fix, log, evidence, clock);
    assert.equal(originalReport.pass, true);
    unlinkSync(marker);

    const integrationDir = setupIntegrationWorktree(fix);
    const lease = createLeaseManager(fix.dbPath, clock, RUN_ID);
    const gates = createGateRunner({
      worktreeDir: integrationDir,
      configPath: join(integrationDir, 'gate-ladder.json'),
      runId: RUN_ID,
      taskId: TASK_ID,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });
    const queue = createMergeQueue({
      runId: RUN_ID,
      repoDir: fix.worktree,
      mainBranch: 'main',
      worktreeDir: integrationDir,
      gates,
      reportIntegrity,
      log,
      lease,
    });

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L1', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
      queue,
    });

    assert.equal(out.reproduced, false);
    assert.equal(out.finalState, 'ESCALATED');
    assert.equal(log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'audit_mismatch');

    git(fix.worktree, 'checkout', '-q', 'main');
    assert.ok(
      git(fix.worktree, 'ls-files', 'src/feature.txt').trim() === '',
      'merge reverted on main — the queue-advanced ref, not fix.worktree\'s leftover task-branch checkout',
    );
  } finally {
    fix.cleanup();
  }
});

test('a non-qualifying task routes to the approval package: no merge, state unchanged (REQ-7.2)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    setupTaskBranch(fix, { 'src/impl.txt': 'correct\n' });
    const originalReport = await runT1(fix, log, evidence, clock);
    const mainTipBefore = git(fix.worktree, 'rev-parse', 'main').trim();

    const out = await runAutoMerge({
      runId: RUN_ID,
      taskId: TASK_ID,
      state: 'REVIEWING',
      repoDir: fix.worktree,
      taskBranch: TASK_BRANCH,
      mainBranch: 'main',
      decision: { riskClass: 'L2', gatesGreen: true, acceptanceCriteria: GOLDEN_AC, depManifestPatterns: NO_DEP },
      originalReport,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      reportIntegrity: makeReportIntegrity(fix, evidence),
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(out.decision, 'approval_package');
    assert.equal(out.reason, 'risk_above_l1');
    assert.equal(out.finalState, 'REVIEWING', 'no state change — the human path takes over');
    assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0, 'no policy approval fired');
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), mainTipBefore, 'main is untouched');
  } finally {
    fix.cleanup();
  }
});
