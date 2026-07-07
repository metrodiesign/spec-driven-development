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
import { createRegistry } from './registry.ts';
import { createRouter } from './router.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { PASS_FAIL_PROBES, type ConformanceRecord } from './protocol.ts';
import { createEvidenceStore, openEventLog } from 'core';
import type { ProposalInput, Role, TaskContractExcerpt } from 'core';

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

function harness(opts: { seedFiles: Record<string, string>; adapter?: FakeAdapter; register?: boolean }) {
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
  const reg = createRegistry();
  const adapter = opts.adapter ?? new FakeAdapter({ id: 'ok' });
  if (opts.register !== false) reg.register(adapter, passingRecord('ok'));
  const router = createRouter(reg);
  let n = 0;
  const source = createAALProposalSource({
    runId: 'RUN-1',
    taskId: 'T-1',
    role: 'implementer' as Role,
    router,
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
  return { root, log, source, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
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
