// Fusion calibration corpus loader (§12, REQ-11). Reads the 10-task-minimum fixture
// under `.ai/calibration/corpus/`, joining each MODEL-VISIBLE task (tasks/) with its
// HELD-OUT answer-key + hidden golden (answers/) and verifying golden integrity (the
// stored sha256 must equal the hash of `expected`, so a tampered golden is caught
// before it can silently score a candidate green). The corpus feeds a FakeAdapter
// harness in CI (zero quota) that proves the loader + the calibration MATH only —
// the real uplift interval comes from the LIVE task (task 13). Zero-dep by law (INV-7).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CorpusTask {
  id: string;
  /** Model-visible objective (from tasks/<id>.json). */
  objective: string;
  budget: { costUnits: number };
  /** Held-out (from answers/<id>.json) — never enters a model's context bundle. */
  answerKey: string;
  golden: { expected: string; sha256: string };
}

export interface CalibrationCorpus {
  numbersAreFixture: boolean;
  tasks: CorpusTask[];
}

/** Minimum corpus size (§12 needs a spread of tasks for a meaningful uplift interval). */
export const CORPUS_MIN_TASKS = 10;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function readJson(path: string): Record<string, unknown> {
  const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`corpus: ${path} is not a JSON object`);
  return v as Record<string, unknown>;
}

export function loadCalibrationCorpus(dir: string): CalibrationCorpus {
  const manifest = readJson(join(dir, 'manifest.json'));
  const ids = manifest['taskIds'];
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
    throw new Error('corpus manifest: taskIds must be a string array');
  }
  if (ids.length < CORPUS_MIN_TASKS) {
    throw new Error(`corpus: ${ids.length} tasks < ${CORPUS_MIN_TASKS}-task minimum (§12)`);
  }
  const tasksDir = typeof manifest['tasksDir'] === 'string' ? manifest['tasksDir'] : 'tasks';
  const answersDir = typeof manifest['answersDir'] === 'string' ? manifest['answersDir'] : 'answers';

  const tasks: CorpusTask[] = ids.map((id) => {
    const t = readJson(join(dir, tasksDir, `${id}.json`));
    const a = readJson(join(dir, answersDir, `${id}.json`));
    const golden = a['golden'] as { expected?: unknown; sha256?: unknown } | undefined;
    const expected = golden?.expected;
    const sha256 = golden?.sha256;
    if (typeof expected !== 'string' || typeof sha256 !== 'string') {
      throw new Error(`corpus ${id}: answers golden must be { expected: string, sha256: string }`);
    }
    // Golden integrity: a hand-edited golden whose hash no longer matches is refused
    // (mirrors verifyGoldenManifest — a corrupt held-out artifact never scores green).
    if (sha256Hex(expected) !== sha256) {
      throw new Error(`corpus ${id}: golden sha256 mismatch (expected content hashes to ${sha256Hex(expected)})`);
    }
    const budget = t['budget'] as { costUnits?: unknown } | undefined;
    return {
      id,
      objective: typeof t['objective'] === 'string' ? (t['objective'] as string) : '',
      budget: { costUnits: typeof budget?.costUnits === 'number' ? budget.costUnits : 0 },
      answerKey: typeof a['answerKey'] === 'string' ? (a['answerKey'] as string) : '',
      golden: { expected, sha256 },
    };
  });

  return { numbersAreFixture: manifest['numbersAreFixture'] === true, tasks };
}
