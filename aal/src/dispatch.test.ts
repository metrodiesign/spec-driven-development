// Bounded dispatch (REQ-6.2/6.3/6.4): maxParallel cap, per-adapter bucket delay
// (never drop), per-item error capture (never fail the batch). Deterministic —
// injected sleep advances the bucket clock instead of waiting on the wall clock.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDispatcher, type DispatchItem } from './dispatch.ts';
import { createTokenBucket } from './ratelimit.ts';
import { AdapterError } from './protocol.ts';
import type { AdapterInterface, AgentRequest, AgentResponse, CapabilityManifest } from './protocol.ts';

function manifestOf(adapterId: string): CapabilityManifest {
  return { adapterId, structuredOutput: true, toolCalling: false, contextWindowTokens: 1000, executionBackend: false, determinism: 'seed' };
}

function respOf(adapterId: string): AgentResponse {
  return {
    structuredResult: { claim: 'WORKING' },
    actionRequests: [],
    usage: { costUnits: 1, raw: {} },
    rawTranscriptRef: null,
    adapterMeta: { adapterId, modelVersion: 'x', interactive: false, toolUseCount: 0 },
  };
}

function req(id: string): AgentRequest {
  return {
    requestId: id,
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective: 'o', acceptanceCriteria: [] },
    contextBundle: { pieces: [], canaryToken: 'C', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'blob://m',
    outputSchema: {},
    toolDefs: [],
    budget: { costUnits: 100 },
  };
}

/** An adapter whose send bumps a shared in-flight counter so concurrency is observable. */
function trackingAdapter(id: string, t: { inFlight: number; max: number }): AdapterInterface {
  return {
    manifest: () => manifestOf(id),
    async send() {
      t.inFlight += 1;
      t.max = Math.max(t.max, t.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      t.inFlight -= 1;
      return respOf(id);
    },
  };
}

test('keeps at most maxParallel sends in flight (REQ-6.2)', async () => {
  const tracker = { inFlight: 0, max: 0 };
  const a = trackingAdapter('a', tracker);
  const items: DispatchItem[] = Array.from({ length: 6 }, (_v, i) => ({ adapter: a, request: req(`r${i}`) }));
  const d = createDispatcher({ buckets: new Map(), maxParallel: 2 });
  const results = await d.dispatchAll(items);
  assert.equal(results.length, 6, 'every item resolved');
  assert.equal(tracker.max, 2, 'never more than maxParallel concurrent, and parallelism did happen');
});

test('an empty bucket delays the item until refill rather than dropping it (REQ-6.3)', async () => {
  let t = 0;
  const bucket = createTokenBucket({ capacity: 1, refillPerSec: 1 }, () => t);
  const a: AdapterInterface = { manifest: () => manifestOf('a'), send: () => Promise.resolve(respOf('a')) };
  const items: DispatchItem[] = [
    { adapter: a, request: req('r0') },
    { adapter: a, request: req('r1') },
  ];
  const d = createDispatcher({
    buckets: new Map([['a', bucket]]),
    maxParallel: 2,
    // The injected sleep advances the bucket clock so a waiting item eventually refills.
    sleep: async () => { t += 1000; },
  });
  const results = await d.dispatchAll(items);
  assert.equal(results.length, 2, 'both items dispatched — none dropped');
  assert.ok(results.every((r) => r.outcome.ok === true));
});

test('one item AdapterError is captured in its result, never thrown across the batch (REQ-6.4)', async () => {
  const good: AdapterInterface = { manifest: () => manifestOf('good'), send: () => Promise.resolve(respOf('good')) };
  const bad: AdapterInterface = {
    manifest: () => manifestOf('bad'),
    send: () => Promise.reject(new AdapterError('quota_limited', 'bad send')),
  };
  const items: DispatchItem[] = [
    { adapter: good, request: req('r0') },
    { adapter: bad, request: req('r1') },
    { adapter: good, request: req('r2') },
  ];
  const d = createDispatcher({ buckets: new Map(), maxParallel: 3 });
  const results = await d.dispatchAll(items); // must NOT reject
  assert.equal(results.length, 3);
  const failed = results.filter((r) => r.outcome.ok === false);
  assert.equal(failed.length, 1);
  const outcome = failed[0]?.outcome;
  assert.equal(outcome?.ok, false);
  if (outcome && outcome.ok === false) {
    assert.equal(outcome.error.kind, 'quota_limited');
  }
  assert.equal(results.filter((r) => r.outcome.ok === true).length, 2, 'the other items still succeeded');
});

test('governance ceiling clamps effective concurrency to min(maxParallel, ceiling) (phase5-stage2 REQ-4.2/6.9)', async () => {
  const tracker = { inFlight: 0, max: 0 };
  const a = trackingAdapter('a', tracker);
  const items: DispatchItem[] = Array.from({ length: 8 }, (_v, i) => ({ adapter: a, request: req(`r${i}`) }));
  const d = createDispatcher({ buckets: new Map(), maxParallel: 4, ceiling: 3 });
  assert.equal(d.effectiveMaxParallel, 3, 'resolved concurrency is readable for the composition guard');
  const results = await d.dispatchAll(items);
  assert.equal(results.length, 8, 'every item resolved');
  assert.equal(tracker.max, 3, 'the contract ceiling bound the fan-out');
});

test('ceiling absent or above maxParallel changes nothing (dormant, not dead)', () => {
  assert.equal(createDispatcher({ buckets: new Map(), maxParallel: 2 }).effectiveMaxParallel, 2);
  assert.equal(createDispatcher({ buckets: new Map(), maxParallel: 2, ceiling: 5 }).effectiveMaxParallel, 2);
  assert.equal(createDispatcher({ buckets: new Map(), maxParallel: 4, ceiling: 0 }).effectiveMaxParallel, 1, 'floor stays 1 — dispatcher never deadlocks');
});
