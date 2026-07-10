// Lessons pipeline (REQ-10/11/12): propose -> pending/ + LESSON_PROPOSED +
// lesson_promote governance proposal; approve -> pending/ -> approved/ +
// LESSON_APPROVED (live callback OR the offline reconciler); load exclusively
// from approved/, corrupt files skipped, cap by count then bytes.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { approveProposal, listPendingProposals, readGovernanceLog } from '../governance/policy.ts';
import { openEventLog } from '../state/event-log.ts';
import {
  foldConfirmedHypotheses,
  loadApprovedLessons,
  promoteLesson,
  proposeLessonFromHypothesis,
} from './lessons.ts';
import type { Clock } from '../types.ts';

const clock: Clock = { now: () => 1_700_000_000_000 };

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'lessons-'));
  const dir = join(root, 'lessons');
  const governanceLogPath = join(root, 'governance', 'events.jsonl');
  const log = openEventLog(join(root, 'events.db'), clock);
  return { root, dir, governanceLogPath, log, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('proposeLessonFromHypothesis writes pending/, LESSON_PROPOSED, and a lesson_promote proposal (REQ-10.1/10.3)', () => {
  const h = harness();
  try {
    const record = proposeLessonFromHypothesis({
      dir: h.dir,
      governanceLogPath: h.governanceLogPath,
      statement: 'flaky test needs a retry guard',
      sourceRunId: 'RUN-1',
      sourceTaskId: 'T-1',
      evidenceRefs: ['blob://probe-1'],
      clock,
      log: h.log,
      runId: 'RUN-1',
      taskId: 'T-1',
    });
    assert.ok(record !== null);
    if (record === null) throw new Error('unreachable');
    assert.equal(existsSync(join(h.dir, 'pending', `${record.id}.json`)), true);

    const proposed = h.log.all({ type: 'LESSON_PROPOSED' });
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0]?.payload['lessonId'], record.id);

    const proposals = listPendingProposals(readGovernanceLog(h.governanceLogPath));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.kind, 'lesson_promote');
    assert.equal(proposals[0]?.lessonId, record.id);
  } finally {
    h.cleanup();
  }
});

test('re-proposing the same statement+evidence is idempotent — no duplicate file, event, or proposal (REQ-10.2)', () => {
  const h = harness();
  try {
    const input = {
      dir: h.dir,
      governanceLogPath: h.governanceLogPath,
      statement: 'same root cause',
      sourceRunId: 'RUN-1',
      sourceTaskId: 'T-1',
      evidenceRefs: ['blob://probe-1'],
      clock,
      log: h.log,
      runId: 'RUN-1',
      taskId: 'T-1',
    };
    const first = proposeLessonFromHypothesis(input);
    const second = proposeLessonFromHypothesis(input);
    assert.ok(first !== null);
    assert.equal(second, null, 'repeat proposal is a no-op');
    assert.equal(h.log.all({ type: 'LESSON_PROPOSED' }).length, 1);
    assert.equal(listPendingProposals(readGovernanceLog(h.governanceLogPath)).length, 1);
  } finally {
    h.cleanup();
  }
});

test('a different statement or evidence yields a different lesson id (no false-idempotence)', () => {
  const h = harness();
  try {
    const a = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'cause A',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: ['blob://1'],
      clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    const b = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'cause B',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: ['blob://1'],
      clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    assert.ok(a !== null && b !== null);
    assert.notEqual(a?.id, b?.id);
  } finally {
    h.cleanup();
  }
});

test('promoteLesson moves pending/ -> approved/, stamps approvedAt, appends LESSON_APPROVED (REQ-11.2)', () => {
  const h = harness();
  try {
    const record = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'stmt',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [],
      clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    if (record === null) throw new Error('unreachable');

    const moved = promoteLesson({ dir: h.dir, lessonId: record.id, approvedAt: '2026-07-09T00:00:00.000Z', log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.equal(moved, true);
    assert.equal(existsSync(join(h.dir, 'pending', `${record.id}.json`)), false, 'no longer in pending/');
    assert.equal(existsSync(join(h.dir, 'approved', `${record.id}.json`)), true);

    const approved = h.log.all({ type: 'LESSON_APPROVED' });
    assert.equal(approved.length, 1);
    assert.equal(approved[0]?.payload['lessonId'], record.id);
  } finally {
    h.cleanup();
  }
});

test('promoteLesson is a no-op (false) when there is no pending file to move', () => {
  const h = harness();
  try {
    const moved = promoteLesson({ dir: h.dir, lessonId: 'lsn-does-not-exist', approvedAt: '2026-07-09T00:00:00.000Z', log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.equal(moved, false);
  } finally {
    h.cleanup();
  }
});

test('loadApprovedLessons reads ONLY approved/ — a pending-only lesson is structurally unloadable (REQ-12.1)', () => {
  const h = harness();
  try {
    proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'never approved',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [],
      clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    const loaded = loadApprovedLessons({ dir: h.dir, cap: { maxLessons: 5, maxBytes: 8192 }, log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.deepEqual(loaded, []);
  } finally {
    h.cleanup();
  }
});

test('offline-approval reconciler: a lesson_promote approved via the CLI while no run was live is moved + loaded on next call (REQ-11.3)', () => {
  const h = harness();
  try {
    const record = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'offline-approved lesson',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: ['blob://1'],
      clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    if (record === null) throw new Error('unreachable');

    // "CLI, no live run": approve directly via policy.ts, never through promoteLesson.
    const proposal = listPendingProposals(readGovernanceLog(h.governanceLogPath))[0];
    if (proposal === undefined) throw new Error('unreachable');
    approveProposal({ logPath: h.governanceLogPath, id: proposal.id, clock, decidedBy: 'human' });
    assert.equal(existsSync(join(h.dir, 'approved', `${record.id}.json`)), false, 'no live callback moved it yet');

    const loaded = loadApprovedLessons({
      dir: h.dir, governanceLogPath: h.governanceLogPath, cap: { maxLessons: 5, maxBytes: 8192 },
      log: h.log, runId: 'RUN-2', taskId: 'T-2',
    });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, record.id);
    assert.equal(existsSync(join(h.dir, 'approved', `${record.id}.json`)), true, 'reconciler moved the file');
    assert.equal(h.log.all({ type: 'LESSON_APPROVED' }).length, 1);

    // A second call never re-moves or re-appends (destination-exists idempotence).
    loadApprovedLessons({ dir: h.dir, governanceLogPath: h.governanceLogPath, cap: { maxLessons: 5, maxBytes: 8192 }, log: h.log, runId: 'RUN-2', taskId: 'T-2' });
    assert.equal(h.log.all({ type: 'LESSON_APPROVED' }).length, 1, 'reconciliation does not repeat');
  } finally {
    h.cleanup();
  }
});

test('a corrupt approved lesson file is skipped + ERROR-logged, other lessons still load (REQ-12.6)', () => {
  const h = harness();
  try {
    mkdirSync(join(h.dir, 'approved'), { recursive: true });
    writeFileSync(join(h.dir, 'approved', 'lsn-good.json'), JSON.stringify({
      id: 'lsn-good', statement: 'a valid lesson', sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [], proposedAt: '2026-07-09T00:00:00.000Z',
    }));
    writeFileSync(join(h.dir, 'approved', 'lsn-bad.json'), '{ not valid json');

    const loaded = loadApprovedLessons({ dir: h.dir, cap: { maxLessons: 5, maxBytes: 8192 }, log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.id, 'lsn-good');

    const errors = h.log.all({ type: 'ERROR' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.payload['reason'], 'corrupt_lesson_file');
  } finally {
    h.cleanup();
  }
});

test('cap truncates by count THEN cumulative bytes (REQ-12.5)', () => {
  const h = harness();
  try {
    mkdirSync(join(h.dir, 'approved'), { recursive: true });
    for (const id of ['lsn-a', 'lsn-b', 'lsn-c']) {
      writeFileSync(join(h.dir, 'approved', `${id}.json`), JSON.stringify({
        id, statement: 'x'.repeat(100), sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [], proposedAt: '2026-07-09T00:00:00.000Z',
      }));
    }
    const byCount = loadApprovedLessons({ dir: h.dir, cap: { maxLessons: 2, maxBytes: 8192 }, log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.equal(byCount.length, 2, 'count cap applied first');

    const byBytes = loadApprovedLessons({ dir: h.dir, cap: { maxLessons: 5, maxBytes: 150 }, log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.equal(byBytes.length, 1, 'byte cap stops after the first 100-byte statement (150 < 200)');
  } finally {
    h.cleanup();
  }
});

test('reconciler: a corrupt PENDING file is skipped + ERROR-logged, not thrown — other lessons still reconcile (PR #50 review, REQ-12.6)', () => {
  const h = harness();
  try {
    const good = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'good pending lesson',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: ['blob://good'], clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    const bad = proposeLessonFromHypothesis({
      dir: h.dir, governanceLogPath: h.governanceLogPath, statement: 'bad pending lesson',
      sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: ['blob://bad'], clock, log: h.log, runId: 'RUN-1', taskId: 'T-1',
    });
    if (good === null || bad === null) throw new Error('unreachable');

    // Approve BOTH offline (CLI, no live run) so the reconciler tries to move each.
    for (const p of listPendingProposals(readGovernanceLog(h.governanceLogPath))) {
      approveProposal({ logPath: h.governanceLogPath, id: p.id, clock, decidedBy: 'human' });
    }
    // Corrupt one pending file so promoteLesson's JSON.parse throws for it.
    writeFileSync(join(h.dir, 'pending', `${bad.id}.json`), '{ not valid json');

    const loaded = loadApprovedLessons({
      dir: h.dir, governanceLogPath: h.governanceLogPath, cap: { maxLessons: 5, maxBytes: 8192 },
      log: h.log, runId: 'RUN-2', taskId: 'T-2',
    });
    assert.deepEqual(loaded.map((l) => l.id), [good.id], 'the good lesson reconciles + loads despite the corrupt sibling');
    assert.ok(
      h.log.all({ type: 'ERROR' }).some((e) => e.payload['reason'] === 'corrupt_lesson_file'),
      'the corrupt pending file is ERROR-logged, the run is never blocked',
    );
  } finally {
    h.cleanup();
  }
});

test('an individually-oversized lesson is skipped, never suppressing every OTHER lesson (PR #50 review, REQ-12.5)', () => {
  const h = harness();
  try {
    mkdirSync(join(h.dir, 'approved'), { recursive: true });
    // 'lsn-aaa' sorts first (hash order == filename sort) and alone exceeds the byte
    // budget; the greedy `break` used to return [] and suppress b/c along with it.
    writeFileSync(join(h.dir, 'approved', 'lsn-aaa.json'), JSON.stringify({
      id: 'lsn-aaa', statement: 'x'.repeat(500), sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [], proposedAt: '2026-07-09T00:00:00.000Z',
    }));
    for (const id of ['lsn-bbb', 'lsn-ccc']) {
      writeFileSync(join(h.dir, 'approved', `${id}.json`), JSON.stringify({
        id, statement: 'y'.repeat(50), sourceRunId: 'RUN-1', sourceTaskId: 'T-1', evidenceRefs: [], proposedAt: '2026-07-09T00:00:00.000Z',
      }));
    }
    const loaded = loadApprovedLessons({ dir: h.dir, cap: { maxLessons: 5, maxBytes: 150 }, log: h.log, runId: 'RUN-1', taskId: 'T-1' });
    assert.deepEqual(loaded.map((l) => l.id), ['lsn-bbb', 'lsn-ccc'], 'the oversized first lesson is skipped, the rest still load');
    assert.ok(
      h.log.all({ type: 'ERROR' }).some((e) => e.payload['reason'] === 'oversized_lesson' && e.payload['lessonId'] === 'lsn-aaa'),
      'the oversized lesson is ERROR-logged by id',
    );
  } finally {
    h.cleanup();
  }
});

test('foldConfirmedHypotheses extracts statement/evidenceRef/runId/taskId, ignoring other event types', () => {
  const events = [
    { type: 'HYPOTHESIS_PROPOSED', runId: 'RUN-1', taskId: 'T-1', payload: { count: 1 } },
    { type: 'HYPOTHESIS_CONFIRMED', runId: 'RUN-1', taskId: 'T-1', payload: { statement: 'root cause X', evidenceRef: 'blob://a' } },
    { type: 'HYPOTHESIS_REFUTED', runId: 'RUN-1', taskId: 'T-1', payload: { statement: 'not it' } },
  ];
  const folded = foldConfirmedHypotheses(events);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0], { statement: 'root cause X', evidenceRefs: ['blob://a'], runId: 'RUN-1', taskId: 'T-1' });
});
