import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decideLiveRun,
  latestConformanceRecordPath,
  loadGoalContract,
  mungeProjectDir,
  readConformanceRecord,
} from './loop-cli.ts';

test('live guard: default is the CI-safe stub adapter', () => {
  assert.deepEqual(decideLiveRun({ live: false, ciEnv: true, isTTY: false }), { action: 'stub' });
});

test('live guard: --live REFUSES in CI (REQ-11.3, REQ-11.2)', () => {
  const d = decideLiveRun({ live: true, ciEnv: true, isTTY: true });
  assert.equal(d.action, 'refuse');
});

test('live guard: --live REFUSES without a TTY', () => {
  const d = decideLiveRun({ live: true, ciEnv: false, isTTY: false });
  assert.equal(d.action, 'refuse');
});

test('live guard: --live on an interactive TTY requires a typed confirmation phrase', () => {
  const d = decideLiveRun({ live: true, ciEnv: false, isTTY: true });
  assert.equal(d.action, 'confirm');
});

test('mungeProjectDir matches Claude Code projects-dir naming (REQ-4.5 path derivation)', () => {
  assert.equal(
    mungeProjectDir('/Users/king_developer/.ai/runs/agent-sessions'),
    '-Users-king-developer--ai-runs-agent-sessions',
  );
});

test('latestConformanceRecordPath: newest record by embedded timestamp; null when none (REQ-12.4)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cal-'));
  try {
    assert.equal(latestConformanceRecordPath(join(root, 'absent')), null);
    assert.equal(latestConformanceRecordPath(root), null);
    writeFileSync(join(root, 'conformance-claude-2026-07-01T00-00-00Z.json'), '{}');
    writeFileSync(join(root, 'conformance-claude-2026-07-07T09-00-00Z.json'), '{}');
    writeFileSync(join(root, 'unrelated.json'), '{}');
    assert.equal(
      latestConformanceRecordPath(root),
      join(root, 'conformance-claude-2026-07-07T09-00-00Z.json'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readConformanceRecord: corrupt/truncated/hand-edited records refuse as null, only the FULL shape parses (REQ-12.4 pre-flight)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rec-'));
  const full = {
    adapterId: 'claude',
    modelVersion: 'sonnet',
    ranAt: '2026-07-07T00:00:00Z',
    probes: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P8'].map((id) => ({ id, pass: true, evidenceRef: `blob://${id}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
  try {
    const p = join(root, 'rec.json');
    writeFileSync(p, '{"adapterId":"claude","probes":[],}'); // trailing comma
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, 'null');
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, '{"adapterId":"claude"}'); // probes missing
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, JSON.stringify({ ...full, p7: undefined })); // p7 missing -> would crash register()
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, JSON.stringify({ ...full, probes: full.probes.slice(1) })); // P1 missing
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, JSON.stringify({ ...full, probes: full.probes.map((x) => ({ id: x.id, pass: x.pass })) })); // no evidence refs
    assert.equal(readConformanceRecord(p), null);
    writeFileSync(p, JSON.stringify(full));
    assert.equal(readConformanceRecord(p)?.adapterId, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('goal.yaml parsed at the edge, frozen by raw-byte hash in core (REQ-8.1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-'));
  const p = join(root, 'goal.yaml');
  writeFileSync(
    p,
    [
      'goal: { id: DEMO-1, title: Demo, objective: make it pass }',
      'acceptance_criteria:',
      '  - { id: AC-1, description: impl correct, golden: true }',
      'budget: { max_iterations_per_task: 8, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }',
      'approval_policy: { require_human_approval: [auth_policy_change] }',
    ].join('\n'),
  );
  try {
    const c = loadGoalContract(p);
    assert.equal(c.goal.id, 'DEMO-1');
    assert.equal(c.budget.maxIterations, 8);
    assert.match(c.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(c.approvalPolicy, ['auth_policy_change']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
