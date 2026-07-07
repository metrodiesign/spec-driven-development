// RED in task 2 (harness throws NotImplemented); GREEN in task 3.
// Proves each probe P1–P8 discriminates a real behavior (REQ-3), and the
// sabotage self-test (REQ-3.9): a compliant adapter passes all pass/fail probes;
// each saboteur fails EXACTLY the probe that owns its misbehavior.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runConformanceSuite, runProbe } from './harness.ts';
import { FakeAdapter, type FakeBehavior } from '../fake-adapter.ts';
import { PASS_FAIL_PROBES, type ProbeId } from '../protocol.ts';
import { memContext } from '../../test/helpers.ts';

test('compliant adapter passes every pass/fail probe P1–P8', async () => {
  const ctx = memContext();
  const adapter = new FakeAdapter({ behavior: 'compliant' });
  for (const id of PASS_FAIL_PROBES) {
    const v = await runProbe(id, adapter, ctx);
    assert.equal(v.pass, true, `${id} should pass for a compliant adapter (${v.detail ?? ''})`);
    assert.ok(v.evidenceRef.startsWith('blob://'), `${id} verdict is backed by evidence`);
  }
});

test('full suite yields a ConformanceRecord with a P7 score', async () => {
  const ctx = memContext();
  const rec = await runConformanceSuite(new FakeAdapter(), ctx, '2026-07-06T00:00:00Z');
  assert.equal(rec.probes.length, PASS_FAIL_PROBES.length);
  assert.ok(rec.probes.every((p) => p.pass));
  assert.ok(rec.p7.susceptibilityScore >= 0 && rec.p7.susceptibilityScore <= 1);
  assert.ok(rec.p7.evidenceRef.startsWith('blob://'));
});

// REQ-3.9 — each saboteur fails EXACTLY the probe that owns its behavior.
const SABOTAGE: { behavior: FakeBehavior; owns: ProbeId }[] = [
  { behavior: 'prose_only', owns: 'P2' },
  { behavior: 'fabricate_execution', owns: 'P6' },
  { behavior: 'ignore_schema', owns: 'P1' },
  { behavior: 'double_burn', owns: 'P8' },
];

for (const { behavior, owns } of SABOTAGE) {
  test(`sabotage ${behavior} fails ${owns} and no other pass/fail probe`, async () => {
    const ctx = memContext();
    const adapter = new FakeAdapter({ behavior });
    for (const id of PASS_FAIL_PROBES) {
      const v = await runProbe(id, adapter, ctx);
      if (id === owns) {
        assert.equal(v.pass, false, `${behavior} must fail ${id}`);
      } else if (id === 'P3' && owns === 'P1') {
        // ignore_schema also legitimately fails P3 (never conforms) — allowed overlap.
        continue;
      } else {
        assert.equal(v.pass, true, `${behavior} must NOT fail ${id} (${v.detail ?? ''})`);
      }
    }
  });
}
