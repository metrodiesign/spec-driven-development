import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  decideLiveRun,
  latestConformanceRecordPath,
  loadGoalContract,
  loadOfflineDependencyPolicy,
  mungeProjectDir,
  readConformanceRecord,
} from './loop-cli.ts';
import { makeSyntheticFixtureRepoForTests } from './loop-run.ts';

test('REQ-2.31-2.36: production binds an exact offline-only dependency policy to its target', () => {
  const policy = loadOfflineDependencyPolicy(
    join(import.meta.dirname, '..', '..', '..', '.ai', 'policies', 'security-plane.json'),
  );
  const fixture = makeSyntheticFixtureRepoForTests();
  try {
    const manifest = readFileSync(join(fixture.wt, policy.manifestPath));
    const lockfile = readFileSync(join(fixture.wt, policy.lockfilePath));
    assert.equal(createHash('sha256').update(manifest).digest('hex'), policy.manifestHash);
    assert.equal(createHash('sha256').update(lockfile).digest('hex'), policy.lockfileHash);
    assert.deepEqual(policy.allowedRoles, ['implementer']);
    assert.deepEqual(policy.commands, [
      'pnpm install --offline --frozen-lockfile --ignore-scripts --config.node-linker=hoisted',
    ]);
    assert.equal(policy.approvedSources.length, 1);
    const source = policy.approvedSources[0];
    assert.ok(source);
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify(
          ['index.js', 'package.json'].map((path) => ({
            path,
            sha256: createHash('sha256')
              .update(readFileSync(join(source.sourcePath, path)))
              .digest('hex'),
          })),
        ),
      )
      .digest('hex');
    assert.equal(sourceHash, source.contentHash);
    assert.deepEqual(policy.approvedSourceHashes, [sourceHash]);
    assert.deepEqual(policy.approvedOutputMetadata, [
      {
        path: 'node_modules/.modules.yaml',
        validator: 'pnpm_modules_json_v1',
        packageManager: 'pnpm@11.9.0',
      },
      {
        path: 'node_modules/.package-map.json',
        validator: 'pnpm_package_map_json_v1',
      },
      {
        path: 'node_modules/.pnpm-workspace-state-v1.json',
        validator: 'pnpm_workspace_state_json_v1',
      },
      {
        path: 'node_modules/.pnpm/lock.yaml',
        validator: 'exact_lockfile_v1',
      },
    ]);
    assert.deepEqual(policy.persistentOutputRoots, ['node_modules']);
    assert.equal(policy.lifecycleScripts, 'disabled');
    assert.equal(policy.network, 'none');
  } finally {
    fixture.cleanup();
  }
});

test('REQ-2.31-2.36: malformed or network-widening production policy fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-policy-'));
  const path = join(root, 'security-plane.json');
  try {
    writeFileSync(path, JSON.stringify({ depManifestPatterns: [] }));
    assert.throws(() => loadOfflineDependencyPolicy(path), /missing/);
    writeFileSync(
      path,
      JSON.stringify({
        offlineDependency: {
          version: 1,
          allowedRoles: ['implementer'],
          commands: ['pnpm install --offline --frozen-lockfile --ignore-scripts'],
          lockfilePath: 'pnpm-lock.yaml',
          lockfileHash: 'a'.repeat(64),
          approvedSourceHashes: [],
          lifecycleScripts: 'disabled',
          network: 'allow',
        },
      }),
    );
    assert.throws(() => loadOfflineDependencyPolicy(path), /invalid/);

    const productionPolicy = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', '.ai', 'policies', 'security-plane.json'),
        'utf8',
      ),
    ) as { offlineDependency: { approvedOutputMetadata: unknown } };
    productionPolicy.offlineDependency.approvedOutputMetadata = [
      {
        path: 'node_modules/.manager-state',
        validator: 'trust_manager_output_v1',
      },
    ];
    writeFileSync(path, JSON.stringify(productionPolicy));
    assert.throws(() => loadOfflineDependencyPolicy(path), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      'budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30,',
      '          max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }',
      'approval_policy: { require_human_approval: [auth_policy_change] }',
    ].join('\n'),
  );
  try {
    const c = loadGoalContract(p);
    assert.equal(c.goal.id, 'DEMO-1');
    assert.equal(c.budget.maxIterations, 8);
    assert.equal(c.budget.maxHypothesesPerFailure, 3);
    assert.equal(c.budget.maxParallelAgents, 3);
    assert.equal(c.risk, 'L2');
    assert.match(c.hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(c.approvalPolicy, ['auth_policy_change']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('goal.yaml with shape errors is refused at the edge naming EVERY failing path, before freeze (phase5-stage2 REQ-2.1/2.2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'goal-shape-'));
  const p = join(root, 'goal.yaml');
  writeFileSync(
    p,
    [
      'goal: { id: DEMO-1 }',
      'acceptance_criteria:',
      '  - { id: AC-1, description: impl correct }',
      // typo'd budget key + zero value + unknown top-level key + bad risk: four
      // independent defects — the edge must name them all, not stop at the first.
      'budget: { max_iteration_per_task: 8, max_hypotheses_per_failure: 0, max_total_tasks: 30,',
      '          max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }',
      'aproval_policy: { require_human_approval: [] }',
      'risk: TODO',
    ].join('\n'),
  );
  try {
    assert.throws(
      () => loadGoalContract(p),
      (e: unknown) => {
        const msg = (e as Error).message;
        return (
          msg.includes('goal file failed schema validation') &&
          msg.includes('max_iteration_per_task') && // unknown budget key named
          msg.includes('/budget/max_hypotheses_per_failure') && // zero value path
          msg.includes('aproval_policy') && // unknown top-level key named
          msg.includes('/risk') // enum violation path
        );
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
