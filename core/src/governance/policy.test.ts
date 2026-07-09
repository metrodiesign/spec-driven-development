// RED (policy.ts throws NotImplemented) -> GREEN same task. REQ-9.
// Meta-governance engine: policy snapshot hashing, durable governance log at
// .ai/governance/events.jsonl, tamper->refuse, CLI-shaped approve->unblock,
// flaky_quarantine proposal (never auto), ci-fixture seeding.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  approveProposal,
  applyGovernanceApproval,
  computePolicySnapshot,
  ensureGovernanceApproved,
  listPendingProposals,
  pendingQuarantines,
  proposeFlakyQuarantine,
  proposeLessonPromotion,
  readGovernanceLog,
  seedFixtureSnapshot,
  snapshotHash,
} from './policy.ts';
import type { Clock } from '../types.ts';

const clock: Clock = { now: () => 1_700_000_000_000 };

/** A policy dir with a couple of the REQ-9.1 policy files written. */
function policyDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gov-'));
  const dir = join(root, 'policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gate-ladder.json'), JSON.stringify({ t0: { lint: 'pnpm lint' } }));
  writeFileSync(join(dir, 'security-plane.json'), JSON.stringify({ depManifestPatterns: ['package.json'] }));
  return dir;
}

function logPathIn(policyDirPath: string): string {
  // Sibling durable governance log (a fresh, non-existent path — empty log).
  return join(policyDirPath, '..', 'governance', 'events.jsonl');
}

function cleanup(policyDirPath: string): void {
  rmSync(join(policyDirPath, '..'), { recursive: true, force: true });
}

test('empty governance log -> policy_unapproved with beforeHash:null + records GOVERNANCE_PROPOSED + prints approve cmd (REQ-9.1/9.2)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const res = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('unreachable');
    assert.equal(res.reason, 'policy_unapproved');
    assert.equal(res.proposal.beforeHash, null);
    assert.equal(res.proposal.kind, 'policy_change');
    assert.equal(res.approveCommand, `platform governance approve ${res.proposal.id}`);

    // The proposal was persisted to the DURABLE log (survives checkout — REQ-9.1).
    const records = readGovernanceLog(logPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.type, 'GOVERNANCE_PROPOSED');
    assert.equal(records[0]?.id, res.proposal.id);
  } finally {
    cleanup(dir);
  }
});

test('re-running an unapproved run does not pile up duplicate proposals (idempotent GOVERNANCE_PROPOSED)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    const proposed = readGovernanceLog(logPath).filter((r) => r.type === 'GOVERNANCE_PROPOSED');
    assert.equal(proposed.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('approve unblocks: after GOVERNANCE_CHANGE the same snapshot passes (REQ-9.3)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const refused = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error('unreachable');

    const approved = approveProposal({ logPath, id: refused.proposal.id, clock, decidedBy: 'human' });
    assert.equal(approved.ok, true);
    if (!approved.ok) throw new Error('unreachable');
    assert.equal(approved.change.type, 'GOVERNANCE_CHANGE');
    assert.equal(approved.change.decidedBy, 'human');

    const now = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(now.ok, true);
  } finally {
    cleanup(dir);
  }
});

test('tampering with a policy file after approval refuses the next start (REQ-9.6)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const refused = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (refused.ok) throw new Error('unreachable');
    approveProposal({ logPath, id: refused.proposal.id, clock, decidedBy: 'human' });
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);

    // Loosen a gate silently -> snapshot hash changes -> refuse (conservative superset).
    writeFileSync(join(dir, 'gate-ladder.json'), JSON.stringify({ t0: { lint: 'true' } }));
    const after = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(after.ok, false);
    if (after.ok) throw new Error('unreachable');
    assert.notEqual(after.proposal.beforeHash, null); // now compares against the approved hash
  } finally {
    cleanup(dir);
  }
});

test('adding a not-yet-present policy file is itself a gated change (absent counts in the snapshot, REQ-9.6)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const refused = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (refused.ok) throw new Error('unreachable');
    approveProposal({ logPath, id: refused.proposal.id, clock, decidedBy: 'human' });

    // automation.json was 'absent' in the approved snapshot; creating it changes the hash.
    writeFileSync(join(dir, 'automation.json'), JSON.stringify({ defaultModel: 'sonnet' }));
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, false);
  } finally {
    cleanup(dir);
  }
});

test('routing.json / fusion-profiles.json joining POLICY_FILES makes creating them a governance event (REQ-8.3)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    // Approve the initial snapshot (routing.json + fusion-profiles.json ABSENT).
    const refused = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (refused.ok) throw new Error('unreachable');
    approveProposal({ logPath, id: refused.proposal.id, clock, decidedBy: 'human' });
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);

    // Creating routing.json flips it from ABSENT -> hashed => refuse until re-approved.
    writeFileSync(join(dir, 'routing.json'), JSON.stringify({ maxSusceptibility: 0.5 }));
    const afterRouting = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(afterRouting.ok, false, 'new routing.json is a governance event by construction');
    if (afterRouting.ok) throw new Error('unreachable');

    // Approve, then adding fusion-profiles.json refuses again (enabling fusion is gated).
    approveProposal({ logPath, id: afterRouting.proposal.id, clock, decidedBy: 'human' });
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);
    writeFileSync(join(dir, 'fusion-profiles.json'), JSON.stringify([]));
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, false);
  } finally {
    cleanup(dir);
  }
});

test('flakySuspect -> flaky_quarantine proposal, never auto; approval is required for quarantine (REQ-9.5)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const proposal = proposeFlakyQuarantine({ logPath, taskId: 'T-7', clock });
    assert.equal(proposal.kind, 'flaky_quarantine');
    assert.equal(proposal.taskId, 'T-7');

    // Proposed but NOT approved -> no quarantine takes effect (never automatic).
    assert.deepEqual(pendingQuarantines(readGovernanceLog(logPath)), []);
    assert.equal(listPendingProposals(readGovernanceLog(logPath)).some((p) => p.id === proposal.id), true);

    // Approve via CLI while no run is live -> deferred, recorded; next load sees the taskId.
    approveProposal({ logPath, id: proposal.id, clock, decidedBy: 'human' });
    assert.deepEqual(pendingQuarantines(readGovernanceLog(logPath)), ['T-7']);
  } finally {
    cleanup(dir);
  }
});

test('flaky_quarantine approval never changes the policy snapshot gate (kept out of lastApprovedHash)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const refused = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (refused.ok) throw new Error('unreachable');
    approveProposal({ logPath, id: refused.proposal.id, clock, decidedBy: 'human' });

    const flaky = proposeFlakyQuarantine({ logPath, taskId: 'T-9', clock });
    approveProposal({ logPath, id: flaky.id, clock, decidedBy: 'human' });

    // Policy snapshot still approved — the flaky change did not overwrite the policy hash.
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);
  } finally {
    cleanup(dir);
  }
});

test('applyGovernanceApproval fires quarantine for flaky_quarantine, never for policy_change (REQ-9.4)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const fired: string[] = [];
    const fireQuarantine = (taskId: string): void => {
      fired.push(taskId);
    };

    const policy = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (policy.ok) throw new Error('unreachable');
    const r1 = applyGovernanceApproval({ logPath, id: policy.proposal.id, clock }, { fireQuarantine });
    assert.equal(r1.ok, true);
    if (!r1.ok) throw new Error('unreachable');
    assert.equal(r1.kind, 'policy_change');
    assert.deepEqual(fired, []); // policy_change is append-only, never fires a transition

    const flaky = proposeFlakyQuarantine({ logPath, taskId: 'T-3', clock });
    const r2 = applyGovernanceApproval({ logPath, id: flaky.id, clock }, { fireQuarantine });
    assert.equal(r2.ok, true);
    assert.deepEqual(fired, ['T-3']);
  } finally {
    cleanup(dir);
  }
});

test('lesson_promote proposal carries lessonId through to the approved change record (REQ-11.1)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const proposal = proposeLessonPromotion({ logPath, lessonId: 'lsn-abc123', clock });
    assert.equal(proposal.kind, 'lesson_promote');
    assert.equal(proposal.lessonId, 'lsn-abc123');

    const approved = approveProposal({ logPath, id: proposal.id, clock, decidedBy: 'human' });
    assert.equal(approved.ok, true);
    if (!approved.ok) throw new Error('unreachable');
    assert.equal(approved.change.kind, 'lesson_promote');
    assert.equal(approved.change.lessonId, 'lsn-abc123');
  } finally {
    cleanup(dir);
  }
});

test('re-proposing the same lesson does not pile up duplicate proposals (idempotent, mirrors flaky_quarantine)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    proposeLessonPromotion({ logPath, lessonId: 'lsn-dup', clock });
    proposeLessonPromotion({ logPath, lessonId: 'lsn-dup', clock });
    const proposed = readGovernanceLog(logPath).filter((r) => r.type === 'GOVERNANCE_PROPOSED' && r.kind === 'lesson_promote');
    assert.equal(proposed.length, 1);
  } finally {
    cleanup(dir);
  }
});

test('lesson_promote approval never fires quarantine; flaky_quarantine approval never calls promoteLesson (REQ-9.4/11.2 dispatch is kind-exclusive)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const fired: string[] = [];
    const promoted: string[] = [];
    const hooks = { fireQuarantine: (taskId: string) => fired.push(taskId), promoteLesson: (lessonId: string) => promoted.push(lessonId) };

    const lesson = proposeLessonPromotion({ logPath, lessonId: 'lsn-9', clock });
    const r1 = applyGovernanceApproval({ logPath, id: lesson.id, clock }, hooks);
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.kind, 'lesson_promote');
    assert.deepEqual(promoted, ['lsn-9']);
    assert.deepEqual(fired, []);

    const flaky = proposeFlakyQuarantine({ logPath, taskId: 'T-5', clock });
    applyGovernanceApproval({ logPath, id: flaky.id, clock }, hooks);
    assert.deepEqual(fired, ['T-5']);
    assert.deepEqual(promoted, ['lsn-9'], 'flaky approval never re-triggers promoteLesson');
  } finally {
    cleanup(dir);
  }
});

test('applyGovernanceApproval without a promoteLesson hook still approves lesson_promote (hook is optional, REQ-11.2)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const lesson = proposeLessonPromotion({ logPath, lessonId: 'lsn-no-hook', clock });
    const res = applyGovernanceApproval({ logPath, id: lesson.id, clock }, { fireQuarantine: () => {} });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.kind, 'lesson_promote');
  } finally {
    cleanup(dir);
  }
});

test('unknown id -> no_such_proposal', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    const res = approveProposal({ logPath, id: 'gov-does-not-exist', clock, decidedBy: 'human' });
    assert.equal(res.ok, false);
    if (res.ok) throw new Error('unreachable');
    assert.equal(res.reason, 'no_such_proposal');
  } finally {
    cleanup(dir);
  }
});

test('ci-fixture seeding labels the change decidedBy:ci-fixture and unblocks the current snapshot (REQ-9.7)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    seedFixtureSnapshot({ policyDir: dir, logPath, clock });
    const change = readGovernanceLog(logPath).find((r) => r.type === 'GOVERNANCE_CHANGE');
    assert.equal(change?.type, 'GOVERNANCE_CHANGE');
    if (change?.type !== 'GOVERNANCE_CHANGE') throw new Error('unreachable');
    assert.equal(change.decidedBy, 'ci-fixture');
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);
  } finally {
    cleanup(dir);
  }
});

test('snapshot is deterministic and content-addressed (REQ-9.1)', () => {
  const dir = policyDir();
  try {
    const a = snapshotHash(computePolicySnapshot(dir));
    const b = snapshotHash(computePolicySnapshot(dir));
    assert.equal(a, b);
    writeFileSync(join(dir, 'security-plane.json'), JSON.stringify({ depManifestPatterns: ['package.json', 'go.mod'] }));
    assert.notEqual(snapshotHash(computePolicySnapshot(dir)), a);
  } finally {
    cleanup(dir);
  }
});
