// Meta-governance (spec §9, REQ-9, INV-16). A run starts by hashing its policy
// inputs and comparing against the last approved snapshot in the DURABLE governance
// log — an append-only JSONL at `.ai/governance/events.jsonl`, committed to the repo
// (survives checkouts; git history doubles as the audit trail). A mismatch (or an
// empty log — first run, beforeHash:null) refuses the start (`policy_unapproved`) and
// records a GOVERNANCE_PROPOSED; a human approval appends GOVERNANCE_CHANGE. This
// gates ALL policy-file changes (a conservative superset of "loosening" — mechanical
// loosening detection is unsolvable, so tightening pays one extra approval). Flaky
// quarantine rides the same path but never fires automatically.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Clock } from '../types.ts';

export type GovernanceKind = 'policy_change' | 'flaky_quarantine' | 'lesson_promote';
export type DecidedBy = 'human' | 'ci-fixture';

/** REQ-9.1 policy inputs, in a fixed order. A file absent from the dir hashes as a
 *  distinct sentinel, so creating one later is itself a gated change (REQ-9.6). */
export const POLICY_FILES = [
  'gate-ladder.json',
  'security-plane.json',
  'automation.json',
  'provider-data-policy.json',
  // Phase 3 (REQ-8.3): routing + fusion knobs join the governance snapshot, so
  // enabling fusion or growing sched.scriptAllowlist is a human-approved event by
  // construction. Both hash as the ABSENT sentinel until the file is created —
  // creating one is itself a gated change (REQ-9.6).
  'routing.json',
  'fusion-profiles.json',
  'pr-quality-gate.json',
] as const;

/** sha256 hex is 64 chars, so this 6-char sentinel can never collide with a real file hash. */
const ABSENT = 'absent';

export interface PolicySnapshot {
  files: { path: string; sha256: string }[];
}

export interface GovernanceProposal {
  id: string;
  kind: GovernanceKind;
  beforeHash: string | null;
  afterHash: string;
  rationale: string;
  taskId?: string;
  /** `lesson_promote` only — `taskId` alone cannot identify which lesson file to move. */
  lessonId?: string;
}

interface GovernanceProposedRecord extends GovernanceProposal {
  type: 'GOVERNANCE_PROPOSED';
  ts: string;
}

export interface GovernanceChangeRecord {
  type: 'GOVERNANCE_CHANGE';
  ts: string;
  id: string;
  kind: GovernanceKind;
  beforeHash: string | null;
  afterHash: string;
  rationale: string;
  decidedBy: DecidedBy;
  taskId?: string;
  lessonId?: string;
}

export type GovernanceRecord = GovernanceProposedRecord | GovernanceChangeRecord;

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash the raw bytes of each REQ-9.1 policy file (missing => ABSENT sentinel). */
export function computePolicySnapshot(policyDir: string): PolicySnapshot {
  const files = POLICY_FILES.map((name) => {
    const p = join(policyDir, name);
    return { path: name, sha256: existsSync(p) ? sha256(readFileSync(p)) : ABSENT };
  });
  return { files };
}

/** Content-addressed snapshot hash — the single value compared across runs (REQ-9.1). */
export function snapshotHash(snapshot: PolicySnapshot): string {
  const canonical = [...snapshot.files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => `${f.path}:${f.sha256}`)
    .join('\n');
  return sha256(canonical);
}

export function readGovernanceLog(logPath: string): GovernanceRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GovernanceRecord);
}

function appendRecord(logPath: string, record: GovernanceRecord): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(record)}\n`);
}

function nowIso(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}

/** Deterministic id — re-proposing the same change yields the same id (idempotent, no RNG). */
function proposalId(kind: GovernanceKind, beforeHash: string | null, afterHash: string, taskId?: string): string {
  return `gov-${sha256([kind, beforeHash ?? 'null', afterHash, taskId ?? ''].join('\n')).slice(0, 16)}`;
}

/** The last APPROVED policy snapshot hash (flaky_quarantine changes never move it). */
function lastApprovedHash(records: GovernanceRecord[]): string | null {
  let hash: string | null = null;
  for (const r of records) {
    if (r.type === 'GOVERNANCE_CHANGE' && r.kind === 'policy_change') hash = r.afterHash;
  }
  return hash;
}

/** Proposals with no matching GOVERNANCE_CHANGE yet. */
export function listPendingProposals(records: GovernanceRecord[]): GovernanceProposal[] {
  const approved = new Set(records.filter((r) => r.type === 'GOVERNANCE_CHANGE').map((r) => r.id));
  const seen = new Set<string>();
  const pending: GovernanceProposal[] = [];
  for (const r of records) {
    if (r.type !== 'GOVERNANCE_PROPOSED' || approved.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    const { type: _t, ts: _ts, ...proposal } = r;
    pending.push(proposal);
  }
  return pending;
}

export interface EnsureInput {
  policyDir: string;
  logPath: string;
  clock: Clock;
  rationale?: string;
}

export type EnsureResult =
  | { ok: true; snapshotHash: string }
  | { ok: false; reason: 'policy_unapproved'; proposal: GovernanceProposal; approveCommand: string };

/**
 * Governance preflight (REQ-9.1/9.2): hash the policy inputs, compare to the last
 * approved snapshot. Match -> ok. Mismatch (or empty log) -> refuse, record a
 * GOVERNANCE_PROPOSED (idempotently), and hand back the exact approve command.
 */
export function ensureGovernanceApproved(input: EnsureInput): EnsureResult {
  const afterHash = snapshotHash(computePolicySnapshot(input.policyDir));
  const records = readGovernanceLog(input.logPath);
  const beforeHash = lastApprovedHash(records);
  if (beforeHash === afterHash) return { ok: true, snapshotHash: afterHash };

  const id = proposalId('policy_change', beforeHash, afterHash);
  const proposal: GovernanceProposal = {
    id,
    kind: 'policy_change',
    beforeHash,
    afterHash,
    rationale: input.rationale ?? 'policy snapshot changed',
  };
  const alreadyProposed = records.some((r) => r.type === 'GOVERNANCE_PROPOSED' && r.id === id);
  if (!alreadyProposed) {
    appendRecord(input.logPath, { type: 'GOVERNANCE_PROPOSED', ts: nowIso(input.clock), ...proposal });
  }
  return { ok: false, reason: 'policy_unapproved', proposal, approveCommand: `platform governance approve ${id}` };
}

/** REQ-11.1: a proposed lesson becomes a `lesson_promote` proposal — same idempotent shape as flaky_quarantine, never auto-approved. */
export function proposeLessonPromotion(input: {
  logPath: string;
  lessonId: string;
  clock: Clock;
  rationale?: string;
}): GovernanceProposal {
  const afterHash = `lesson:${input.lessonId}`;
  const id = proposalId('lesson_promote', null, afterHash, input.lessonId);
  const proposal: GovernanceProposal = {
    id,
    kind: 'lesson_promote',
    beforeHash: null,
    afterHash,
    rationale: input.rationale ?? `lesson ${input.lessonId} proposed for promotion`,
    lessonId: input.lessonId,
  };
  const records = readGovernanceLog(input.logPath);
  if (!records.some((r) => r.type === 'GOVERNANCE_PROPOSED' && r.id === id)) {
    appendRecord(input.logPath, { type: 'GOVERNANCE_PROPOSED', ts: nowIso(input.clock), ...proposal });
  }
  return proposal;
}

/** REQ-9.5: a flakySuspect gate result becomes a proposal — quarantine NEVER auto-fires. */
export function proposeFlakyQuarantine(input: {
  logPath: string;
  taskId: string;
  clock: Clock;
  rationale?: string;
}): GovernanceProposal {
  const afterHash = `flaky:${input.taskId}`;
  const id = proposalId('flaky_quarantine', null, afterHash, input.taskId);
  const proposal: GovernanceProposal = {
    id,
    kind: 'flaky_quarantine',
    beforeHash: null,
    afterHash,
    rationale: input.rationale ?? `flaky gate suspected for task ${input.taskId}`,
    taskId: input.taskId,
  };
  const records = readGovernanceLog(input.logPath);
  if (!records.some((r) => r.type === 'GOVERNANCE_PROPOSED' && r.id === id)) {
    appendRecord(input.logPath, { type: 'GOVERNANCE_PROPOSED', ts: nowIso(input.clock), ...proposal });
  }
  return proposal;
}

export type ApproveResult =
  | { ok: true; change: GovernanceChangeRecord }
  | { ok: false; reason: 'no_such_proposal' };

/** REQ-9.3/9.4: append a GOVERNANCE_CHANGE for a pending proposal (usable with no server). */
export function approveProposal(input: {
  logPath: string;
  id: string;
  clock: Clock;
  decidedBy: DecidedBy;
}): ApproveResult {
  const records = readGovernanceLog(input.logPath);
  const proposal = listPendingProposals(records).find((p) => p.id === input.id);
  if (proposal === undefined) return { ok: false, reason: 'no_such_proposal' };
  const change: GovernanceChangeRecord = {
    type: 'GOVERNANCE_CHANGE',
    ts: nowIso(input.clock),
    id: proposal.id,
    kind: proposal.kind,
    beforeHash: proposal.beforeHash,
    afterHash: proposal.afterHash,
    rationale: proposal.rationale,
    decidedBy: input.decidedBy,
    ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
    ...(proposal.lessonId !== undefined ? { lessonId: proposal.lessonId } : {}),
  };
  appendRecord(input.logPath, change);
  return { ok: true, change };
}

/**
 * REQ-9.4/11.2 by-kind approval: `policy_change` is append-only (never fires a
 * transition); `flaky_quarantine` fires the quarantine transition for its taskId;
 * `lesson_promote` moves the lesson file pending/ -> approved/ + LESSON_APPROVED.
 * Both transitions are composition callbacks (the machine/file move + live run
 * wiring live in console/backend). `promoteLesson` is optional so a caller that
 * predates the lessons pipeline (existing tests) keeps working unchanged.
 */
export function applyGovernanceApproval(
  input: { logPath: string; id: string; clock: Clock },
  hooks: { fireQuarantine(taskId: string): void; promoteLesson?(lessonId: string): void },
): { ok: true; kind: GovernanceKind } | { ok: false; reason: 'no_such_proposal' } {
  const res = approveProposal({ logPath: input.logPath, id: input.id, clock: input.clock, decidedBy: 'human' });
  if (!res.ok) return res;
  if (res.change.kind === 'flaky_quarantine' && res.change.taskId !== undefined) {
    hooks.fireQuarantine(res.change.taskId);
  }
  if (res.change.kind === 'lesson_promote' && res.change.lessonId !== undefined) {
    hooks.promoteLesson?.(res.change.lessonId);
  }
  return { ok: true, kind: res.change.kind };
}

/** REQ-9.5 deferred quarantine: taskIds with an APPROVED flaky_quarantine — applied when the run next loads them. */
export function pendingQuarantines(records: GovernanceRecord[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of records) {
    if (r.type === 'GOVERNANCE_CHANGE' && r.kind === 'flaky_quarantine' && r.taskId !== undefined && !seen.has(r.taskId)) {
      seen.add(r.taskId);
      out.push(r.taskId);
    }
  }
  return out;
}

/** REQ-9.7: seed an approved snapshot for a CI/test fixture — labeled, never claimed human. */
export function seedFixtureSnapshot(input: { policyDir: string; logPath: string; clock: Clock }): GovernanceChangeRecord {
  const records = readGovernanceLog(input.logPath);
  const afterHash = snapshotHash(computePolicySnapshot(input.policyDir));
  const change: GovernanceChangeRecord = {
    type: 'GOVERNANCE_CHANGE',
    ts: nowIso(input.clock),
    id: proposalId('policy_change', lastApprovedHash(records), afterHash),
    kind: 'policy_change',
    beforeHash: lastApprovedHash(records),
    afterHash,
    rationale: 'ci-fixture approved snapshot',
    decidedBy: 'ci-fixture',
  };
  appendRecord(input.logPath, change);
  return change;
}
