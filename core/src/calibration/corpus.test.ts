// Calibration corpus scaffolding (REQ-11). The shipped `.ai/calibration/corpus/`
// loads as a >= 10-task corpus with the visible/held-out split and intact golden
// hashes, and the loader + calibration MATH compose into a runnable harness — the
// numbers here are scripted fixtures (labeled until task 13), never §12 metrics.

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { computeFusionCalibration } from './calibration.ts';
import { loadCalibrationCorpus, CORPUS_MIN_TASKS } from './corpus.ts';

const CORPUS_DIR = fileURLToPath(new URL('../../../.ai/calibration/corpus', import.meta.url));

test('the shipped corpus loads as a >= 10-task fixture with intact golden hashes (REQ-11)', () => {
  const corpus = loadCalibrationCorpus(CORPUS_DIR);
  assert.ok(corpus.tasks.length >= CORPUS_MIN_TASKS, `corpus must seat >= ${CORPUS_MIN_TASKS} tasks`);
  assert.equal(corpus.numbersAreFixture, true, 'numbers stay fixture-labeled until task 13');
  for (const t of corpus.tasks) {
    assert.ok(t.objective.length > 0, `${t.id} has a model-visible objective`);
    assert.ok(t.answerKey.length > 0, `${t.id} has a held-out answer key`);
    assert.ok(/^[0-9a-f]{64}$/.test(t.golden.sha256), `${t.id} golden sha256 is well-formed`);
  }
});

test('loader + calibration compose into a runnable harness over the whole corpus (fixture numbers)', () => {
  const corpus = loadCalibrationCorpus(CORPUS_DIR);
  // Scripted per-task outcomes standing in for a FakeAdapter run: single passes the
  // even-indexed tasks, fusion additionally passes the odd ones — a +0.5 fixture uplift.
  const single = corpus.tasks.map((_t, i) => i % 2 === 0);
  const fused = corpus.tasks.map(() => true);
  const panelDisagreements = corpus.tasks.map(() => 0.3);
  const result = computeFusionCalibration({ single, fused, panelDisagreements });
  assert.equal(result.n, corpus.tasks.length);
  assert.ok(result.uplift > 0, 'fixture fusion outperforms the fixture single-model baseline');
  assert.ok(Math.abs(result.decorrelation - 0.3) < 1e-9);
});
