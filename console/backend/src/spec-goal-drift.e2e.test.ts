// Spec-Goal Drift Checker e2e (platform-phase5-stage3 REQ-4/REQ-5). Every case execs
// the real scripts/spec_goal_drift.py via python3 (same pattern as spec-to-goal.e2e:
// absolute path, cwd = repoRoot) against fixture specs written to a temp --specs-dir.
// The end-to-end case additionally spawns the real spec_to_goal.py generator so the
// checker is proven against an ACTUAL stamped provenance line, not a hand-written one.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const checker = join(repoRoot, 'scripts', 'spec_goal_drift.py');
const generator = join(repoRoot, 'scripts', 'spec_to_goal.py');
const wrapper = join(repoRoot, 'scripts', 'spec-goal-drift.sh');

// CI precondition (same as spec-to-goal e2e): python3 must be on PATH.
const skip = spawnSync('python3', ['--version']).status === 0 ? false : 'python3 not on PATH — spec-goal-drift e2e skipped';

function runChecker(args: string[]) {
  const res = spawnSync('python3', [checker, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function runGenerator(args: string[]) {
  const res = spawnSync('python3', [generator, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function withSpecsDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'spec-goal-drift-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSpec(specsDir: string, feature: string, files: { requirements?: string; tasks?: string; goalYaml?: string; goalDraftYaml?: string }): string {
  const dir = join(specsDir, feature);
  mkdirSync(dir, { recursive: true });
  if (files.requirements !== undefined) writeFileSync(join(dir, 'requirements.md'), files.requirements);
  if (files.tasks !== undefined) writeFileSync(join(dir, 'tasks.md'), files.tasks);
  if (files.goalYaml !== undefined) writeFileSync(join(dir, 'goal.yaml'), files.goalYaml);
  if (files.goalDraftYaml !== undefined) writeFileSync(join(dir, 'goal.draft.yaml'), files.goalDraftYaml);
  return dir;
}

const HEADER = '> Status: approved 2026-07-11';

function reqDoc(body: string, header = HEADER): string {
  return ['# Requirements: fixture-feat — Fixture Feature', header, '', '## Overview', '', 'fixture overview prose.', '', body, ''].join('\n');
}

const BODY = ['## REQ-1: One', '', '- 1.1 THE SYSTEM SHALL a', '- 1.2 THE SYSTEM SHALL b'].join('\n');
const TASKS = ['# Implementation Tasks: fixture-feat', '> Status: approved 2026-07-11', '', '- [ ] 1. Cover REQ-1.', '     Satisfies: REQ-1 (all criteria). Verify: pnpm test one'].join('\n');

test('end-to-end: generate -> promote -> checker silent; edit requirements.md -> checker warns advisory (exit 0) and --strict (exit 1) (REQ-4.3/4.4/4.6/4.7)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(BODY), tasks: TASKS });
    const gen = runGenerator(['fixture-feat', '--specs-dir', dir]);
    assert.equal(gen.status, 0, gen.stderr);

    // promotion = rename, unchanged from stage-1 (goal.draft.yaml -> goal.yaml)
    renameSync(join(specDir, 'goal.draft.yaml'), join(specDir, 'goal.yaml'));

    const clean = runChecker(['fixture-feat', '--specs-dir', dir]);
    assert.equal(clean.status, 0);
    assert.equal(clean.stdout, '', 'hash matches -> silent (REQ-4.3)');
    const cleanStrict = runChecker(['fixture-feat', '--specs-dir', dir, '--strict']);
    assert.equal(cleanStrict.status, 0);
    assert.equal(cleanStrict.stdout, '', 'a clean match is silent under --strict too');

    const before = readFileSync(join(specDir, 'requirements.md'), 'utf8');
    writeFileSync(join(specDir, 'requirements.md'), before + '\nan edit after generation.\n');
    const oldSha = createHash('sha256').update(before).digest('hex');
    const newSha = createHash('sha256').update(before + '\nan edit after generation.\n').digest('hex');

    const advisory = runChecker(['fixture-feat', '--specs-dir', dir]);
    assert.equal(advisory.status, 0, 'advisory never blocks (REQ-4.6)');
    assert.match(advisory.stdout, /^warning: fixture-feat: requirements\.md changed since goal\.yaml was generated \(sha256 /);
    assert.match(advisory.stdout, new RegExp(`sha256 ${oldSha.slice(0, 8)}\\.\\.\\. -> ${newSha.slice(0, 8)}\\.\\.\\.`));
    assert.match(advisory.stdout, /generated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    assert.match(advisory.stdout, /— regenerate or re-review/);

    const strict = runChecker(['fixture-feat', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 1, 'the DoD: --strict fails on drift (REQ-4.7)');
    assert.equal(strict.stdout, advisory.stdout, 'identical message in both modes — only the exit code differs');
  });
});

test('goal.yaml has no parseable provenance: line -> one warning, exit 0 advisory / 1 strict (REQ-4.5/4.7)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'no-prov', {
      requirements: reqDoc(BODY),
      goalYaml: 'goal: { id: "X-001" }\nrisk: "L2"\n',
    });
    const advisory = runChecker(['no-prov', '--specs-dir', dir]);
    assert.equal(advisory.status, 0);
    assert.equal(advisory.stdout, 'warning: no-prov: goal.yaml has no parseable provenance — regenerate with scripts/spec-to-goal.sh\n');
    const strict = runChecker(['no-prov', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 1, 'missing provenance must fail --strict too — else block mode is bypassed by deleting the block (REQ-4.7)');
    assert.equal(strict.stdout, advisory.stdout);
  });
});

test('provenance present but malformed JSON -> treated as no-parseable (any exception -> that mode)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'bad-json', {
      requirements: reqDoc(BODY),
      goalYaml: 'provenance: { "spec_path": "x", not valid json }\ngoal: { id: "X-001" }\n',
    });
    const res = runChecker(['bad-json', '--specs-dir', dir]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /has no parseable provenance/);
  });
});

test('provenance lacks requirements_sha256 -> its own distinct warning (REQ-4.5)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'no-sha', {
      requirements: reqDoc(BODY),
      goalYaml: 'provenance: { "spec_path": "x", "requirements_commit": "abc1234", "generated_at": "2026-07-12T00:00:00Z" }\ngoal: { id: "X-001" }\n',
    });
    const advisory = runChecker(['no-sha', '--specs-dir', dir]);
    assert.equal(advisory.status, 0);
    assert.equal(advisory.stdout, 'warning: no-sha: provenance lacks requirements_sha256 — content drift cannot be verified\n');
    const strict = runChecker(['no-sha', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 1);
  });
});

test('requirements.md missing next to goal.yaml -> its own distinct warning (REQ-4.5)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'no-req', {
      goalYaml: 'provenance: { "spec_path": "x", "requirements_commit": "abc1234", "requirements_sha256": "deadbeef", "generated_at": "2026-07-12T00:00:00Z" }\ngoal: { id: "X-001" }\n',
    });
    const advisory = runChecker(['no-req', '--specs-dir', dir]);
    assert.equal(advisory.status, 0);
    assert.equal(advisory.stdout, 'warning: no-req: requirements.md not found next to goal.yaml\n');
    const strict = runChecker(['no-req', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 1);
  });
});

test('A3 regression: a HUMAN-banner comment line containing the word provenance: mid-line does not fool the column-0 parser', { skip }, () => {
  withSpecsDir((dir) => {
    const requirements = reqDoc(BODY);
    const sha = createHash('sha256').update(requirements).digest('hex');
    const goalYaml = [
      '# spec-to-goal draft — DO NOT run as-is',
      '# HUMAN: do not hand-edit or reflow the machine-stamped provenance: line below',
      `provenance: { "spec_path": "x", "requirements_commit": "abc1234", "requirements_sha256": "${sha}", "generated_at": "2026-07-12T00:00:00Z" }`,
      'goal: { id: "X-001" }',
      '',
    ].join('\n');
    writeSpec(dir, 'fixture-feat', { requirements, goalYaml });
    const res = runChecker(['fixture-feat', '--specs-dir', dir]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '', 'the real column-0 provenance: line is found and hashes match — the banner mention is not parsed');
  });
});

test('dir has only goal.draft.yaml, never promoted -> "not applicable", exit 0 in BOTH modes (REQ-4.8)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'draft-only', { requirements: reqDoc(BODY), goalDraftYaml: '# spec-to-goal draft — DO NOT run as-is\n' });
    const advisory = runChecker(['draft-only', '--specs-dir', dir]);
    assert.equal(advisory.status, 0);
    assert.equal(advisory.stdout, 'not applicable (no promoted goal.yaml)\n');
    const strict = runChecker(['draft-only', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 0, '"not applicable" is exit 0 even under --strict — draft-only is a normal state, not a violation');
    assert.equal(strict.stdout, advisory.stdout);
  });
});

test('feature directory does not exist -> usage/error on stderr, exit 2 in BOTH modes (REQ-4.9)', { skip }, () => {
  withSpecsDir((dir) => {
    const advisory = runChecker(['ghost-feature', '--specs-dir', dir]);
    assert.equal(advisory.status, 2);
    assert.match(advisory.stderr, /not found/);
    assert.match(advisory.stderr, /usage: scripts\/spec-goal-drift\.sh/);
    const strict = runChecker(['ghost-feature', '--specs-dir', dir, '--strict']);
    assert.equal(strict.status, 2, 'usage error is exit 2 regardless of --strict');
  });
});

test('wrapper: scripts/spec-goal-drift.sh happy path, --strict propagates the drift exit code', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(BODY), tasks: TASKS });
    const gen = runGenerator(['fixture-feat', '--specs-dir', dir]);
    assert.equal(gen.status, 0, gen.stderr);
    renameSync(join(specDir, 'goal.draft.yaml'), join(specDir, 'goal.yaml'));
    writeFileSync(join(specDir, 'requirements.md'), readFileSync(join(specDir, 'requirements.md'), 'utf8') + '\nedit\n');

    const res = spawnSync('bash', [wrapper, 'fixture-feat', '--specs-dir', dir, '--strict'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stdout, /requirements\.md changed since goal\.yaml was generated/);
  });
});
