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
import { createRouter } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { PASS_FAIL_PROBES, type ConformanceRecord } from './protocol.ts';
import { createEvidenceStore, openEventLog } from 'core';
import type { ProposalInput, TaskContractExcerpt } from 'core';

const CONTRACT: TaskContractExcerpt = {
  goalId: 'G-1',
  title: 'fix',
  objective: '[probe:P2] make tests pass',
  acceptanceCriteria: [{ id: 'AC-1', description: 'impl correct' }],
};

function passingRecord(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'fake-1.0',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

function harness(opts: { seedFiles: Record<string, string>; adapter?: FakeAdapter; adapters?: FakeAdapter[]; register?: boolean }) {
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
    for (const a of adapters) reg.register(a, passingRecord(a.manifest().adapterId), a.healthProbe);
  }
  const router = createRouter(reg);
  let n = 0;
  const source = createAALProposalSource({
    runId: 'RUN-1',
    taskId: 'T-1',
    router,
    breaker,
    worktreeDir: worktree,
    taskContract: CONTRACT,
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
