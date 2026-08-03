import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCoreRedObservation, createRedArtifactStore, RedArtifactError } from './red-provenance.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { openEventLog } from '../state/event-log.ts';
import { makeClock, makeFixture, makeReportIntegrity } from '../../test/helpers/fixture.ts';

function observe(fix: ReturnType<typeof makeFixture>, evidence: ReturnType<typeof createEvidenceStore>, runId: string, taskId: string, path: string) {
  const integrity = makeReportIntegrity(fix, evidence, runId);
  const failureRef = evidence.put('expected failure');
  const report = integrity.signGateReport({
    tier: 'T1',
    pass: false,
    gateConfigHash: 'config-hash',
    commitHash: 'commit-hash',
    worktreeHash: 'tree-hash',
    envHash: 'env-hash',
    checks: [{ name: 'tests', pass: false, evidenceRef: failureRef, detail: 'expected failure' }],
    scopeNote: 'syntactic test',
  }, { runId, taskId });
  return createCoreRedObservation({
    worktreeDir: fix.worktree,
    path,
    report,
    reportIntegrity: integrity,
    evidence,
    runId,
    taskId,
  });
}

test('core freezes a RED artifact only after observed failure and records provenance', () => {
  const fix = makeFixture();
  const root = fix.worktree;
  writeFileSync(join(root, 'test', 'ai-generated', 'red.test.ts'), 'test("red", () => { throw new Error("expected"); });\n');
  try {
    const evidence = createEvidenceStore(fix.evidenceDir);
    const observation = observe(fix, evidence, 'RUN-1', 'TASK-1', 'test/ai-generated/red.test.ts');
    const store = createRedArtifactStore({ evidence, reportIntegrity: makeReportIntegrity(fix, evidence, 'RUN-1') });
    assert.throws(
      () => store.freeze(root, 'test/ai-generated/red.test.ts', {
        sourceRole: 'test_designer', observedByCore: true, pass: false,
        expectedFailureFingerprint: 'caller-fabricated',
      } as never),
      (error: unknown) => error instanceof RedArtifactError && error.code === 'red_observation_required',
    );
    const record = store.freeze(root, 'test/ai-generated/red.test.ts', observation);
    assert.equal(record.path, 'test/ai-generated/red.test.ts');
    assert.equal(record.sourceRole, 'test_designer');
    assert.equal(record.frozenBy, 'core');
    assert.match(record.contentHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.paths(), [record.path]);
    assert.throws(
      () => store.freeze(root, record.path, observation),
      (error: unknown) => error instanceof RedArtifactError && error.code === 'red_artifact_frozen',
    );
  } finally {
    fix.cleanup();
  }
});

test('test-designer correction replaces frozen provenance only after a new observed RED', () => {
  const fix = makeFixture();
  const root = fix.worktree;
  writeFileSync(join(root, 'test', 'ai-generated', 'red.test.ts'), 'test("red", () => { throw new Error("expected"); });\n');
  try {
    const evidence = createEvidenceStore(fix.evidenceDir);
    const store = createRedArtifactStore({ evidence, reportIntegrity: makeReportIntegrity(fix, evidence, 'RUN-1') });
    const path = 'test/ai-generated/red.test.ts';
    const observation = observe(fix, evidence, 'RUN-1', 'TASK-1', path);
    const previous = store.freeze(root, path, observation);
    writeFileSync(join(root, path), 'test("red", () => { throw new Error("corrected"); });\n');
    assert.throws(
      () => store.replaceAfterObservedRed(root, path, { ...observation, observedByCore: false } as never),
      (error: unknown) => error instanceof RedArtifactError && error.code === 'red_observation_required',
    );
    assert.equal(store.get(path)?.contentHash, previous.contentHash);
    const correction = observe(fix, evidence, 'RUN-1', 'TASK-1', path);
    const replacement = store.replaceAfterObservedRed(root, path, correction);
    assert.notEqual(replacement.contentHash, previous.contentHash);
    assert.equal(store.get(path)?.contentHash, replacement.contentHash);
  } finally {
    fix.cleanup();
  }
});

test('frozen RED provenance rehydrates from the core event log', () => {
  const fix = makeFixture();
  const root = fix.worktree;
  writeFileSync(join(root, 'test', 'ai-generated', 'red.test.ts'), 'test("red", () => { throw new Error("expected"); });\n');
  try {
    const dbPath = join(root, 'events.db');
    const log = openEventLog(dbPath, makeClock());
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const integrity = makeReportIntegrity(fix, evidence, 'RUN');
    const first = createRedArtifactStore({ log, runId: 'RUN', taskId: 'TASK', evidence, reportIntegrity: integrity, worktreeDir: root });
    const path = 'test/ai-generated/red.test.ts';
    const observation = observe(fix, evidence, 'RUN', 'TASK', path);
    const record = first.freeze(root, path, observation);
    const restored = createRedArtifactStore({ log, runId: 'RUN', taskId: 'TASK', evidence, reportIntegrity: integrity, worktreeDir: root });
    assert.deepEqual(restored.get(path), record);
    log.close();
  } finally {
    fix.cleanup();
  }
});

test('rehydration fails closed when the current artifact no longer matches frozen bytes', () => {
  const fix = makeFixture();
  const root = fix.worktree;
  const path = 'test/ai-generated/red.test.ts';
  writeFileSync(join(root, path), 'test("red", () => { throw new Error("expected"); });\n');
  try {
    const log = openEventLog(join(root, 'events.db'), makeClock());
    const evidence = createEvidenceStore(join(root, 'evidence'));
    const integrity = makeReportIntegrity(fix, evidence, 'RUN-TAMPER');
    const store = createRedArtifactStore({
      log,
      runId: 'RUN-TAMPER',
      taskId: 'TASK-TAMPER',
      evidence,
      reportIntegrity: integrity,
      worktreeDir: root,
    });
    const observation = observe(fix, evidence, 'RUN-TAMPER', 'TASK-TAMPER', path);
    store.freeze(root, path, observation);
    writeFileSync(join(root, path), 'test("red", () => {});\n');
    assert.throws(
      () => createRedArtifactStore({
        log,
        runId: 'RUN-TAMPER',
        taskId: 'TASK-TAMPER',
        evidence,
        reportIntegrity: integrity,
        worktreeDir: root,
      }),
      (error: unknown) => error instanceof RedArtifactError && error.code === 'red_artifact_invalid',
    );
    log.close();
  } finally {
    fix.cleanup();
  }
});
