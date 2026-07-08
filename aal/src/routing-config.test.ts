// routing.json loader (REQ-8.2): type-guarded fallbacks that NEVER LOOSEN — a
// malformed field falls back to the strict default, never a looser value.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_ROUTING_CONFIG, loadRoutingConfig, parseRoutingConfig } from './routing-config.ts';

test('a well-formed file loads verbatim (REQ-8.2)', () => {
  const cfg = parseRoutingConfig({
    maxSusceptibility: 0.5,
    maxParallel: 2,
    tokenBuckets: { adapterA: { capacity: 4, refillPerSec: 0.5 } },
    sched: { scriptAllowlist: ['calibrate.sh'] },
  });
  assert.equal(cfg.maxSusceptibility, 0.5);
  assert.equal(cfg.maxParallel, 2);
  assert.deepEqual(cfg.tokenBuckets['adapterA'], { capacity: 4, refillPerSec: 0.5 });
  assert.deepEqual(cfg.sched.scriptAllowlist, ['calibrate.sh']);
});

test('a missing/unparseable file falls back to the strict default (REQ-8.2)', () => {
  const cfg = loadRoutingConfig(join(import.meta.dirname, 'does-not-exist-routing.json'));
  assert.deepEqual(cfg, DEFAULT_ROUTING_CONFIG);
  assert.equal(cfg.maxSusceptibility, 0, 'strict cap, not a no-cap');
  assert.equal(cfg.maxParallel, 1, 'serialize by default');
});

test('a malformed maxSusceptibility never loosens the cap (REQ-8.2)', () => {
  // string, negative, and out-of-range all fall back to 0 — never an effective no-cap.
  assert.equal(parseRoutingConfig({ maxSusceptibility: 'high' }).maxSusceptibility, 0);
  assert.equal(parseRoutingConfig({ maxSusceptibility: -1 }).maxSusceptibility, 0);
  assert.equal(parseRoutingConfig({ maxSusceptibility: 5 }).maxSusceptibility, 0, 'out-of-range >1 does NOT become a no-cap');
});

test('a malformed maxParallel falls back to serialize; bad buckets are dropped (REQ-8.2)', () => {
  const cfg = parseRoutingConfig({
    maxParallel: 0,
    tokenBuckets: { good: { capacity: 2, refillPerSec: 1 }, bad: { capacity: 'x' } },
  });
  assert.equal(cfg.maxParallel, 1);
  assert.deepEqual(cfg.tokenBuckets['good'], { capacity: 2, refillPerSec: 1 });
  assert.equal(cfg.tokenBuckets['bad'], undefined, 'malformed bucket entry dropped, never a permissive default');
});

test('the committed .ai/policies/routing.json parses to a usable config', () => {
  const cfg = loadRoutingConfig(join(import.meta.dirname, '..', '..', '.ai', 'policies', 'routing.json'));
  assert.ok(cfg.maxSusceptibility >= 0 && cfg.maxSusceptibility <= 1);
  assert.ok(cfg.maxParallel >= 1);
  assert.deepEqual(cfg.sched.scriptAllowlist, []);
});
