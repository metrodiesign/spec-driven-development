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
import { PASS_FAIL_PROBES, type AdapterHealth, type AdapterInterface, type AgentRequest, type AgentResponse, type ConformanceRecord } from './protocol.ts';
import { createEvidenceStore, openEventLog } from 'core';
import type { Action, ProposalInput, ProviderDataPolicy, TaskContractExcerpt } from 'core';

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
  adapter?: AdapterInterface;
  adapters?: AdapterInterface[];
  register?: boolean;
  contract?: TaskContractExcerpt;
  dataPolicyFor?: (adapterId: string) => ProviderDataPolicy | undefined;
  routeHints?: (input: ProposalInput) => RouteHints;
  susceptibility?: number;
  lessons?: { dir: string; governanceLogPath?: string; maxLessons?: number; maxBytes?: number };
  plan?: { id: string; content: string };
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
    for (const a of adapters) {
      const healthProbe = (a as AdapterInterface & { healthProbe?: () => Promise<AdapterHealth> }).healthProbe;
      reg.register(a, passingRecord(a.manifest().adapterId, opts.susceptibility), healthProbe);
    }
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
    ...(opts.plan ? { plan: opts.plan } : {}),
  });
  return { root, log, evidence, source, breaker, reg, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

const INPUT: ProposalInput = { taskId: 'T-1', state: 'IMPLEMENTING', role: 'implementer', feedback: null };

function invalidUsageAdapter(costUnits: number): AdapterInterface {
  const response: AgentResponse = {
    structuredResult: { claim: 'WORKING', actionRequests: [] },
    actionRequests: [],
    usage: { costUnits, raw: {} },
    rawTranscriptRef: null,
    adapterMeta: { adapterId: 'invalid-usage', modelVersion: 'v', interactive: false, toolUseCount: 0 },
  };
  return {
    manifest: () => ({ adapterId: 'invalid-usage', structuredOutput: true, toolCalling: false, contextWindowTokens: 1000, executionBackend: false, determinism: 'none' }),
    async send() { return response; },
  };
}

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
    // Roundtrip (backlog: rejected-feedback, AC-4): the same rejection now reaches
    // the next round via Proposal.rejections, not just the log.
    assert.equal(p.rejections?.length, 1);
    assert.equal(p.rejections?.[0]?.reason, 'context_violation');
    assert.equal(p.rejections?.[0]?.detail, rej[0]?.payload['detail']);
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

test('invalid AAL usage escalates invalid_response and does not reroute or charge a proposal (REQ-7.1/7.4/7.5)', async () => {
  for (const costUnits of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const h = harness({ seedFiles: { 'src/impl.txt': 'x\n' }, adapter: invalidUsageAdapter(costUnits) });
    try {
      const p = await h.source.propose(INPUT);
      assert.equal(p.claim, 'BLOCKED');
      assert.equal(p.error?.reason, 'invalid_response');
      const esc = h.log.all({ type: 'ESCALATED' }).at(-1);
      assert.equal(esc?.payload['why'], 'invalid_response');
      assert.equal(h.log.all({ type: 'PROPOSAL_INTENT' }).length, 1);
    } finally {
      h.cleanup();
    }
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

test('REQ-16.5: a resolved plan is injected into the round\'s context bundle', async () => {
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, plan: { id: 'plan-T-1', content: 'do the fix carefully' } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION', 'the round still succeeds with a plan injected');
    const built = h.log.all({ type: 'CONTEXT_BUILT' })[0];
    const manifest = JSON.parse(h.evidence.getText(built?.payload['manifestRef'] as string)) as {
      rules: { pieceId: string; reason: string }[];
    };
    assert.ok(manifest.rules.some((r) => r.pieceId === 'plan-T-1' && r.reason === 'plan'), 'plan piece recorded in the context manifest');
    assert.equal(h.log.all({ type: 'ERROR' }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('a secret-bearing plan is blocked + ERROR-logged, but the round is NOT aborted', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, plan: { id: 'plan-T-1', content: `leaked: ${secret}` } });
  try {
    const p = await h.source.propose(INPUT);
    assert.equal(p.claim, 'READY_FOR_VERIFICATION', 'unlike a repo-file secret, a blocked PLAN never aborts the round');
    const errors = h.log.all({ type: 'ERROR' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.payload['reason'], 'plan_secret_blocked');
    assert.equal(errors[0]?.payload['planId'], 'plan-T-1');
  } finally {
    h.cleanup();
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

// --- Context accumulation: READ_FILE-requested paths seed next round's bundle ---

/**
 * A scripted adapter returning `actionsPerCall[call]` on the Nth `send()` (the
 * last entry repeats past the array's end) and recording every AgentRequest it
 * received — lets a test inspect what a LATER round's context bundle actually
 * carried (context-accumulation AC-1/AC-2/AC-4/AC-5/AC-7).
 */
function recordingAdapter(actionsPerCall: Action[][]): { adapter: AdapterInterface; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  let call = 0;
  const adapter: AdapterInterface = {
    manifest: () => ({
      adapterId: 'rec',
      structuredOutput: true,
      toolCalling: false,
      contextWindowTokens: 200_000,
      executionBackend: false,
      determinism: 'none',
    }),
    async send(req) {
      requests.push(req);
      const actionRequests = actionsPerCall[Math.min(call, actionsPerCall.length - 1)] ?? [];
      call += 1;
      return {
        structuredResult: { claim: 'WORKING', actionRequests },
        actionRequests,
        usage: { costUnits: 1, raw: {} },
        rawTranscriptRef: null,
        adapterMeta: { adapterId: 'rec', modelVersion: 'v', interactive: false, toolUseCount: 0 },
      };
    },
  };
  return { adapter, requests };
}

test("AC-1: a path READ_FILE-requested last round rides into next round's context bundle", async () => {
  const round1: Action[] = [{ type: 'READ_FILE', actionId: 'a-0', path: 'src/extra.txt' }];
  const { adapter, requests } = recordingAdapter([round1, []]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'src/extra.txt'), 'extra content\n');
    await h.source.propose(INPUT); // round 1: model asks READ_FILE src/extra.txt
    await h.source.propose(INPUT); // round 2: should now be seeded alongside src/impl.txt
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path);
    assert.ok(round2Paths?.includes('src/extra.txt'), `expected src/extra.txt in round-2 bundle, got ${JSON.stringify(round2Paths)}`);
  } finally {
    h.cleanup();
  }
});

test("AC-2: an absolute or traversal READ_FILE path is dropped, never accumulated into next round's seed", async () => {
  const round1: Action[] = [
    { type: 'READ_FILE', actionId: 'a-0', path: '../../outside.txt' },
    { type: 'READ_FILE', actionId: 'a-1', path: '/etc/passwd' },
  ];
  const { adapter, requests } = recordingAdapter([round1, []]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    await h.source.propose(INPUT);
    await h.source.propose(INPUT);
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.deepEqual(round2Paths, ['src/impl.txt'], 'only the seed path survives; neither traversal path was accumulated');
  } finally {
    h.cleanup();
  }
});

test('AC-4/AC-5: a secret in a seed path still aborts the whole bundle; a secret in an accumulated path is evicted and the build retried once', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');

  // AC-4 (regression guard): secret in a SEED path -> unchanged, whole-bundle abort.
  const seedCase = harness({ seedFiles: { 'src/impl.txt': 'ok\n', 'src/leak.ts': `const k = "${secret}";\n` } });
  try {
    const p = await seedCase.source.propose(INPUT);
    assert.equal(p.claim, 'BLOCKED');
    assert.equal(seedCase.log.all({ type: 'ESCALATED' })[0]?.payload['why'], 'secret_in_context');
  } finally {
    seedCase.cleanup();
  }

  // AC-5: secret in an ACCUMULATED path (READ_FILE-requested, not a seed) -> that
  // one path is evicted, the build retries once, and the round proceeds.
  const round1: Action[] = [{ type: 'READ_FILE', actionId: 'a-0', path: 'src/leak.ts' }];
  const round2: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-0', path: 'src/impl.txt', contentRef: 'blob://correct' }];
  const { adapter, requests } = recordingAdapter([round1, round2]);
  const accCase = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(accCase.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(accCase.root, 'wt', 'src/leak.ts'), `const k = "${secret}";\n`);
    const p1 = await accCase.source.propose(INPUT); // round 1: READ_FILE src/leak.ts (not yet a seed -> no scan)
    assert.notEqual(p1.claim, 'BLOCKED');
    const p2 = await accCase.source.propose(INPUT); // round 2: src/leak.ts is now accumulated -> secret hit -> evict + retry
    assert.notEqual(p2.claim, 'BLOCKED', 'an accumulated-path secret evicts that path but the round still proceeds');
    assert.equal(accCase.log.all({ type: 'ESCALATED' }).length, 0, 'no whole-bundle abort for an accumulated-path secret');
    const evicted = accCase.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 1);
    assert.ok(String(evicted[0]?.payload['file']).includes('leak.ts'));
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(!round2Paths.includes('src/leak.ts'), 'the secret-bearing accumulated path never reached the prompt');
  } finally {
    accCase.cleanup();
  }
});

test('AC-7: over the 20-path cap the oldest accumulated path is evicted; seedPaths are never evicted', async () => {
  const requestedPaths = Array.from({ length: 21 }, (_, i) => `src/gen-${i}.ts`);
  const round1: Action[] = requestedPaths.map((p, i) => ({ type: 'READ_FILE', actionId: `a-${i}`, path: p }));
  const { adapter, requests } = recordingAdapter([round1, []]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    for (const p of requestedPaths) writeFileSync(join(h.root, 'wt', p), `// ${p}\n`);
    await h.source.propose(INPUT); // round 1: 21 distinct READ_FILE requests
    await h.source.propose(INPUT); // round 2: cap kicks in
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(round2Paths.includes('src/impl.txt'), 'the seed path is never evicted');
    assert.ok(!round2Paths.includes('src/gen-0.ts'), `the oldest accumulated path should be evicted, got ${JSON.stringify(round2Paths)}`);
    assert.ok(round2Paths.includes('src/gen-20.ts'), 'the most recently requested path survives the cap');
    assert.equal(round2Paths.length, 21, '1 seed + the 20-path cap on accumulated paths');
  } finally {
    h.cleanup();
  }
});

test('AC-12: a secret reached only via EXPAND (neither seeded nor accumulated) is skipped as a single piece — the round now proceeds instead of aborting', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const { adapter, requests } = recordingAdapter([[]]);
  const h = harness({
    seedFiles: { 'src/impl.ts': `import { k } from './config.ts';\nexport const impl = 1;\n` },
    adapter,
  });
  try {
    // config.ts sits at the worktree root — never a seed path, never READ_FILE-requested —
    // reached ONLY via EXPAND from src/impl.ts's relative import (the audit's finding #1
    // repro). Before AC-12 this aborted the whole build (BLOCKED); now buildContext skips
    // just this one piece and the round proceeds.
    writeFileSync(join(h.root, 'wt', 'config.ts'), `export const k = "${secret}";\n`);
    const p = await h.source.propose(INPUT);
    assert.notEqual(p.claim, 'BLOCKED', 'AC-12: an EXPAND-only secret no longer kills the round');
    assert.equal(h.log.all({ type: 'ESCALATED' }).length, 0, 'no whole-run escalation');
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 0, 'the file was never accumulated (positive membership) — no eviction event either');
    assert.equal(requests.length, 1, 'the round now reaches adapter dispatch');
    const paths = requests[0]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(paths.includes('src/impl.ts'), 'the seed file itself is still included');
    assert.ok(!paths.includes('config.ts'), 'the EXPAND-derived secret-bearing file never reached the prompt');
  } finally {
    h.cleanup();
  }
});

test("AC-12: a secret reached via EXPAND from an ACCUMULATED (READ_FILE-requested) file is skipped — reproduces the audit's finding #1 repro", async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const round1: Action[] = [{ type: 'READ_FILE', actionId: 'a-0', path: 'test/auth.test.ts' }];
  const round2: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-0', path: 'src/impl.txt', contentRef: 'blob://correct' }];
  const { adapter, requests } = recordingAdapter([round1, round2]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'test'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'test/auth.test.ts'), `import '../src/auth.ts';\nexport const ok = true;\n`);
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'src/auth.ts'), `export const k = "${secret}";\n`);
    await h.source.propose(INPUT); // round 1: READ_FILE test/auth.test.ts (no secret in it)
    const p2 = await h.source.propose(INPUT); // round 2: test/auth.test.ts is now accumulated -> EXPAND to src/auth.ts -> secret
    assert.notEqual(p2.claim, 'BLOCKED', 'an EXPAND-derived secret reached from an accumulated file no longer kills the run');
    assert.equal(h.log.all({ type: 'ESCALATED' }).length, 0, 'no whole-run escalation');
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 0, 'src/auth.ts was never itself accumulated — no eviction event fires for it');
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(round2Paths.includes('test/auth.test.ts'), 'the accumulated path itself still made it into the bundle');
    assert.ok(!round2Paths.includes('src/auth.ts'), 'the EXPAND-derived secret-bearing file never reached the prompt');
  } finally {
    h.cleanup();
  }
});

test('AC-13: a secret in a path that is BOTH a literal seed and accumulated escalates immediately — no wasted rebuild, no false eviction event', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const round1: Action[] = [{ type: 'READ_FILE', actionId: 'a-0', path: 'src/impl.txt' }]; // model re-reads its own seed
  const { adapter, requests } = recordingAdapter([round1, []]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    const p1 = await h.source.propose(INPUT); // round 1: clean; src/impl.txt becomes accumulated too
    assert.notEqual(p1.claim, 'BLOCKED');
    // Between rounds, src/impl.txt (still a literal seed) picks up a secret — no
    // content caching (AC-3) means round 2's build reads it fresh.
    writeFileSync(join(h.root, 'wt', 'src/impl.txt'), `const k = "${secret}";\n`);
    const p2 = await h.source.propose(INPUT); // round 2: src/impl.txt is now in BOTH seedPaths and accumulated
    assert.equal(p2.claim, 'BLOCKED', 'seed-path secret still escalates, same as AC-4');
    const esc = h.log.all({ type: 'ESCALATED' });
    assert.equal(esc.length, 1);
    assert.equal(esc[0]?.payload['why'], 'secret_in_context');
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 0, 'AC-13: a seed-involved path is never evicted, even though it is also accumulated');
    assert.equal(requests.length, 1, 'round 2 never reached adapter dispatch — no wasted rebuild, no wasted send');
  } finally {
    h.cleanup();
  }
});

// --- AC-14: bounded drain — MORE than one accumulated-path secret hit in the same round ---

test('AC-14: two accumulated paths both hitting a secret in the SAME round both drain — the build succeeds instead of a second hit ending the run', async () => {
  // Reproduces the re-audit round-3 repro: two ordinary source files, no real
  // credential, that both trip the high-entropy heuristic (long, mixed-case,
  // mixed-digit identifiers) once accumulated. A single-retry drain (the pre-
  // AC-14 behavior) evicts only the FIRST hit and lets the second one escalate
  // and end the run; a bounded drain evicts both and the round proceeds.
  const round1: Action[] = [
    { type: 'READ_FILE', actionId: 'a-0', path: 'src/one.ts' },
    { type: 'READ_FILE', actionId: 'a-1', path: 'src/two.ts' },
  ];
  const round2: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-0', path: 'src/impl.txt', contentRef: 'blob://correct' }];
  const { adapter, requests } = recordingAdapter([round1, round2]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'src/one.ts'), 'export function verify(publicKeyHexDigest2048) { return publicKeyHexDigest2048.length > 0; }\n');
    writeFileSync(join(h.root, 'wt', 'src/two.ts'), 'export function check(sessionTokenBase64Payload77) { return sessionTokenBase64Payload77.length; }\n');
    await h.source.propose(INPUT); // round 1: READ_FILE both files (clean scan — not yet accumulated at scan time)
    const p2 = await h.source.propose(INPUT); // round 2: both now accumulated -> both trip the heuristic
    assert.notEqual(p2.claim, 'BLOCKED', 'AC-14: a second accumulated-path hit in the same round drains too, instead of ending the run');
    assert.equal(h.log.all({ type: 'ESCALATED' }).length, 0, 'no whole-run escalation');
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 2, 'both hits were drained, not just the first');
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(
      !round2Paths.includes('src/one.ts') && !round2Paths.includes('src/two.ts'),
      `neither false-positive file should reach the prompt, got ${JSON.stringify(round2Paths)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('AC-14 boundary: every accumulated path in the round hits a secret — the drain empties the set and the build still ends cleanly', async () => {
  const round1: Action[] = [
    { type: 'READ_FILE', actionId: 'a-0', path: 'src/one.ts' },
    { type: 'READ_FILE', actionId: 'a-1', path: 'src/two.ts' },
    { type: 'READ_FILE', actionId: 'a-2', path: 'src/three.ts' },
  ];
  const round2: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-0', path: 'src/impl.txt', contentRef: 'blob://correct' }];
  const { adapter, requests } = recordingAdapter([round1, round2]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'src/one.ts'), 'export function verify(publicKeyHexDigest2048) { return publicKeyHexDigest2048.length > 0; }\n');
    writeFileSync(join(h.root, 'wt', 'src/two.ts'), 'export function check(sessionTokenBase64Payload77) { return sessionTokenBase64Payload77.length; }\n');
    writeFileSync(join(h.root, 'wt', 'src/three.ts'), 'export function scan(refreshTokenOpaqueValue91) { return refreshTokenOpaqueValue91.length; }\n');
    await h.source.propose(INPUT); // round 1: READ_FILE all three (clean at accumulation time)
    const p2 = await h.source.propose(INPUT); // round 2: all three accumulated, all three trip the heuristic
    assert.notEqual(p2.claim, 'BLOCKED', 'the drain exhausts the whole accumulated set instead of blocking partway through');
    assert.equal(h.log.all({ type: 'ESCALATED' }).length, 0);
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 3, 'all three hits were drained — the loop did not stop short or hang');
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.deepEqual(round2Paths, ['src/impl.txt'], 'only the (clean) seed survives once the whole accumulated set has drained');
  } finally {
    h.cleanup();
  }
});

// --- must-fix: eviction drops a path from the SEED set, never from the WRITE_FILE allowlist ---

test('AC-5/must-fix: an accumulated path evicted for a scanner false positive keeps its WRITE_FILE provenance — a READ-then-WRITE of that same file is accepted, not a context_violation', async () => {
  // The write-allowlist is `bundle ∪ readRequested`. Eviction must drop the path
  // from the SEED set (so the build stops re-hitting the false positive) WITHOUT
  // removing it from readRequested — otherwise a file the model legitimately READ
  // becomes permanently unwritable. Reproduces the reviewer's probe: READ a file
  // that trips high-entropy, then WRITE that same file on the following rounds.
  const round1: Action[] = [{ type: 'READ_FILE', actionId: 'a-0', path: 'src/one.ts' }];
  const round2: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-1', path: 'src/one.ts', contentRef: 'blob://fix' }];
  const round3: Action[] = [{ type: 'WRITE_FILE', actionId: 'a-2', path: 'src/one.ts', contentRef: 'blob://fix2' }];
  const { adapter, requests } = recordingAdapter([round1, round2, round3]);
  const h = harness({ seedFiles: { 'src/impl.txt': 'wrong\n' }, adapter });
  try {
    mkdirSync(join(h.root, 'wt', 'src'), { recursive: true });
    writeFileSync(join(h.root, 'wt', 'src/one.ts'), 'export function verify(publicKeyHexDigest2048) { return publicKeyHexDigest2048.length > 0; }\n');
    await h.source.propose(INPUT); // round 1: READ_FILE src/one.ts (clean at scan time — not yet accumulated)
    const p2 = await h.source.propose(INPUT); // round 2: src/one.ts accumulated -> trips heuristic -> evicted from seed
    const p3 = await h.source.propose(INPUT); // round 3: still requested, still writable, no longer re-hit
    assert.notEqual(p2.claim, 'BLOCKED');
    assert.notEqual(p3.claim, 'BLOCKED');
    assert.equal(h.log.all({ type: 'ACTION_REJECTED' }).length, 0, 'the WRITE to the READ-then-evicted path is never a context_violation');
    const w2 = p2.actions[0];
    const w3 = p3.actions[0];
    assert.ok(w2?.type === 'WRITE_FILE' && w2.path === 'src/one.ts', `round-2 WRITE_FILE survives, got ${JSON.stringify(p2.actions)}`);
    assert.ok(w3?.type === 'WRITE_FILE' && w3.path === 'src/one.ts', `round-3 WRITE_FILE survives, got ${JSON.stringify(p3.actions)}`);
    // ...but the evicted path is kept OUT of the bundle (dropped from the seed).
    const round2Paths = requests[1]?.contextBundle.pieces.map((p) => p.path) ?? [];
    assert.ok(!round2Paths.includes('src/one.ts'), `the evicted path must not ride into the bundle, got ${JSON.stringify(round2Paths)}`);
    // ...and it is evicted ONCE for the run, not re-evicted on every later round
    // it stays requested (round 3's build no longer re-hits it — the by-product
    // the fix is meant to yield).
    const evicted = h.log.all({ type: 'ERROR' }).filter((e) => e.payload['reason'] === 'accumulated_secret_evicted');
    assert.equal(evicted.length, 1, 'evicted once for the run, not re-evicted every subsequent round');
  } finally {
    h.cleanup();
  }
});

// --- AC-15: the caller surfaces every builder-skipped piece on CONTEXT_BUILT ---

test('AC-15: CONTEXT_BUILT names every piece the builder skipped (EXPAND secret + containment) — path and kind only, never file content', async () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const outsideContent = 'top secret outside content';
  const h = harness({
    // FakeAdapter's compliant WRITE_FILE always targets src/impl.txt (fake-adapter.ts)
    // regardless of directive content — the seed name must match that, or the write
    // trips a context_violation and the round returns BEFORE the CONTEXT_BUILT log.
    seedFiles: {
      'src/impl.txt': [
        `import { k } from './config.ts';`, // EXPAND-only secret (AC-12) — never reached seedPaths/accumulated
        `import { LEAKED } from '../../outside/stolen.ts';`, // EXPAND resolving outside the worktree (AC-10)
        `wrong`,
      ].join('\n'),
    },
  });
  try {
    writeFileSync(join(h.root, 'wt', 'config.ts'), `export const k = "${secret}";\n`);
    mkdirSync(join(h.root, 'outside'), { recursive: true });
    writeFileSync(join(h.root, 'outside/stolen.ts'), `export const LEAKED = "${outsideContent}";\n`);
    const p = await h.source.propose(INPUT);
    assert.notEqual(p.claim, 'BLOCKED', 'neither skip aborts the round');
    const built = h.log.all({ type: 'CONTEXT_BUILT' })[0];
    const blocked = built?.payload['piecesBlocked'] as { path: string; kind: string }[] | undefined;
    assert.ok(Array.isArray(blocked), 'piecesBlocked is present on CONTEXT_BUILT');
    assert.ok(
      blocked?.some((b) => b.path === 'config.ts' && b.kind === 'sk-key'),
      `expected config.ts flagged sk-key, got ${JSON.stringify(blocked)}`,
    );
    assert.ok(
      blocked?.some((b) => b.path.includes('stolen.ts') && b.kind === 'containment'),
      `expected stolen.ts flagged containment, got ${JSON.stringify(blocked)}`,
    );
    const serialized = JSON.stringify(built?.payload);
    assert.ok(!serialized.includes(secret), 'no secret content leaked into the CONTEXT_BUILT payload');
    assert.ok(!serialized.includes(outsideContent), 'no out-of-worktree content leaked into the CONTEXT_BUILT payload');
  } finally {
    h.cleanup();
  }
});
