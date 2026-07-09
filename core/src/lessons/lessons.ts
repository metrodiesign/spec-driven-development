// Lessons pipeline (spec §10.4, REQ-10/11/12). A confirmed repair hypothesis
// becomes a PENDING lesson; it can only ever be injected into a future prompt
// after a human approves its paired `lesson_promote` governance proposal
// (INV-16 — the system cannot teach itself). Injection itself happens through
// core's context-builder pipeline (`context/builder.ts`), never a free-text
// post-build append, so a lesson is GOVERNed (secret-scanned) and MARKed like
// any other untrusted data.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { proposeLessonPromotion, readGovernanceLog } from '../governance/policy.ts';
import type { EventLog } from '../state/event-log.ts';
import type { Clock, LessonRecord } from '../types.ts';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** REQ-10.2: content-addressed — re-proposing the same statement+evidence is idempotent. */
function deriveLessonId(statement: string, evidenceRefs: string[]): string {
  return `lsn-${sha256([statement, ...evidenceRefs].join('\n')).slice(0, 16)}`;
}

function pendingPath(dir: string, id: string): string {
  return join(dir, 'pending', `${id}.json`);
}

function approvedPath(dir: string, id: string): string {
  return join(dir, 'approved', `${id}.json`);
}

export interface ConfirmedHypothesis {
  statement: string;
  evidenceRefs: string[];
  runId: string;
  taskId: string;
}

/**
 * REQ-10.1: fold a run's event log for confirmed-hypothesis verdicts. Called
 * POST-RUN by the composition (the orchestrator/hypothesis engine themselves
 * are untouched — core-produced events are the only interface). Each
 * `HYPOTHESIS_CONFIRMED` event's own confirming probe ref is the evidence.
 */
export function foldConfirmedHypotheses(
  events: { type: string; runId: string; taskId: string | null; payload: Record<string, unknown> }[],
): ConfirmedHypothesis[] {
  const out: ConfirmedHypothesis[] = [];
  for (const e of events) {
    if (e.type !== 'HYPOTHESIS_CONFIRMED' || e.taskId === null) continue;
    const evidenceRef = e.payload['evidenceRef'];
    out.push({
      statement: String(e.payload['statement'] ?? ''),
      evidenceRefs: evidenceRef !== undefined ? [String(evidenceRef)] : [],
      runId: e.runId,
      taskId: e.taskId,
    });
  }
  return out;
}

/**
 * REQ-10.1/10.2/10.3: write `.ai/lessons/pending/<id>.json`, append
 * `LESSON_PROPOSED`, and raise the `lesson_promote` governance proposal
 * carrying `lessonId`. A statement already proposed (pending or approved)
 * is a no-op — `null` — never a duplicate file or proposal.
 */
export function proposeLessonFromHypothesis(input: {
  dir: string;
  governanceLogPath: string;
  statement: string;
  sourceRunId: string;
  sourceTaskId: string;
  evidenceRefs: string[];
  clock: Clock;
  log: EventLog;
  runId: string;
  taskId: string;
}): LessonRecord | null {
  const id = deriveLessonId(input.statement, input.evidenceRefs);
  if (existsSync(pendingPath(input.dir, id)) || existsSync(approvedPath(input.dir, id))) {
    return null;
  }
  const record: LessonRecord = {
    id,
    statement: input.statement,
    sourceRunId: input.sourceRunId,
    sourceTaskId: input.sourceTaskId,
    evidenceRefs: input.evidenceRefs,
    proposedAt: new Date(input.clock.now()).toISOString(),
  };
  mkdirSync(join(input.dir, 'pending'), { recursive: true });
  writeFileSync(pendingPath(input.dir, id), JSON.stringify(record));
  input.log.append({
    runId: input.runId,
    taskId: input.taskId,
    type: 'LESSON_PROPOSED',
    payload: {
      lessonId: id,
      statement: input.statement,
      sourceRunId: input.sourceRunId,
      sourceTaskId: input.sourceTaskId,
      evidenceRefs: input.evidenceRefs,
    },
  });
  proposeLessonPromotion({
    logPath: input.governanceLogPath,
    lessonId: id,
    clock: input.clock,
    rationale: `lesson ${id} proposed from a confirmed hypothesis (run ${input.sourceRunId}, task ${input.sourceTaskId})`,
  });
  return record;
}

/**
 * REQ-11.2/11.3: move `pending/<id>.json` -> `approved/<id>.json` (stamping
 * `approvedAt`) and append `LESSON_APPROVED`. Same function whether triggered
 * LIVE (the Human Plane approval callback) or by the OFFLINE reconciler in
 * `loadApprovedLessons` below — a no-op (`false`) if there is no pending file
 * left to move (already reconciled by an earlier call, or never existed).
 */
export function promoteLesson(input: {
  dir: string;
  lessonId: string;
  approvedAt: string;
  log: EventLog;
  runId: string;
  taskId: string;
}): boolean {
  const from = pendingPath(input.dir, input.lessonId);
  if (!existsSync(from)) return false;
  const record = JSON.parse(readFileSync(from, 'utf8')) as LessonRecord;
  record.approvedAt = input.approvedAt;
  mkdirSync(join(input.dir, 'approved'), { recursive: true });
  writeFileSync(approvedPath(input.dir, input.lessonId), JSON.stringify(record));
  unlinkSync(from);
  input.log.append({
    runId: input.runId,
    taskId: input.taskId,
    type: 'LESSON_APPROVED',
    payload: { lessonId: input.lessonId },
  });
  return true;
}

/**
 * REQ-12.1/12.6: load lessons EXCLUSIVELY from `approved/` — a pending or
 * rejected lesson is structurally unloadable, since it is never read here.
 * REQ-11.3 offline-approval reconciler: before loading, sweep the durable
 * governance log for `lesson_promote` approvals whose file the LIVE callback
 * never got to move (approved via the CLI while no run was live) — mirrors
 * `pendingQuarantines`' deferred-quarantine pattern, but the move (not just a
 * transition) happens right here since it is plain file IO. A corrupt JSON
 * file is skipped + `ERROR`-logged, never blocking the run (REQ-12.6).
 */
export function loadApprovedLessons(input: {
  dir: string;
  governanceLogPath?: string;
  cap: { maxLessons: number; maxBytes: number };
  log: EventLog;
  runId: string;
  taskId: string;
}): LessonRecord[] {
  if (input.governanceLogPath !== undefined) {
    for (const r of readGovernanceLog(input.governanceLogPath)) {
      if (r.type !== 'GOVERNANCE_CHANGE' || r.kind !== 'lesson_promote' || r.lessonId === undefined) continue;
      if (existsSync(approvedPath(input.dir, r.lessonId))) continue; // already reconciled
      promoteLesson({ dir: input.dir, lessonId: r.lessonId, approvedAt: r.ts, log: input.log, runId: input.runId, taskId: input.taskId });
    }
  }

  const approvedDir = join(input.dir, 'approved');
  if (!existsSync(approvedDir)) return [];
  const records: LessonRecord[] = [];
  for (const file of readdirSync(approvedDir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(readFileSync(join(approvedDir, file), 'utf8')) as LessonRecord);
    } catch {
      input.log.append({ runId: input.runId, taskId: input.taskId, type: 'ERROR', payload: { reason: 'corrupt_lesson_file', file } });
    }
  }

  // REQ-12.5: cap by count, then by cumulative bytes.
  const byCount = records.slice(0, input.cap.maxLessons);
  const capped: LessonRecord[] = [];
  let bytes = 0;
  for (const r of byCount) {
    const size = Buffer.byteLength(r.statement, 'utf8');
    if (bytes + size > input.cap.maxBytes) break;
    capped.push(r);
    bytes += size;
  }
  return capped;
}
