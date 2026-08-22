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
    repository: { owner?: string; repo?: string; fullName: string };
    token: string;
    fetchImpl: (...args: unknown[]) => Promise<unknown>;
  }) => {
    get(path: string): Promise<unknown>;
    pages(path: string, key?: string | null, options?: { requireStableKeyedCollection?: boolean }): Promise<unknown[]>;
  };
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
    api: B0ReadApi,
    headSha: string,
    expectedChecks: { context: string; integrationId: number }[],
    mergedAt: string,
  ): Promise<unknown>;
  verifyCurrentRun(
    api: B0ReadApi,
    context: { runId: string | number },
    authority: unknown,
  ): Promise<{ run: Record<string, unknown>; sourceCheckRunId: number }>;
}

interface B0ReadApi {
  repository: { owner: string; repo: string; fullName?: string };
  get(path: string, options?: unknown): Promise<unknown>;
  pages(path: string, key?: string | null, options?: { requireStableKeyedCollection?: boolean }): Promise<unknown[]>;
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

const B0_HEAD = 'a'.repeat(40);
const B0_CONTEXT = 'B0 bootstrap authority';
const B0_EXPECTED = [{ context: B0_CONTEXT, integrationId: 15368 }];
const B0_MERGED_AT = '2026-08-20T12:44:32.000Z';

function b0Check({
  id,
  completedAt,
  conclusion = 'success',
  context = B0_CONTEXT,
  runId = id + 10_000,
  jobId = id + 20_000,
}: {
  id: number;
  completedAt: string;
  conclusion?: string;
  context?: string;
  runId?: number;
  jobId?: number;
}): Record<string, unknown> {
  return {
    id,
    name: context,
    head_sha: B0_HEAD,
    status: 'completed',
    conclusion,
    app: { id: 15368, slug: 'github-actions' },
    started_at: completedAt,
    completed_at: completedAt,
    details_url: `https://github.com/owner/repo/actions/runs/${runId}/job/${jobId}`,
  };
}

function b0Workflow(runId: number, runAttempt = 1): Record<string, unknown> {
  return {
    id: runId,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    event: 'pull_request',
    head_sha: B0_HEAD,
    run_attempt: runAttempt,
    run_started_at: '2026-08-20T05:00:00.000Z',
  };
}

function b0Job(jobId: number, runId: number, context = B0_CONTEXT): Record<string, unknown> {
  return { id: jobId, run_id: runId, name: context, head_sha: B0_HEAD };
}

function detailsIds(check: Record<string, unknown>): { runId: number; jobId: number } | null {
  const match = /\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(String(check.details_url));
  return match === null ? null : { runId: Number(match[1]), jobId: Number(match[2]) };
}

function b0FixtureApi(
  checks: Record<string, unknown>[],
  options: {
    workflows?: Record<number, Record<string, unknown>>;
    jobs?: Record<string, Record<string, unknown>[]>;
    sourceChecks?: Record<number, Record<string, unknown>>;
    failGet?: string;
    failPages?: string;
  } = {},
): B0ReadApi & { requests: string[] } {
  const workflows = { ...(options.workflows ?? {}) };
  const jobs = { ...(options.jobs ?? {}) };
  for (const check of checks) {
    const ids = detailsIds(check);
    if (ids === null) continue;
    workflows[ids.runId] ??= b0Workflow(ids.runId);
    jobs[`${ids.runId}:1`] ??= [b0Job(ids.jobId, ids.runId, String(check.name))];
  }
  const requests: string[] = [];
  return {
    repository: { owner: 'owner', repo: 'repo', fullName: 'owner/repo' },
    requests,
    get: async (path: string): Promise<unknown> => {
      requests.push(path);
      if (options.failGet !== undefined && path.startsWith(options.failGet)) {
        throw Object.assign(new Error(`GET failed: ${path}`), { code: 'API_REJECTED' });
      }
      const workflowMatch = /^\/actions\/runs\/(\d+)$/.exec(path);
      if (workflowMatch !== null) return workflows[Number(workflowMatch[1])];
      const checkMatch = /^\/check-runs\/(\d+)$/.exec(path);
      if (checkMatch !== null) return options.sourceChecks?.[Number(checkMatch[1])];
      throw new Error(`unexpected GET ${path}`);
    },
    pages: async (path: string): Promise<unknown[]> => {
      requests.push(path);
      if (options.failPages !== undefined && path.startsWith(options.failPages)) {
        throw Object.assign(new Error(`pages failed: ${path}`), { code: 'API_REJECTED' });
      }
      if (path.startsWith('/commits/')) return structuredClone(checks);
      const attemptMatch = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path);
      if (attemptMatch !== null) return structuredClone(jobs[`${attemptMatch[1]}:${attemptMatch[2]}`] ?? []);
      throw new Error(`unexpected pages ${path}`);
    },
  };
}

function b0Error(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
}

function fakeResponse(payload: unknown): Record<string, unknown> {
  return {
    ok: true,
    status: 200,
    headers: { get: (): null => null },
    text: async (): Promise<string> => JSON.stringify(payload),
  };
}

test('B0 authenticated keyed pagination proves completeness and a stable first page (REQ-1.9/1.10/2.13/2.19/2.20/3.10)', async () => {
  const verifier = await b0Verifier();
  const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  const payloads = [
    { total_count: 101, check_runs: pageOne },
    { total_count: 101, check_runs: [{ id: 101 }] },
    { total_count: 101, check_runs: pageOne },
  ];
  const api = new verifier.AuthenticatedReadApi({
    repository: { owner: 'owner', repo: 'repo', fullName: 'owner/repo' },
    token: 'test-token',
    fetchImpl: async (): Promise<unknown> => fakeResponse(payloads.shift()),
  });
  const rows = await api.pages('/commits/head/check-runs?filter=all', 'check_runs', { requireStableKeyedCollection: true });
  assert.equal(rows.length, 101);

  const unstable: { name: string; payloads: unknown[] }[] = [
    {
      name: 'total_count changes',
      payloads: [{ total_count: 101, check_runs: pageOne }, { total_count: 102, check_runs: [{ id: 101 }] }],
    },
    {
      name: 'row id repeats',
      payloads: [{ total_count: 2, check_runs: [{ id: 1 }, { id: 1 }] }],
    },
    {
      name: 'collected row count differs',
      payloads: [{ total_count: 2, check_runs: [{ id: 1 }] }],
    },
    {
      name: 'first page changes during probe',
      payloads: [{ total_count: 1, check_runs: [{ id: 1 }] }, { total_count: 1, check_runs: [{ id: 2 }] }],
    },
  ];
  for (const scenario of unstable) {
    const queue = [...scenario.payloads];
    const unstableApi = new verifier.AuthenticatedReadApi({
      repository: { owner: 'owner', repo: 'repo', fullName: 'owner/repo' },
      token: 'test-token',
      fetchImpl: async (): Promise<unknown> => fakeResponse(queue.shift()),
    });
    await assert.rejects(
      unstableApi.pages('/checks', 'check_runs', { requireStableKeyedCollection: true }),
      b0Error('API_COLLECTION_CHANGED'),
      scenario.name,
    );
  }

  const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }));
  let page = 0;
  const boundedApi = new verifier.AuthenticatedReadApi({
    repository: { owner: 'owner', repo: 'repo', fullName: 'owner/repo' },
    token: 'test-token',
    fetchImpl: async (): Promise<unknown> => {
      const rowsForPage = fullPage.map((row) => ({ id: row.id + page * 100 }));
      page += 1;
      return fakeResponse({ total_count: 1_000, check_runs: rowsForPage });
    },
  });
  await assert.rejects(
    boundedApi.pages('/checks', 'check_runs', { requireStableKeyedCollection: true }),
    b0Error('API_PAGE_LIMIT'),
  );
});

test('B0 PR #146 fixture selects latest pre-merge authority and ignores API order (REQ-1/4.1-4.6)', async () => {
  const verifier = await b0Verifier();
  const checks = [
    b0Check({ id: 96_699_751_150, completedAt: '2026-08-20T07:21:40.000Z', conclusion: 'failure' }),
    b0Check({ id: 96_721_505_730, completedAt: '2026-08-20T08:58:29.000Z' }),
    b0Check({ id: 96_751_293_734, completedAt: '2026-08-20T11:06:19.000Z' }),
  ];
  const expected = [{
    checkRunId: 96_751_293_734,
    name: B0_CONTEXT,
    headSha: B0_HEAD,
    conclusion: 'SUCCESS',
    appId: 15368,
    appSlug: 'github-actions',
    workflowRunId: 96_751_303_734,
    runAttempt: 1,
    completedAt: '2026-08-20T11:06:19.000Z',
  }];
  const api = b0FixtureApi(checks);
  assert.deepEqual(await verifier.verifyRequiredChecks(api, B0_HEAD, B0_EXPECTED, B0_MERGED_AT), expected);
  assert.equal(api.requests.some((path) => path.includes('check_name=B0%20bootstrap%20authority&filter=all')), true);
  assert.equal(api.requests.some((path) => path.includes('filter=latest')), false);
  assert.deepEqual(await verifier.verifyRequiredChecks(b0FixtureApi([...checks].reverse()), B0_HEAD, B0_EXPECTED, B0_MERGED_AT), expected);
});

test('B0 post-merge selection blocks latest failure, post-merge rows, ties, and missing authority (REQ-1.2/1.4/1.8/2.12/4.7/4.8)', async () => {
  const verifier = await b0Verifier();
  const older = b0Check({ id: 1, completedAt: '2026-08-20T08:00:00.000Z' });
  const latestFailure = b0Check({ id: 2, completedAt: '2026-08-20T09:00:00.000Z', conclusion: 'failure' });
  await assert.rejects(
    verifier.verifyRequiredChecks(b0FixtureApi([older, latestFailure]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
    b0Error('CHECK_SUCCESS_MISSING'),
  );

  const afterMerge = b0Check({ id: 3, completedAt: '2026-08-20T13:00:00.000Z' });
  const selected = await verifier.verifyRequiredChecks(b0FixtureApi([afterMerge, older]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT) as { checkRunId: number }[];
  assert.equal(selected[0]?.checkRunId, 1);

  const tied = b0Check({ id: 4, completedAt: '2026-08-20T08:00:00.000Z' });
  await assert.rejects(
    verifier.verifyRequiredChecks(b0FixtureApi([older, tied]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
    b0Error('CHECK_SET_INVALID'),
  );
  const newest = b0Check({ id: 5, completedAt: '2026-08-20T10:00:00.000Z' });
  await assert.rejects(
    verifier.verifyRequiredChecks(b0FixtureApi([newest, older, tied]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
    b0Error('CHECK_SET_INVALID'),
  );
  await assert.rejects(
    verifier.verifyRequiredChecks(b0FixtureApi([]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
    b0Error('CHECK_SUCCESS_MISSING'),
  );
});

test('B0 candidate field and provenance mutations never displace older valid authority (REQ-2.1-2.11/4.9/4.10)', async () => {
  const verifier = await b0Verifier();
  const older = b0Check({ id: 10, completedAt: '2026-08-20T08:00:00.000Z' });
  const newest = b0Check({ id: 20, completedAt: '2026-08-20T09:00:00.000Z' });
  const preliminaryMutations: [string, (value: Record<string, unknown>) => void][] = [
    ['name', (value) => { value.name = 'other'; }],
    ['head', (value) => { value.head_sha = 'b'.repeat(40); }],
    ['status', (value) => { value.status = 'in_progress'; }],
    ['app id', (value) => { value.app = { id: 1, slug: 'github-actions' }; }],
    ['app slug', (value) => { value.app = { id: 15368, slug: 'other' }; }],
    ['completed time', (value) => { value.completed_at = 'invalid'; }],
    ['details URL', (value) => { value.details_url = 'https://github.com/other/repo/actions/runs/1/job/2'; }],
  ];
  for (const [name, mutate] of preliminaryMutations) {
    const invalid = structuredClone(newest);
    mutate(invalid);
    const evidence = await verifier.verifyRequiredChecks(b0FixtureApi([invalid, older]), B0_HEAD, B0_EXPECTED, B0_MERGED_AT) as { checkRunId: number }[];
    assert.equal(evidence[0]?.checkRunId, 10, name);
  }

  const newestIds = detailsIds(newest);
  if (newestIds === null) throw new Error('fixture source missing');
  const workflowMutations: [string, (value: Record<string, unknown>) => void][] = [
    ['path', (value) => { value.path = '.github/workflows/other.yml'; }],
    ['name', (value) => { value.name = 'Other'; }],
    ['event', (value) => { value.event = 'push'; }],
    ['head', (value) => { value.head_sha = 'b'.repeat(40); }],
    ['run attempt', (value) => { value.run_attempt = 0; }],
  ];
  for (const [name, mutate] of workflowMutations) {
    const invalidWorkflow = b0Workflow(newestIds.runId);
    mutate(invalidWorkflow);
    const evidence = await verifier.verifyRequiredChecks(
      b0FixtureApi([newest, older], { workflows: { [newestIds.runId]: invalidWorkflow } }),
      B0_HEAD,
      B0_EXPECTED,
      B0_MERGED_AT,
    ) as { checkRunId: number }[];
    assert.equal(evidence[0]?.checkRunId, 10, name);
  }

  const jobMutations: [string, (value: Record<string, unknown>) => void][] = [
    ['job run id', (value) => { value.run_id = 999; }],
    ['job name', (value) => { value.name = 'other'; }],
    ['job head', (value) => { value.head_sha = 'b'.repeat(40); }],
  ];
  for (const [name, mutate] of jobMutations) {
    const invalidJob = b0Job(newestIds.jobId, newestIds.runId);
    mutate(invalidJob);
    const evidence = await verifier.verifyRequiredChecks(
      b0FixtureApi([newest, older], { jobs: { [`${newestIds.runId}:1`]: [invalidJob] } }),
      B0_HEAD,
      B0_EXPECTED,
      B0_MERGED_AT,
    ) as { checkRunId: number }[];
    assert.equal(evidence[0]?.checkRunId, 10, name);
  }
});

test('B0 exact job ID binds one attempt and lookup bounds fail closed (REQ-2.13-2.20/4.2-4.4)', async () => {
  const verifier = await b0Verifier();
  const check = b0Check({ id: 30, completedAt: '2026-08-20T09:00:00.000Z', runId: 55, jobId: 66 });
  const workflow = b0Workflow(55, 2);
  const attemptTwoApi = b0FixtureApi([check], {
    workflows: { 55: workflow },
    jobs: { '55:1': [], '55:2': [b0Job(66, 55)] },
  });
  const evidence = await verifier.verifyRequiredChecks(attemptTwoApi, B0_HEAD, B0_EXPECTED, B0_MERGED_AT) as { runAttempt: number }[];
  assert.equal(evidence[0]?.runAttempt, 2);

  for (const jobs of [
    { '55:1': [], '55:2': [] },
    { '55:1': [b0Job(66, 55)], '55:2': [b0Job(66, 55)] },
  ]) {
    await assert.rejects(
      verifier.verifyRequiredChecks(b0FixtureApi([check], { workflows: { 55: workflow }, jobs }), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
      b0Error('CHECK_SOURCE_MISMATCH'),
    );
  }

  await assert.rejects(
    verifier.verifyRequiredChecks(
      b0FixtureApi([check], { workflows: { 55: b0Workflow(55, 26) } }),
      B0_HEAD,
      B0_EXPECTED,
      B0_MERGED_AT,
    ),
    b0Error('API_LOOKUP_LIMIT'),
  );

  const manyChecks = Array.from({ length: 5 }, (_, index) => b0Check({
    id: 100 + index,
    completedAt: `2026-08-20T0${index + 1}:00:00.000Z`,
    runId: 200 + index,
    jobId: 300 + index,
  }));
  const workflows = Object.fromEntries(manyChecks.map((row) => {
    const ids = detailsIds(row);
    if (ids === null) throw new Error('fixture source missing');
    return [ids.runId, b0Workflow(ids.runId, 25)];
  }));
  await assert.rejects(
    verifier.verifyRequiredChecks(b0FixtureApi(manyChecks, { workflows }), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
    b0Error('API_LOOKUP_LIMIT'),
  );

  for (const options of [
    { failPages: '/commits/' },
    { failGet: '/actions/runs/' },
    { failPages: '/actions/runs/' },
  ]) {
    await assert.rejects(
      verifier.verifyRequiredChecks(b0FixtureApi([check], options), B0_HEAD, B0_EXPECTED, B0_MERGED_AT),
      b0Error('API_REJECTED'),
    );
  }
});

test('B0 contexts resolve independently and evidence preserves canonical binding order (REQ-1.5-1.7/4.1-4.5/4.11/4.13)', async () => {
  const verifier = await b0Verifier();
  const guardContext = 'guards + spec-trace';
  const checks = [
    b0Check({ id: 40, completedAt: '2026-08-20T09:00:00.000Z', context: guardContext }),
    b0Check({ id: 41, completedAt: '2026-08-20T10:00:00.000Z' }),
  ];
  const api = b0FixtureApi(checks);
  const evidence = await verifier.verifyRequiredChecks(
    api,
    B0_HEAD,
    [{ context: B0_CONTEXT, integrationId: 15368 }, { context: guardContext, integrationId: 15368 }],
    B0_MERGED_AT,
  ) as { name: string }[];
  assert.deepEqual(evidence.map((row) => row.name), [B0_CONTEXT, guardContext]);
  assert.equal('write' in api, false);
  assert.equal(api.requests.some((path) => !path.startsWith('/')), false);
});

test('B0 pr-head reads only current-attempt jobs and validates exact current source (REQ-3/4.12)', async () => {
  const verifier = await b0Verifier();
  const authority = {
    headSha: B0_HEAD,
    ruleset: {
      updatedAt: '2026-08-20T04:00:00.000Z',
      binding: { requiredStatusChecks: B0_EXPECTED },
    },
  };
  const source = {
    id: 66,
    name: B0_CONTEXT,
    head_sha: B0_HEAD,
    status: 'in_progress',
    app: { id: 15368, slug: 'github-actions' },
  };
  const validApi = b0FixtureApi([], {
    workflows: { 55: b0Workflow(55, 2) },
    jobs: { '55:2': [b0Job(66, 55)] },
    sourceChecks: { 66: source },
  });
  const current = await verifier.verifyCurrentRun(validApi, { runId: 55 }, authority);
  assert.equal(current.sourceCheckRunId, 66);
  assert.equal(validApi.requests.includes('/actions/runs/55/attempts/2/jobs'), true);
  assert.equal(validApi.requests.some((path) => path.includes('/jobs?filter=all')), false);

  for (const rows of [[], [b0Job(66, 55), b0Job(67, 55)]]) {
    await assert.rejects(
      verifier.verifyCurrentRun(
        b0FixtureApi([], { workflows: { 55: b0Workflow(55, 2) }, jobs: { '55:2': rows }, sourceChecks: { 66: source } }),
        { runId: 55 },
        authority,
      ),
      b0Error('SOURCE_CHECK_AMBIGUOUS'),
    );
  }

  const sourceMutations: [string, (value: Record<string, unknown>) => void][] = [
    ['head', (value) => { value.head_sha = 'b'.repeat(40); }],
    ['status', (value) => { value.status = 'completed'; }],
    ['app id', (value) => { value.app = { id: 1, slug: 'github-actions' }; }],
    ['app slug', (value) => { value.app = { id: 15368, slug: 'other' }; }],
  ];
  for (const [name, mutate] of sourceMutations) {
    const invalid = structuredClone(source);
    mutate(invalid);
    await assert.rejects(
      verifier.verifyCurrentRun(
        b0FixtureApi([], {
          workflows: { 55: b0Workflow(55, 2) },
          jobs: { '55:2': [b0Job(66, 55)] },
          sourceChecks: { 66: invalid },
        }),
        { runId: 55 },
        authority,
      ),
      b0Error('CHECK_SOURCE_MISMATCH'),
      name,
    );
  }
});
