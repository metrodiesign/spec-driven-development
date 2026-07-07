// Auto-merge L0–L1 + sampling audit (REQ-7/8). The pure decision gate is table-
// tested; the merge/audit orchestration drives the REAL git of the fixture repo
// (task branch -> main --no-ff, clean-checkout re-run, revert-on-mismatch). Gate
// re-runs use /bin/sh directly (not the deny-network sandbox), so these run on any
// host — no darwin gate.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from '../gates/runner.ts';
import { openEventLog } from '../state/event-log.ts';
import {
  auditSampleValue,
  decideAutoApprove,
  matchesDepManifest,
  runAutoMerge,
  type MappedAc,
} from './auto-merge.ts';
import type { EventLog } from '../state/event-log.ts';
import type { GateReport } from '../types.ts';
import { git, makeClock, makeFixture, type Fixture } from '../../test/helpers/fixture.ts';

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
    clock,
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
      clock,
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
      clock,
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

test('sampled audit that does NOT reproduce -> single escalate(audit_mismatch) + merge reverted (REQ-8.3)', async () => {
  const fix = makeFixture();
  try {
    const { log, clock } = openLog(fix);
    const evidence = createEvidenceStore(fix.evidenceDir);
    // Task branch is actually RED (impl still 'wrong') but adds a feature file;
    // we feed a fabricated green report — the audit must catch the drift.
    setupTaskBranch(fix, { 'src/impl.txt': 'wrong\n', 'src/feature.txt': 'ship\n' });
    const fabricatedGreen: GateReport = {
      tier: 'T1',
      pass: true,
      gateConfigHash: 'x',
      commitHash: 'x',
      worktreeHash: 'x',
      envHash: 'x',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: 'blob://' + '0'.repeat(64) }],
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
      originalReport: fabricatedGreen,
      gateConfigRelPath: 'gate-ladder.json',
      auditSampleRate: 100,
      log,
      evidence,
      clock,
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
      clock,
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
      clock,
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
