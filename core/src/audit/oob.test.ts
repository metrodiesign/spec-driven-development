// Out-of-band auditor (REQ-14). Pure target selection is table-tested directly;
// the orchestration is proven against a real fixture git + a real clone (no
// darwin-only sandbox involved — gate re-runs use /bin/sh, same as auto-merge).

import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import { createGateRunner } from '../gates/runner.ts';
import { auditSampleValue } from '../merge/auto-merge.ts';
import { openEventLog } from '../state/event-log.ts';
import { runOobAudit, selectAuditTargets } from './oob.ts';
import type { EventType, GateReport, PlatformEvent } from '../types.ts';
import {
  git,
  installFlakyTests,
  makeClock,
  makeFixture,
  makeReportIntegrity,
  PASSTHROUGH_TEST_SANDBOX,
} from '../../test/helpers/fixture.ts';

const RUN_ID = 'RUN-1';
const TASK_ID = 'T-1';

function eventsFactory() {
  let seq = 0;
  return (taskId: string, type: EventType, payload: Record<string, unknown>, runId = RUN_ID): PlatformEvent => {
    seq += 1;
    return { seq, ts: '2026-01-01T00:00:00.000Z', runId, taskId, type, payload };
  };
}

// ---------------------------------------------------------------------------
// Pure target selection (REQ-14.1/14.2) — no I/O, replayable straight from the log.
// ---------------------------------------------------------------------------
test('selectAuditTargets: rate=100 includes every eligible target, rate=0 excludes all (REQ-14.1)', () => {
  const ev = eventsFactory();
  const events = [
    ev('A', 'TASK_STATE', { state: 'COMPLETED' }),
    ev('A', 'AUDIT_RESULT', { sampled: false, mergeCommit: 'commitA' }),
    ev('B', 'TASK_STATE', { state: 'COMPLETED' }),
    ev('B', 'AUDIT_RESULT', { sampled: false, mergeCommit: 'commitB' }),
  ];
  assert.deepEqual(
    selectAuditTargets(events, 100, new Set()).map((t) => t.taskId).sort(),
    ['A', 'B'],
  );
  assert.deepEqual(selectAuditTargets(events, 0, new Set()), []);
});

test('selectAuditTargets: excludes in-band-sampled and prior-OOB targets even at rate=100 (REQ-14.2)', () => {
  const ev = eventsFactory();
  const events = [
    ev('A', 'TASK_STATE', { state: 'COMPLETED' }),
    ev('A', 'AUDIT_RESULT', { sampled: true, mergeCommit: 'commitA', reproduced: true }),
    ev('B', 'TASK_STATE', { state: 'COMPLETED' }),
    ev('B', 'AUDIT_RESULT', { sampled: false, mergeCommit: 'commitB' }),
    ev('B', 'OOB_AUDIT_RESULT', { verdict: 'reproduced', mergeCommit: 'commitB' }),
    ev('C', 'TASK_STATE', { state: 'COMPLETED' }),
    ev('C', 'AUDIT_RESULT', { sampled: false, mergeCommit: 'commitC' }),
  ];
  assert.deepEqual(
    selectAuditTargets(events, 100, new Set(['A', 'B'])).map((t) => t.taskId),
    ['C'],
    'A excluded (in-band sampled), B excluded (prior OOB) — idempotent across cycles',
  );
});

test('selectAuditTargets: the oob-salted fold is an independent stream from the in-band fold (REQ-14.1)', () => {
  let disagreement = false;
  for (let i = 0; i < 50 && !disagreement; i++) {
    const taskId = `T-${i}`;
    if (auditSampleValue(RUN_ID, taskId) !== auditSampleValue(RUN_ID, `${taskId}oob`)) disagreement = true;
  }
  assert.ok(disagreement, 'salting with "oob" changes the fold for at least one taskId — an independent stream');
});

test('selectAuditTargets: skips a COMPLETED task with no recorded mergeCommit (nothing to audit)', () => {
  const ev = eventsFactory();
  const events = [ev('A', 'TASK_STATE', { state: 'COMPLETED' })];
  assert.deepEqual(selectAuditTargets(events, 100, new Set()), []);
});

test('mixed hard and flaky checks classify as a hard failure before flake handling', async () => {
  const module = (await import('./oob.ts')) as typeof import('./oob.ts') & {
    classifyOobChecks?: (report: GateReport) => 'hard_failure' | 'flaky_suspect' | 'clean';
  };
  assert.equal(typeof module.classifyOobChecks, 'function');
  const classification = module.classifyOobChecks?.({
    tier: 'T1',
    pass: false,
    gateConfigHash: 'g',
    commitHash: 'c',
    worktreeHash: 'w',
    envHash: 'e',
    scopeNote: 's',
    checks: [
      { name: 'flaky', pass: false, flakySuspect: true, evidenceRef: 'blob://flaky' },
      { name: 'hard', pass: false, evidenceRef: 'blob://hard' },
    ],
  });
  assert.equal(classification, 'hard_failure');
});

// ---------------------------------------------------------------------------
// Orchestration: real clone, real re-run (REQ-14.3/14.4/14.5/14.6/14.9).
// ---------------------------------------------------------------------------
test('an honest COMPLETED task reproduces cleanly from a clean clone -> verdict reproduced (control)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src/impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task genuinely fixes impl.txt');
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergeCommit = git(fix.worktree, 'rev-parse', 'main').trim();

    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
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
    const original = await gates.run('T1');
    assert.equal(original.pass, true, 'genuinely green on the merged tree');
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: 'COMPLETED' } });
    log.close();

    const verdicts = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.taskId, TASK_ID);
    assert.equal(verdicts[0]?.mergeCommit, mergeCommit);
    assert.equal(verdicts[0]?.verdict, 'reproduced');

    const reopened = openEventLog(fix.dbPath, clock);
    assert.equal(reopened.all({ type: 'OOB_AUDIT_RESULT' }).at(-1)?.payload['reproduced'], true);
    assert.equal(reopened.all({ type: 'ESCALATED' }).length, 0, 'never escalates on a genuine reproduction');
    reopened.close();

    // A second cycle never reselects the same target — idempotent (REQ-14.2).
    const secondPass = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });
    assert.deepEqual(secondPass, [], 'already OOB-audited — not reselected on the next cycle');
  } finally {
    fix.cleanup();
  }
});

test('REQ-4.9-4.13: an unsigned fabricated T1 is rejected before OOB comparison and never reverted', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    // The task branch never actually fixes impl.txt — the merged tree stays RED.
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src/other.txt'), 'unrelated\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work that never touches impl.txt');
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergeCommit = git(fix.worktree, 'rev-parse', 'main').trim();

    const log = openEventLog(fix.dbPath, clock);
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
    log.append({
      runId: RUN_ID,
      taskId: TASK_ID,
      type: 'GATE_RESULT',
      payload: { ...fabricatedGreen } as unknown as Record<string, unknown>,
    });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: 'COMPLETED' } });
    log.close();

    const verdicts = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verdicts.length, 0, 'unauthenticated evidence cannot enter audit comparison');

    const reopened = openEventLog(fix.dbPath, clock);
    assert.equal(reopened.all({ type: 'OOB_AUDIT_RESULT' }).length, 0);
    const esc = reopened.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'evidence_auth_unavailable');
    assert.equal(esc?.payload['boundary'], 'oob_audit');
    reopened.close();

    // Detection only — the auditor never touches the live repo's main branch.
    assert.equal(git(fix.worktree, 'rev-parse', 'main').trim(), mergeCommit, 'never reverted or mutated (REQ-14.6)');
  } finally {
    fix.cleanup();
  }
});

test('a legacy signed gate captured from a different tree is rejected before OOB comparison', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    writeFileSync(join(fix.worktree, 'src/impl.txt'), 'correct\n');
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'task work');
    const unrelatedTree = git(fix.worktree, 'rev-parse', 'main^{tree}').trim();
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergeCommit = git(fix.worktree, 'rev-parse', 'main').trim();

    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    const legacyReport = reportIntegrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'gate',
      commitHash: mergeCommit,
      worktreeHash: unrelatedTree,
      envHash: 'env',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('green') }],
      scopeNote: 'legacy fixture',
    }, { runId: RUN_ID, taskId: TASK_ID });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'GATE_RESULT', payload: { ...legacyReport } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: 'COMPLETED' } });
    log.close();

    const verdicts = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verdicts.length, 0);
    assert.equal(verdicts.failures[0]?.code, 'artifact_identity_mismatch');
  } finally {
    fix.cleanup();
  }
});

test('a one-time flake in the clean clone -> OOB retries once and recovers as flaky_suspect, not non_repro (REQ-14.4/14.5)', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    const externalMarker = join(fix.root, 'oob-flake-marker');
    writeFileSync(
      join(fix.worktree, 'run-tests.sh'),
      `#!/bin/sh\nif [ -f ${JSON.stringify(externalMarker)} ]; then exit 0; else touch ${JSON.stringify(externalMarker)}; exit 1; fi\n`,
    );
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'fixture: externally observable one-time flake');
    const artifactCommit = git(fix.worktree, 'rev-parse', 'HEAD').trim();
    const artifactTree = git(fix.worktree, 'rev-parse', 'HEAD^{tree}').trim();
    const baseCommit = git(fix.worktree, 'rev-parse', 'main').trim();
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergeCommit = git(fix.worktree, 'rev-parse', 'main').trim();

    // Original capture: pre-seed state OUTSIDE the immutable artifact so its own
    // T1 run is a clean pass while worktreeHash remains the signed commit tree.
    writeFileSync(externalMarker, '');
    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    const gates = createGateRunner({
      worktreeDir: fix.worktree,
      configPath: fix.gateConfigPath,
      runId: RUN_ID,
      taskId: TASK_ID,
      log,
      evidence,
      reportIntegrity,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });
    const original = await gates.run('T1');
    assert.equal(original.pass, true, 'marker pre-seeded — a clean single-attempt pass');
    const authorized = reportIntegrity.signGateReport({
      ...original,
      worktreeHash: artifactTree,
      artifactCommitHash: artifactCommit,
      baseCommitHash: baseCommit,
      mergedCommitHash: mergeCommit,
    }, { runId: RUN_ID, taskId: TASK_ID });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'EVIDENCE_AUTHORIZED', payload: { ...authorized } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    log.append({ runId: RUN_ID, taskId: TASK_ID, type: 'TASK_STATE', payload: { state: 'COMPLETED' } });
    log.close();
    unlinkSync(externalMarker);

    // The clone sees the same signed tree but no external marker — its first re-run hits the same
    // one-time flake the original never had to face, then recovers on retry.
    const verdicts = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.verdict, 'flaky_suspect');

    const reopened = openEventLog(fix.dbPath, clock);
    assert.equal(reopened.all({ type: 'ESCALATED' }).length, 0, 'flaky_suspect is flagged, never escalated nor quarantined');
    reopened.close();
  } finally {
    fix.cleanup();
  }
});

test('a mixed flake plus deterministic hard failure never receives a flake-only verdict', async () => {
  const fix = makeFixture();
  try {
    const clock = makeClock();
    git(fix.worktree, 'checkout', '-q', '-b', 'task/T-1');
    installFlakyTests(fix);
    writeFileSync(
      join(fix.worktree, 'test', 'hard-failure.test.ts'),
      'test.only("deterministic convention failure", () => {});\n',
    );
    git(fix.worktree, 'add', '-A');
    git(fix.worktree, 'commit', '-q', '-m', 'fixture: mixed hard and flaky failures');
    git(fix.worktree, 'checkout', '-q', 'main');
    git(fix.worktree, 'merge', '--no-ff', '--no-edit', 'task/T-1');
    const mergeCommit = git(fix.worktree, 'rev-parse', 'main').trim();

    const log = openEventLog(fix.dbPath, clock);
    const evidence = createEvidenceStore(fix.evidenceDir);
    const reportIntegrity = makeReportIntegrity(fix, evidence);
    const fabricatedGreen = reportIntegrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'x',
      commitHash: mergeCommit,
      worktreeHash: git(fix.worktree, 'rev-parse', `${mergeCommit}^{tree}`).trim(),
      envHash: 'x',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: evidence.put('fabricated green') }],
      scopeNote: 'x',
    }, { runId: RUN_ID, taskId: TASK_ID });
    log.append({
      runId: RUN_ID,
      taskId: TASK_ID,
      type: 'GATE_RESULT',
      payload: { ...fabricatedGreen } as unknown as Record<string, unknown>,
    });
    log.append({
      runId: RUN_ID,
      taskId: TASK_ID,
      type: 'AUDIT_RESULT',
      payload: { sampled: false, mergeCommit },
    });
    log.append({
      runId: RUN_ID,
      taskId: TASK_ID,
      type: 'TASK_STATE',
      payload: { state: 'COMPLETED' },
    });
    log.close();

    const verdicts = await runOobAudit({
      dbPath: fix.dbPath,
      repoDir: fix.worktree,
      gateConfigRelPath: 'gate-ladder.json',
      sampleRate: 100,
      clock,
      sandbox: PASSTHROUGH_TEST_SANDBOX,
    });

    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.verdict, 'non_repro');
  } finally {
    fix.cleanup();
  }
});
