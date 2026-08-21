// RED (policy.ts throws NotImplemented) -> GREEN same task. REQ-9.
// Meta-governance engine: policy snapshot hashing, durable governance log at
// .ai/governance/events.jsonl, tamper->refuse, CLI-shaped approve->unblock,
// flaky_quarantine proposal (never auto), ci-fixture seeding.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BOOTSTRAP_POLICY_RATIONALE,
  POLICY_FILES,
  approveProposal,
  applyGovernanceApproval,
  computePolicySnapshot,
  ensureGovernanceApproved,
  governanceProposalId,
  listPendingProposals,
  pendingQuarantines,
  proposeFlakyQuarantine,
  proposeLessonPromotion,
  readGovernanceLog,
  seedFixtureSnapshot,
  snapshotHash,
  validateBootstrapGovernanceAppend,
  validateBootstrapPolicyBytes,
} from './policy.ts';
import type { Clock } from '../types.ts';

const clock: Clock = { now: () => 1_700_000_000_000 };

interface B0VerifierModule {
  AuthenticatedReadApi: new (input: {
    repository: { fullName: string };
    token: string;
    fetchImpl: () => Promise<never>;
  }) => { get(path: string): Promise<unknown> };
  expectedCiWorkflow(base: Uint8Array): Uint8Array;
  selectOperatorBinding(input: {
    pull: unknown;
    operatorAccount: unknown;
    operatorGithubLogin: string;
    requireMerged?: boolean;
  }): unknown;
  selectRulesetBinding(details: unknown[]): unknown;
  verifyCiWorkflowBytes(base: Uint8Array, head: Uint8Array): void;
  verifyExactOperations(files: unknown[]): void;
  verifyRequiredChecks(
    api: { repository: { owner: string; repo: string }; get(path: string, options?: unknown): Promise<unknown> },
    headSha: string,
    expectedChecks: { context: string; integrationId: number }[],
    mergedAt: string,
  ): Promise<unknown>;
}

async function b0Verifier(): Promise<B0VerifierModule> {
  const path = String(new URL('../../../.ai/bin/check-b0-bootstrap.mjs', import.meta.url));
  return await import(path) as unknown as B0VerifierModule;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function bootstrapGovernanceFixture(afterHash: string): { base: Buffer; head: Buffer } {
  const oldHash = '1'.repeat(64);
  const oldId = governanceProposalId('policy_change', null, oldHash);
  const base = Buffer.from(
    line({ type: 'GOVERNANCE_PROPOSED', ts: '2026-01-01T00:00:00.000Z', id: oldId, kind: 'policy_change', beforeHash: null, afterHash: oldHash, rationale: 'old' })
      + line({ type: 'GOVERNANCE_CHANGE', ts: '2026-01-01T00:00:01.000Z', id: oldId, kind: 'policy_change', beforeHash: null, afterHash: oldHash, rationale: 'old', decidedBy: 'human' }),
  );
  const id = governanceProposalId('policy_change', oldHash, afterHash);
  const appended = line({ type: 'GOVERNANCE_PROPOSED', ts: '2026-08-20T05:00:00.000Z', id, kind: 'policy_change', beforeHash: oldHash, afterHash, rationale: BOOTSTRAP_POLICY_RATIONALE })
    + line({ type: 'GOVERNANCE_CHANGE', ts: '2026-08-20T05:00:01.000Z', id, kind: 'policy_change', beforeHash: oldHash, afterHash, rationale: BOOTSTRAP_POLICY_RATIONALE, decidedBy: 'human' });
  return { base, head: Buffer.concat([base, Buffer.from(appended)]) };
}

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

test('adding/changing the outcomeRouting block in an already-approved routing.json requires re-approval (REQ-14.2)', () => {
  const dir = policyDir();
  const logPath = logPathIn(dir);
  try {
    writeFileSync(join(dir, 'routing.json'), JSON.stringify({ maxSusceptibility: 0.5 }));
    const initial = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    if (initial.ok) throw new Error('unreachable');
    approveProposal({ logPath, id: initial.proposal.id, clock, decidedBy: 'human' });
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);

    // Adding the outcomeRouting block (REQ-14.1) is itself a routing.json byte
    // change -> refuse until re-approved, same mechanism as any other policy edit.
    writeFileSync(join(dir, 'routing.json'), JSON.stringify({ maxSusceptibility: 0.5, outcomeRouting: { mode: 'shadow', epsilon: 10, minSamples: 20, minDivergences: 1 } }));
    const afterAdd = ensureGovernanceApproved({ policyDir: dir, logPath, clock });
    assert.equal(afterAdd.ok, false, 'adding the outcomeRouting block requires re-approval');
    if (afterAdd.ok) throw new Error('unreachable');

    // Flipping mode shadow -> active (activation, REQ-14.3) is ALSO a byte change -> refuse again.
    approveProposal({ logPath, id: afterAdd.proposal.id, clock, decidedBy: 'human' });
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, true);
    writeFileSync(join(dir, 'routing.json'), JSON.stringify({ maxSusceptibility: 0.5, outcomeRouting: { mode: 'active', epsilon: 10, minSamples: 20, minDivergences: 1 } }));
    assert.equal(ensureGovernanceApproved({ policyDir: dir, logPath, clock }).ok, false, 'shadow -> active activation requires re-approval too');
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

test('B0 policy is canonical, off, manual-only, and names one governed operator', () => {
  assert.deepEqual(POLICY_FILES, [
    'gate-ladder.json',
    'security-plane.json',
    'automation.json',
    'provider-data-policy.json',
    'routing.json',
    'fusion-profiles.json',
    'pr-quality-gate.json',
    'agent-capabilities.json',
  ]);
  const bytes = readFileSync(new URL('../../../.ai/policies/agent-capabilities.json', import.meta.url));
  const result = validateBootstrapPolicyBytes(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('unreachable');
  assert.equal(result.operatorGithubLogin, 'metrodiesign');

  const document = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  const invalid = [
    { ...document, mode: 'enforce' },
    { ...document, checkpoint: { autoApprove: true } },
    { ...document, governance: { mode: 'single-operator', operatorGithubLogin: '', requireIndependentGithubReview: false } },
    { ...document, governance: { mode: 'multi-operator', operatorGithubLogin: 'metrodiesign', requireIndependentGithubReview: false } },
    { ...document, governance: { mode: 'single-operator', operatorGithubLogin: 'metrodiesign', requireIndependentGithubReview: true } },
    { ...document, extraAuthority: true },
  ];
  for (const value of invalid) {
    assert.equal(validateBootstrapPolicyBytes(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)).ok, false);
  }
  assert.deepEqual(
    validateBootstrapPolicyBytes(Buffer.from(JSON.stringify(document))),
    { ok: false, reason: 'POLICY_NOT_CANONICAL' },
  );
});

test('B0 governance append accepts one exact pair and rejects prefix, chain, hash, duplicate, and extra records', () => {
  const afterHash = '2'.repeat(64);
  const { base, head } = bootstrapGovernanceFixture(afterHash);
  assert.equal(validateBootstrapGovernanceAppend({ baseBytes: base, headBytes: head, expectedAfterHash: afterHash }).ok, true);

  const prefixMutation = Buffer.from(head);
  prefixMutation[0] = prefixMutation[0] === 123 ? 91 : 123;
  assert.deepEqual(
    validateBootstrapGovernanceAppend({ baseBytes: base, headBytes: prefixMutation, expectedAfterHash: afterHash }),
    { ok: false, reason: 'LOG_PREFIX_MUTATED' },
  );
  assert.equal(validateBootstrapGovernanceAppend({ baseBytes: base, headBytes: head, expectedAfterHash: '3'.repeat(64) }).ok, false);
  assert.equal(validateBootstrapGovernanceAppend({ baseBytes: base, headBytes: Buffer.concat([head, Buffer.from(line({ id: 'extra' }))]), expectedAfterHash: afterHash }).ok, false);

  const changed = head.toString('utf8').replace(`"beforeHash":"${'1'.repeat(64)}"`, '"beforeHash":null');
  assert.equal(validateBootstrapGovernanceAppend({ baseBytes: base, headBytes: Buffer.from(changed), expectedAfterHash: afterHash }).ok, false);
  const duplicateBase = Buffer.concat([base, Buffer.from(base.subarray(0, base.indexOf(10) + 1))]);
  assert.deepEqual(
    validateBootstrapGovernanceAppend({ baseBytes: duplicateBase, headBytes: Buffer.concat([duplicateBase, head.subarray(base.length)]), expectedAfterHash: afterHash }),
    { ok: false, reason: 'LOG_DUPLICATE_ID' },
  );
});

function validRuleset(): Record<string, unknown> {
  return {
    id: 20737973,
    name: 'protected-main-develop',
    target: 'branch',
    source: 'owner/repo',
    source_type: 'Repository',
    enforcement: 'active',
    updated_at: '2026-08-20T04:00:00.000Z',
    conditions: { ref_name: { exclude: [], include: ['refs/heads/main', 'refs/heads/develop'] } },
    rules: [
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'B0 bootstrap authority', integration_id: 15368 },
            { context: 'guards + spec-trace', integration_id: 15368 },
          ],
        },
      },
    ],
  };
}

test('B0 external ruleset requires zero approvals, strict checks, squash-only, and no bypass', async () => {
  const verifier = await b0Verifier();
  const selected = verifier.selectRulesetBinding([validRuleset()]) as {
    binding: { requiredApprovingReviewCount: number; requireLastPushApproval: boolean; bypassActorCount: number };
  };
  assert.deepEqual(
    [selected.binding.requiredApprovingReviewCount, selected.binding.requireLastPushApproval, selected.binding.bypassActorCount],
    [0, false, 0],
  );
  for (const mutate of [
    (value: Record<string, unknown>): void => { value.enforcement = 'evaluate'; },
    (value: Record<string, unknown>): void => { value.bypass_actors = [{ actor_id: 1 }]; },
    (value: Record<string, unknown>): void => { ((value.rules as Record<string, unknown>[])[0]?.parameters as Record<string, unknown>).required_approving_review_count = 1; },
    (value: Record<string, unknown>): void => { ((value.rules as Record<string, unknown>[])[0]?.parameters as Record<string, unknown>).require_last_push_approval = true; },
    (value: Record<string, unknown>): void => { ((value.rules as Record<string, unknown>[])[0]?.parameters as Record<string, unknown>).allowed_merge_methods = ['merge', 'squash']; },
    (value: Record<string, unknown>): void => { ((value.rules as Record<string, unknown>[])[1]?.parameters as Record<string, unknown>).strict_required_status_checks_policy = false; },
    (value: Record<string, unknown>): void => { (((value.rules as Record<string, unknown>[])[1]?.parameters as Record<string, unknown>).required_status_checks as Record<string, unknown>[])[0] = { context: 'alternate' }; },
    (value: Record<string, unknown>): void => { delete (((value.rules as Record<string, unknown>[])[1]?.parameters as Record<string, unknown>).required_status_checks as Record<string, unknown>[])[0]?.integration_id; },
    (value: Record<string, unknown>): void => { (((value.rules as Record<string, unknown>[])[1]?.parameters as Record<string, unknown>).required_status_checks as Record<string, unknown>[]).push({ context: 'B0 bootstrap authority', integration_id: 15368 }); },
  ]) {
    const value = structuredClone(validRuleset());
    mutate(value);
    assert.throws(() => verifier.selectRulesetBinding([value]));
  }
});

test('B0 operator authority requires same canonical User for policy, author, and merge actor', async () => {
  const verifier = await b0Verifier();
  const head = 'a'.repeat(40);
  const pull = {
    number: 7,
    head: { sha: head },
    base: { ref: 'develop' },
    user: { login: 'metrodiesign', type: 'User' },
    merged_by: { login: 'metrodiesign', type: 'User' },
    merged_at: '2026-08-21T05:00:00.000Z',
  };
  const valid = {
    pull,
    operatorAccount: { login: 'metrodiesign', type: 'User', permissions: { push: true } },
    operatorGithubLogin: 'metrodiesign',
  };
  assert.doesNotThrow(() => verifier.selectOperatorBinding(valid));
  assert.doesNotThrow(() => verifier.selectOperatorBinding({ ...valid, requireMerged: true }));
  assert.throws(() => verifier.selectOperatorBinding({ ...valid, pull: { ...pull, user: { login: 'other', type: 'User' } } }));
  assert.throws(() => verifier.selectOperatorBinding({ ...valid, operatorAccount: { login: 'metrodiesign', type: 'Bot', permissions: { push: true } } }));
  assert.throws(() => verifier.selectOperatorBinding({ ...valid, operatorAccount: { login: 'metrodiesign', type: 'User', permissions: { push: false } } }));
  assert.throws(() => verifier.selectOperatorBinding({ ...valid, requireMerged: true, pull: { ...pull, merged_by: { login: 'other', type: 'User' } } }));
  assert.throws(() => verifier.selectOperatorBinding({ ...valid, requireMerged: true, pull: { ...pull, merged_by: { login: 'metrodiesign', type: 'Bot' } } }));
});

test('B0 exact file operations and CI composition reject seventh paths, renames, mutation, and replay', async () => {
  const verifier = await b0Verifier();
  const files = [
    ['.ai/policies/agent-capabilities.json', 'added'],
    ['core/src/governance/policy.ts', 'modified'],
    ['core/src/governance/policy.test.ts', 'modified'],
    ['.ai/governance/events.jsonl', 'modified'],
    ['.ai/bin/check-b0-bootstrap.mjs', 'added'],
    ['.github/workflows/ci.yml', 'modified'],
  ].map(([filename, status]) => ({ filename, status }));
  assert.doesNotThrow(() => verifier.verifyExactOperations(files));
  assert.throws(() => verifier.verifyExactOperations([...files, { filename: 'seventh', status: 'added' }]));
  assert.throws(() => verifier.verifyExactOperations(files.map((file, index) => index === 0 ? { ...file, previous_filename: 'old' } : file)));

  const base = Buffer.from('name: CI\npermissions:\n  contents: read\njobs:\n  existing:\n    runs-on: ubuntu-latest\n');
  const head = verifier.expectedCiWorkflow(base);
  assert.doesNotThrow(() => verifier.verifyCiWorkflowBytes(base, head));
  assert.throws(() => verifier.verifyCiWorkflowBytes(base, Buffer.concat([head, Buffer.from('# mutation\n')])));
  assert.throws(() => verifier.expectedCiWorkflow(head));
});

test('B0 authenticated API fails closed when network authority is unavailable', async () => {
  const verifier = await b0Verifier();
  const api = new verifier.AuthenticatedReadApi({
    repository: { fullName: 'owner/repo' },
    token: 'test-token',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  await assert.rejects(api.get('/rulesets'), (error: unknown) => (
    error instanceof Error && error.message.startsWith('API_UNAVAILABLE:')
  ));
});

test('B0 required status binds exact workflow, repository, app, head, and completion before merge', async () => {
  const verifier = await b0Verifier();
  const head = 'a'.repeat(40);
  const check = {
    id: 99,
    name: 'B0 bootstrap authority',
    head_sha: head,
    status: 'completed',
    conclusion: 'success',
    app: { id: 15368, slug: 'github-actions' },
    started_at: '2026-08-20T05:01:00.000Z',
    completed_at: '2026-08-20T05:02:00.000Z',
    details_url: 'https://github.com/owner/repo/actions/runs/55/job/66',
  };
  const workflow = {
    id: 55,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: head,
    run_attempt: 1,
    run_started_at: '2026-08-20T05:01:00.000Z',
  };
  const api = (checkValue: unknown, workflowValue: unknown) => ({
    repository: { owner: 'owner', repo: 'repo' },
    get: async (path: string): Promise<unknown> => path.startsWith('/commits/')
      ? { check_runs: [checkValue] }
      : workflowValue,
  });
  const expected = [{ context: 'B0 bootstrap authority', integrationId: 15368 }];
  const mergedAt = '2026-08-20T05:03:00.000Z';
  await assert.doesNotReject(verifier.verifyRequiredChecks(api(check, workflow), head, expected, mergedAt));
  await assert.rejects(verifier.verifyRequiredChecks(api({ ...check, app: { id: 1, slug: 'other' } }, workflow), head, expected, mergedAt));
  await assert.rejects(verifier.verifyRequiredChecks(api({ ...check, details_url: 'https://github.com/other/repo/actions/runs/55/job/66' }, workflow), head, expected, mergedAt));
  await assert.rejects(verifier.verifyRequiredChecks(api(check, { ...workflow, path: '.github/workflows/other.yml' }), head, expected, mergedAt));
  await assert.rejects(verifier.verifyRequiredChecks(api({ ...check, completed_at: '2026-08-20T05:04:00.000Z' }, workflow), head, expected, mergedAt));
  const duplicateApi = {
    repository: { owner: 'owner', repo: 'repo' },
    get: async (path: string): Promise<unknown> => path.startsWith('/commits/')
      ? { check_runs: [check, { ...check, id: 100 }] }
      : workflow,
  };
  await assert.rejects(verifier.verifyRequiredChecks(duplicateApi, head, expected, mergedAt));
});
