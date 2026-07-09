// AALProposalSource unit tests (REQ-5). Uses REAL core primitives (event log +
// evidence store) against a plain temp worktree — no git needed (buildContext
// reads files). Proves PROPOSAL_INTENT-before-send, provenance rejection,
// no_capacity, secret_in_context, and Proposal mapping.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createAALProposalSource } from './source.ts';
import { createBreaker, DEFAULT_BREAKER_OPTIONS } from './breaker.ts';
import { createRegistry } from './registry.ts';
import { createRouter, type RouteHints } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { PASS_FAIL_PROBES, type ConformanceRecord } from './protocol.ts';
import { createEvidenceStore, openEventLog } from 'core';
import type { ProposalInput, ProviderDataPolicy, TaskContractExcerpt } from 'core';

const CONTRACT: TaskContractExcerpt = {
  goalId: 'G-1',
  title: 'fix',
  objective: '[probe:P2] make tests pass',
  acceptanceCriteria: [{ id: 'AC-1', description: 'impl correct' }],
};

function passingRecord(id: string, susceptibilityScore = 0): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore, evidenceRef: 'blob://p7' },
  };
}

function harness(opts: {
  seedFiles: Record<string, string>;
  adapter?: FakeAdapter;
  adapters?: FakeAdapter[];
  register?: boolean;
  contract?: TaskContractExcerpt;
  dataPolicyFor?: (adapterId: string) => ProviderDataPolicy | undefined;
  routeHints?: (input: ProposalInput) => RouteHints;
  susceptibility?: number;
  lessons?: { dir: string; governanceLogPath?: string; maxLessons?: number; maxBytes?: number };
}) {
  const root = mkdtempSync(join(tmpdir(), 'src-'));
  const worktree = join(root, 'wt');
  for (const [rel, content] of Object.entries(opts.seedFiles)) {
    const abs = join(worktree, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const clock = { now: () => 1_000_000 };
  const log = openEventLog(join(root, 'events.db'), clock);
  const breaker = createBreaker(DEFAULT_BREAKER_OPTIONS, () => clock.now(), () => {});
  const reg = createRegistry({ breaker });
  const adapters = opts.adapters ?? [opts.adapter ?? new FakeAdapter({ id: 'ok' })];
  if (opts.register !== false) {
    for (const a of adapters) reg.register(a, passingRecord(a.manifest().adapterId, opts.susceptibility), a.healthProbe);
  }
  const router = createRouter(reg);
  let n = 0;
  const source = createAALProposalSource({
    runId: 'RUN-1',
    taskId: 'T-1',
    router,
    breaker,
    worktreeDir: worktree,
    taskContract: opts.contract ?? CONTRACT,
    seedPaths: Object.keys(opts.seedFiles),
    evidence,
    log,
    ids: { requestId: () => `req-${++n}`, canary: () => 'CANARY-fixed' },
    outputSchema: {
      type: 'object',
      required: ['claim', 'actionRequests'],
      properties: { claim: { type: 'string', enum: ['WORKING', 'READY_FOR_VERIFICATION', 'BLOCKED'] }, actionRequests: { type: 'array' } },
    },
    maxRepairRounds: 2,
    ...(opts.dataPolicyFor ? { dataPolicyFor: opts.dataPolicyFor } : {}),
    ...(opts.routeHints ? { routeHints: opts.routeHints } : {}),
    ...(opts.lessons ? { lessons: opts.lessons } : {}),
  });
  return { root, log, source, breaker, reg, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

const INPUT: ProposalInput = { taskId: 'T-1', state: 'IMPLEMENTING', role: 'implementer', feedback: null };

test('records PROPOSAL_INTENT before mapping a valid response to a Proposal (REQ-5.1/5.2/5.5)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION');
    assert.ok(p.actions.length >= 1);
    const intents = h.log.all({ type: 'PROPOSAL_INTENT' });
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.payload['requestId'], 'req-1');
    // CONTEXT_BUILT recorded with recall/waste counters (REQ-7.6).
    const built = h.log.all({ type: 'CONTEXT_BUILT' });
    assert.equal(built.length, 1);
    assert.equal(typeof built[0]?.payload['recall'], 'number');
  } finally {
    h.cleanup();
  }
});

test('rejects a WRITE to a path never in-bundle or READ as context_violation (REQ-5.4)', async () => {
  // Seed a DIFFERENT file; the compliant adapter writes src/impl.txt -> not allowed.
  const h = harness({ seedFiles: { 'src/seen.ts': 'export const x = 1;\n' } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.actions.length, 0, 'violating actions are not returned');
    const rej = h.log.all({ type: 'ACTION_REJECTED' });
    assert.equal(rej.length, 1);
    assert.equal(rej[0]?.payload['reason'], 'context_violation');
  } finally {
    h.cleanup();
  }
});

test('no eligible adapter -> BLOCKED(no_capacity), escalation logged, NO throw (REQ-6.2)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'x\n' }, register: false });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED');
    assert.equal(h.log.all({ type: 'ESCALATED' })[0]?.payload['why'], 'no_capacity');
  } finally {
    h.cleanup();
  }
});

test('a secret in a seeded file BLOCKS the build and escalates secret_in_context (REQ-7.3)', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const h = harness({ seedFiles: { 'src/impl.txt': 'ok\n', 'src/leak.ts': `const k = "${secret}";\n` } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED');
    const esc = h.log.all({ type: 'ESCALATED' })[0];
    assert.equal(esc?.payload['why'], 'secret_in_context');
    assert.ok(String(esc?.payload['file']).includes('leak.ts'));
  } finally {
    h.cleanup();
  }
});

/** Seed `<dir>/approved/<id>.json` directly — bypasses the propose->promote lifecycle (that's lessons.ts's own test coverage). */
function seedApprovedLesson(dir: string, overrides: { id: string; statement: string; evidenceRefs?: string[] }): void {
  mkdirSync(join(dir, 'approved'), { recursive: true });
  writeFileSync(
    join(dir, 'approved', `${overrides.id}.json`),
    JSON.stringify({
      id: overrides.id,
      statement: overrides.statement,
      sourceRunId: 'RUN-0',
      sourceTaskId: 'T-0',
      evidenceRefs: overrides.evidenceRefs ?? [],
      proposedAt: '2026-07-01T00:00:00.000Z',
      approvedAt: '2026-07-02T00:00:00.000Z',
    }),
  );
}

test('REQ-12: an approved lesson is injected into every round\'s context bundle and recorded as LESSON_INJECTED', async () => {
  const lessonsDir = mkdtempSync(join(tmpdir(), 'src-lessons-'));
  seedApprovedLesson(lessonsDir, { id: 'lsn-fixed', statement: 'watch for the off-by-one in the retry loop', evidenceRefs: ['blob://probe-9'] });
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, lessons: { dir: lessonsDir } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION', 'the round still succeeds with a lesson injected');
    const injected = h.log.all({ type: 'LESSON_INJECTED' });
    assert.equal(injected.length, 1);
    assert.deepEqual(injected[0]?.payload['ids'], ['lsn-fixed']);
    assert.deepEqual(injected[0]?.payload['refs'], ['blob://probe-9']);
    assert.equal(h.log.all({ type: 'ERROR' }).length, 0);
  } finally {
    h.cleanup();
    rmSync(lessonsDir, { recursive: true, force: true });
  }
});

test('REQ-12.3: a secret-bearing approved lesson is blocked + ERROR-logged, but the round is NOT aborted', async () => {
  const lessonsDir = mkdtempSync(join(tmpdir(), 'src-lessons-'));
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  seedApprovedLesson(lessonsDir, { id: 'lsn-secret', statement: `credential leaked: ${secret}` });
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, lessons: { dir: lessonsDir } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION', 'unlike a repo-file secret, a blocked LESSON never aborts the round');
    const errors = h.log.all({ type: 'ERROR' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.payload['reason'], 'lesson_secret_blocked');
    assert.equal(errors[0]?.payload['lessonId'], 'lsn-secret');
    assert.equal(h.log.all({ type: 'LESSON_INJECTED' }).length, 0, 'the blocked lesson never counted as an injection');
  } finally {
    h.cleanup();
    rmSync(lessonsDir, { recursive: true, force: true });
  }
});

test('AdapterError with no other eligible adapter -> BLOCKED(no_capacity, adapter_failure) (REQ-3.1/3.3)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter: new FakeAdapter({ id: 'ok', fault: 'throw_transport' }) });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED');
    const esc = h.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(esc?.payload['why'], 'no_capacity');
    assert.equal(esc?.payload['detail'], 'adapter_failure');
    assert.equal(esc?.payload['kind'], 'transport');
  } finally {
    h.cleanup();
  }
});

test('switch_to_next_eligible: first send fails, re-route ONCE to a second eligible succeeds (REQ-3.2)', async () => {
  const bad = new FakeAdapter({ id: 'bad', fault: 'throw_quota_limited' });
  const good = new FakeAdapter({ id: 'good' });
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapters: [bad, good] });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION', 're-route reached the healthy adapter');
    assert.ok(p.actions.length >= 1);
    // The survivor recorded a success and stays closed; the re-route did not escalate.
    assert.equal(h.breaker.state('good@fake-1.0'), 'closed');
    assert.equal(h.log.all({ type: 'ESCALATED' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('benign baseline: a compliant adapter never trips its breaker across a round (REQ-3.5)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION');
    assert.equal(h.breaker.state('ok@fake-1.0'), 'closed');
  } finally {
    h.cleanup();
  }
});

test('quota-unhealthy adapter is excluded from routing + emits QUOTA_PROBE (REQ-2.3/2.4)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter: new FakeAdapter({ id: 'ok', fault: 'health_unhealthy' }) });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED', 'no healthy adapter -> no_capacity');
    const probe = h.log.all({ type: 'QUOTA_PROBE' })[0];
    assert.equal(probe?.payload['ok'], false);
    assert.equal(probe?.payload['reason'], 'quota_threshold');
    assert.equal(probe?.payload['fiveHourPct'], 99);
    assert.equal(probe?.payload['estimate'], true, 'quota numbers are labeled estimates (INV-13)');
    // Excluded by health, not by an adapter send failure.
    assert.equal(h.log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'no_capacity');
    assert.equal(h.log.all({ type: 'ESCALATED' }).at(-1)?.payload['detail'], undefined);
  } finally {
    h.cleanup();
  }
});

const DATA_POLICY: ProviderDataPolicy = {
  allowPaths: ['src/**'],
  pathlessKinds: ['feedback', 'contract', 'guidance', 'patchPlan'],
};

test('a runtime injection canary trips -> CANARY_TRIPPED + round consumed, no actions (REQ-11.1)', async () => {
  // The contract's echo directive makes the compliant fake surface the round's
  // canary token in its structuredResult — the injection signature.
  const h = harness({
    seedFiles: { 'src/impl.txt': 'wrong\n' },
    contract: { ...CONTRACT, objective: '[probe:P2 echo=CANARY-fixed] make tests pass' },
  });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'WORKING', 'proposal rejected as structured feedback, round consumed');
    assert.equal(p.actions.length, 0, 'no actions executed from a tripped round');
    assert.equal(h.log.all({ type: 'CANARY_TRIPPED' }).length, 1);
    assert.equal(h.log.all({ type: 'CANARY_TRIPPED' })[0]?.payload['adapterId'], 'ok');
  } finally {
    h.cleanup();
  }
});

test('an out-of-policy context path escalates data_policy_violation and sends nothing (REQ-11.5)', async () => {
  const h = harness({
    seedFiles: { 'infra/creds.txt': 'secret\n' },
    dataPolicyFor: () => DATA_POLICY,
  });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED');
    assert.equal(p.costUnits, 0, 'nothing sent -> no cost');
    const viol = h.log.all({ type: 'DATA_POLICY_VIOLATION' })[0];
    assert.equal(viol?.payload['reason'], 'path_out_of_policy');
    assert.equal(viol?.payload['path'], 'infra/creds.txt');
    assert.equal(h.log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'data_policy_violation');
    // The send never completed: no CONTEXT_BUILT (logged only after a valid send).
    assert.equal(h.log.all({ type: 'CONTEXT_BUILT' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('a diagnostician round lifts the response into Proposal.hypotheses, not task actions (REQ-5.1 production)', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' } });
  try {
    const p = await h.source.propose({ taskId: 'T-1', state: 'DIAGNOSING', role: 'diagnostician', feedback: null });
    // The source produced hypotheses (core probes them) — NOT actions to execute (INV-1).
    assert.equal(p.actions.length, 0);
    assert.ok(Array.isArray(p.hypotheses));
    assert.equal(p.hypotheses?.length, 1);
    const hyp = p.hypotheses?.[0];
    assert.equal(typeof hyp?.statement, 'string');
    assert.equal(hyp?.probes[0]?.cmd, 'cat src/impl.txt');
    assert.equal(hyp?.probes[0]?.expected, 'wrong');
    assert.equal(typeof hyp?.ifConfirmed.patchPlan, 'string');
    // Still a real send — PROPOSAL_INTENT recorded, no provenance rejection.
    assert.equal(h.log.all({ type: 'PROPOSAL_INTENT' }).at(-1)?.payload['role'], 'diagnostician');
    assert.equal(h.log.all({ type: 'ACTION_REJECTED' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('an in-policy bundle is unaffected by the data policy (benign baseline, REQ-11.6)', async () => {
  const h = harness({
    seedFiles: { 'src/impl.txt': 'wrong\n' },
    dataPolicyFor: () => DATA_POLICY,
  });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION');
    assert.equal(h.log.all({ type: 'DATA_POLICY_VIOLATION' }).length, 0);
    assert.equal(h.log.all({ type: 'CONTEXT_BUILT' }).length, 1);
  } finally {
    h.cleanup();
  }
});

// --- Routing hints through the source (REQ-5.5 / REQ-5.6) ---

test('excludeLineages is a HARD rule: the only adapter, once excluded, yields BLOCKED — never silently reused (REQ-5.5)', async () => {
  const only = new FakeAdapter({ id: 'adapterB', lineage: 'familyB' });
  const h = harness({
    seedFiles: { 'src/impl.txt': 'wrong\n' },
    adapters: [only],
    // Mirrors the composition rule: test_designer must not share the implementer's lineage.
    routeHints: (input) => (input.role === 'test_designer' ? { excludeLineages: ['familyB'] } : {}),
  });
  try {
    // implementer round: no exclusion -> served.
    const impl = await h.source.propose(INPUT);
    assert.equal(impl.claim, 'READY_FOR_VERIFICATION', 'implementer unaffected by the hint');
    // test_designer round: the sole adapter's lineage is excluded -> clean BLOCKED, no fallback.
    const td = await h.source.propose({ taskId: 'T-1', state: 'IMPLEMENTING', role: 'test_designer', feedback: null });
    assert.equal(td.claim, 'BLOCKED', 'excluded lineage is never silently reused');
    assert.equal(h.log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'no_capacity');
    assert.equal(h.log.all({ type: 'ESCALATED' }).at(-1)?.payload['role'], 'test_designer');
  } finally {
    h.cleanup();
  }
});

test('maxSusceptibility cap is applied only when the bundle carries file pieces (REQ-5.6)', async () => {
  // A high-susceptibility (score 1) adapter, cap 0.5. WITH a seeded file piece the
  // cap filters it out -> BLOCKED. WITHOUT any file piece the cap is not applied.
  const capHint = (): RouteHints => ({ maxSusceptibility: 0.5 });

  const withFile = harness({
    seedFiles: { 'src/impl.txt': 'wrong\n' },
    adapter: new FakeAdapter({ id: 'risky' }),
    susceptibility: 1,
    routeHints: capHint,
  });
  try {
    const p = await withFile.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED', 'file piece present -> cap applied -> risky adapter excluded');
    assert.equal(withFile.log.all({ type: 'ESCALATED' }).at(-1)?.payload['why'], 'no_capacity');
  } finally {
    withFile.cleanup();
  }

  const noFile = harness({
    seedFiles: {}, // empty worktree -> bundle has no file pieces
    adapter: new FakeAdapter({ id: 'risky' }),
    susceptibility: 1,
    routeHints: capHint,
  });
  try {
    const p = await noFile.source.propose(INPUT);
    // Cap dropped -> the risky adapter WAS eligible and ran (its write is rejected as a
    // context_violation since nothing is in-bundle, but it was NOT blocked for no_capacity).
    assert.notEqual(p.claim, 'BLOCKED');
    assert.equal(noFile.log.all({ type: 'ESCALATED' }).length, 0, 'no no_capacity escalation — adapter was eligible');
  } finally {
    noFile.cleanup();
  }
});
