// Spec-to-Goal generator e2e (platform-phase5-stage1). Every case execs the real
// scripts/spec_to_goal.py via python3 (absolute path — cwd of the test runner is
// console/backend; the wrapper .sh gets exactly one happy-path case to cut PATH
// variance) against fixture specs written to a temp --specs-dir. YAML assertions
// use the same `yaml` parser loop-cli uses; freeze assertions use the REAL
// `freezeContract` from core (REQ-4.4/4.5 are defined as its behavior — no mocks).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parse as parseYaml } from 'yaml';
import { ContractInvalidError, freezeContract } from 'core';

import { validateGoalShape } from './goal-schema.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const generator = join(repoRoot, 'scripts', 'spec_to_goal.py');
const wrapper = join(repoRoot, 'scripts', 'spec-to-goal.sh');
const traceWrapper = join(repoRoot, 'scripts', 'spec-trace.sh');

// CI precondition (design Testing Strategy): python3 must be on PATH — ubuntu
// runners ship it; a local dev box without it skips with a visible reason.
const skip = spawnSync('python3', ['--version']).status === 0 ? false : 'python3 not on PATH — spec-to-goal e2e skipped';

function runGen(args: string[]) {
  const res = spawnSync('python3', [generator, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function withSpecsDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'spec2goal-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSpec(specsDir: string, feature: string, files: { requirements?: string; tasks?: string }): string {
  const dir = join(specsDir, feature);
  mkdirSync(dir, { recursive: true });
  if (files.requirements !== undefined) writeFileSync(join(dir, 'requirements.md'), files.requirements);
  if (files.tasks !== undefined) writeFileSync(join(dir, 'tasks.md'), files.tasks);
  return dir;
}

const HEADER = '> Status: approved 2026-07-11';

function reqDoc(body: string, header = HEADER): string {
  return ['# Requirements: fixture-feat — Fixture Feature', header, '', '## Overview', '', 'fixture overview prose.', '', body, ''].join('\n');
}

const FULL_BODY = [
  '## REQ-1: First group',
  '',
  '- 1.1 THE SYSTEM SHALL handle "quotes", colons: and #hashes',
  '- 1.2 WHEN asked THE SYSTEM SHALL join wrapped',
  '       continuation lines รวมข้อความไทย',
  '',
  '## REQ-2: Second group',
  '',
  '- 2.1 THE SYSTEM SHALL do a',
  '- 2.2 THE SYSTEM SHALL do b',
  '- 2.3 THE SYSTEM SHALL do c',
].join('\n');

// Every criterion covered by exactly one task carrying a Verify: — the three
// Satisfies forms REQ-2.3 (of this spec) names: whole-REQ, dash range, REQ-N.M.
const FULL_TASKS = [
  '# Implementation Tasks: fixture-feat',
  '> Status: approved 2026-07-11',
  '',
  '- [ ] 1. Cover REQ-1 whole.',
  '     Satisfies: REQ-1 (all criteria). Verify: pnpm test one',
  '- [x] 2. Cover a dash range (checkbox state must not matter).',
  '     Satisfies: 2.1-2.2. Verify: pnpm test two',
  '- [ ] 3. Cover a single prefixed id, marker order shuffled; completed with an',
  '     Evidence block that must NOT leak into the verification value, even when',
  '     the transcript itself quotes spec markers (fanout review PR #102).',
  '     Satisfies: REQ-2.3. Depends on: 1. Verify: pnpm test three',
  '     Evidence:',
  '       - test: `pnpm test three` -> 9 passed / 0 failed (transcript quoting',
  '         Satisfies: 2.1 and Verify: echo fake must be parsed by nothing)',
  '       - deviations: none',
].join('\n');

const PARTIAL_BODY = [
  '## REQ-1: First',
  '',
  '- 1.1 THE SYSTEM SHALL x',
  '- 1.2 THE SYSTEM SHALL y',
  '',
  '## REQ-2: Second',
  '',
  '- 2.1 THE SYSTEM SHALL z',
].join('\n');

// 1.1 = double-covered, 2.1 = single cover without Verify, 1.2 = cleanly resolved.
const PARTIAL_TASKS = [
  '- [ ] 1. Covers 1.1 and 1.2 with a verify.',
  '     Satisfies: 1.1, 1.2. Verify: pnpm test a',
  '- [ ] 2. Double-covers 1.1; covers 2.1 with no verify at all.',
  '     Satisfies: 1.1, 2.1.',
].join('\n');

function generate(specsDir: string, feature: string) {
  const run = runGen([feature, '--specs-dir', specsDir]);
  const draftPath = join(specsDir, feature, 'goal.draft.yaml');
  return { ...run, draftPath };
}

test('complete spec: exit 0, active ACs pass freezeContract, 1:1 mapping, no pending/golden (REQ-2.1/2.2/2.4/2.6/3.7/4.5/5.2)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /5 acceptance criteria, 5 resolved \/ 0 unresolved/, 'summary line (REQ-5.2)');

    const text = readFileSync(res.draftPath, 'utf8');
    const doc = parseYaml(text);
    assert.equal(doc.pending_acceptance_criteria, undefined, 'no pending block when all resolved (REQ-4.5)');

    const acs = doc.acceptance_criteria as { id: string; description: string; verification: string }[];
    // Property-style 1:1 (REQ-2.1): every parse_requirements criterion has exactly one AC.
    assert.equal(acs.length, 5);
    assert.deepEqual(
      acs.map((a) => a.id).sort(),
      ['AC-1.1', 'AC-1.2', 'AC-2.1', 'AC-2.2', 'AC-2.3'],
    );
    const byId = new Map(acs.map((a) => [a.id, a]));
    assert.equal(byId.get('AC-1.1')?.description, 'THE SYSTEM SHALL handle "quotes", colons: and #hashes', 'EARS text verbatim (REQ-2.2)');
    assert.equal(byId.get('AC-1.2')?.description, 'WHEN asked THE SYSTEM SHALL join wrapped continuation lines รวมข้อความไทย', 'continuation lines joined (REQ-2.2)');
    for (const ac of acs) assert.ok(!('golden' in ac), `no golden key on ${ac.id} (REQ-2.6)`);

    // Two-beat freeze (stage-2 REQ-3.7 supersedes stage-1 REQ-4.5): the generator
    // always emits risk "TODO", so even a fully-resolved draft freezes ONLY after
    // the human sets a valid risk level — the risk gate is intentional (D5).
    assert.throws(
      () => freezeContract(Buffer.from(text, 'utf8'), doc),
      (e: unknown) => e instanceof ContractInvalidError && e.message.includes('risk'),
      'resolved draft is still risk-gated as-is (REQ-3.7)',
    );
    const filled = { ...doc, risk: 'L2' };
    assert.deepEqual(validateGoalShape(filled), [], 'risk-filled resolved draft is schema-clean (REQ-6.5)');
    const frozen = freezeContract(Buffer.from(JSON.stringify(filled), 'utf8'), filled);
    assert.equal(frozen.acceptanceCriteria.length, 5, 'freezes once the human fills risk (REQ-3.7/6.5)');
    assert.equal(frozen.risk, 'L2');
    assert.match(text, /rename goal\.draft\.yaml -> goal\.yaml \(promotion —/, 'resolved banner carries the promotion step too (REQ-5.5)');
  });
});

test('Satisfies semantics match spec_trace: whole-REQ, dash range, REQ-N.M all route to their own Verify (REQ-2.3/2.4)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const acs = parseYaml(readFileSync(res.draftPath, 'utf8')).acceptance_criteria as { id: string; verification: string }[];
    const byId = new Map(acs.map((a) => [a.id, a.verification]));
    assert.equal(byId.get('AC-1.1'), 'pnpm test one', 'REQ-1 (all criteria) expansion');
    assert.equal(byId.get('AC-1.2'), 'pnpm test one', 'REQ-1 (all criteria) expansion');
    assert.equal(byId.get('AC-2.1'), 'pnpm test two', 'dash range 2.1-2.2');
    assert.equal(byId.get('AC-2.2'), 'pnpm test two', 'dash range 2.1-2.2');
    assert.equal(byId.get('AC-2.3'), 'pnpm test three', 'single REQ-N.M id, Verify after Depends on:, Evidence block excluded');
  });
});

// [#shared-iterator-boundary-altitude] LESSONS.md tripwire: this case and the
// spec-trace fake-coverage case below pin the shared-iterator Evidence rule
// (line-anchored, case-insensitive, cut in iter_task_blocks — never per-consumer).
test('Evidence boundary: mid-line Evidence: stays verbatim in Verify, lowercase evidence: header still cuts (fanout review PR #102)', { skip }, () => {
  withSpecsDir((dir) => {
    const body = ['## REQ-1: Boundary', '', '- 1.1 THE SYSTEM SHALL a', '- 1.2 THE SYSTEM SHALL b'].join('\n');
    const tasks = [
      '- [ ] 1. Verify command legitimately contains the word Evidence: mid-line.',
      "     Satisfies: 1.1. Verify: grep -c 'Evidence:' tasks.md",
      '- [x] 2. Completed task, lowercase evidence header (floor engine accepts it',
      '     case-insensitively) with a transcript quoting a marker.',
      '     Satisfies: 1.2. Verify: pnpm test b',
      '     evidence:',
      '       - test: `pnpm test b` -> 3 passed (transcript quotes Satisfies: 1.1 here)',
    ].join('\n');
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(body), tasks });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /2 acceptance criteria, 2 resolved \/ 0 unresolved/);
    const acs = parseYaml(readFileSync(res.draftPath, 'utf8')).acceptance_criteria as { id: string; verification: string }[];
    const byId = new Map(acs.map((a) => [a.id, a.verification]));
    assert.equal(byId.get('AC-1.1'), "grep -c 'Evidence:' tasks.md", 'mid-line Evidence: is not a cut — command copied verbatim');
    assert.equal(byId.get('AC-1.2'), 'pnpm test b', 'lowercase evidence: header cuts — quoted Satisfies: 1.1 must not double-cover');
  });
});

test('spec-trace gate: Satisfies-last task with a transcript quoting other criteria must NOT fake coverage (fanout review PR #102)', { skip }, () => {
  withSpecsDir((dir) => {
    const requirements = reqDoc(['## REQ-1: One', '', '- 1.1 THE SYSTEM SHALL a', '', '## REQ-2: Two', '', '- 2.1 THE SYSTEM SHALL b'].join('\n'));
    const design = ['# Design: fixture-feat', '> Status: approved 2026-07-11', '', '## Requirement Traceability', '', '| element | REQ-1.1, REQ-2.1 |'].join('\n');
    const tasks = [
      '- [x] 1. Only real coverage is 1.1, with Satisfies deliberately the last marker.',
      '     Verify: pnpm test one. Satisfies: 1.1',
      '     Evidence:',
      '       - test: covers REQ-2 acceptance, 2.1 passing in transcript prose only',
    ].join('\n');
    const specDir = writeSpec(dir, 'fixture-feat', { requirements, tasks });
    writeFileSync(join(specDir, 'design.md'), design);
    const res = spawnSync('bash', [traceWrapper, 'fixture-feat', dir], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(res.status, 1, `trace gate must fail on uncovered 2.1, got:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /2\.1/, 'reports 2.1 uncovered in tasks.md');
  });
});

test('unresolved criteria: empty active array, full pending list, freezeContract throws (REQ-2.5/4.4)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(PARTIAL_BODY), tasks: PARTIAL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /3 acceptance criteria, 1 resolved \/ 2 unresolved/);

    const text = readFileSync(res.draftPath, 'utf8');
    const doc = parseYaml(text);
    assert.deepEqual(doc.acceptance_criteria, [], 'active array empty while any verification unresolved (REQ-4.4)');
    const pending = doc.pending_acceptance_criteria as { id: string; verification: string }[];
    assert.equal(pending.length, 3, 'full criteria list preserved for the human');
    const byId = new Map(pending.map((a) => [a.id, a.verification]));
    assert.equal(byId.get('AC-1.1'), 'TODO', 'two covering tasks -> unresolved (REQ-2.5)');
    assert.equal(byId.get('AC-1.2'), 'pnpm test a', 'resolved one keeps its command in the pending list');
    assert.equal(byId.get('AC-2.1'), 'TODO', 'covering task without Verify -> unresolved (REQ-2.5)');

    assert.throws(() => freezeContract(Buffer.from(text, 'utf8'), doc), ContractInvalidError, 'draft is structurally un-runnable as-is (REQ-4.4)');

    // Stage-2 REQ-6.4: schema rejection must include the empty-acceptance_criteria
    // violation SPECIFICALLY (the stage-1 human gate) — not merely any incidental
    // reason (`pending_...` unknown key, risk "TODO").
    const shapeErrors = validateGoalShape(doc);
    assert.ok(
      shapeErrors.some((e) => e.startsWith('/acceptance_criteria')),
      `empty-AC violation named among: ${shapeErrors.join(' | ')}`,
    );
    assert.ok(shapeErrors.some((e) => e.includes('pending_acceptance_criteria')), 'unknown pending key also named');
    assert.ok(shapeErrors.some((e) => e.startsWith('/risk')), 'risk TODO also named');

    // Stage-2 REQ-6.5 (full human fill, unresolved level): fill every TODO
    // verification, rename pending -> acceptance_criteria (drop the empty
    // placeholder), set risk — the result passes schema validation AND freezes.
    const pendingList = doc.pending_acceptance_criteria as { id: string; verification: string }[];
    const humanFilled = {
      ...doc,
      acceptance_criteria: pendingList.map((a) => ({ ...a, verification: a.verification === 'TODO' ? 'pnpm test filled' : a.verification })),
      risk: 'L1',
    } as Record<string, unknown>;
    delete humanFilled['pending_acceptance_criteria'];
    assert.deepEqual(validateGoalShape(humanFilled), [], 'human-filled draft is schema-clean (REQ-6.5)');
    const frozen = freezeContract(Buffer.from(JSON.stringify(humanFilled), 'utf8'), humanFilled);
    assert.equal(frozen.acceptanceCriteria.length, 3, 'human-filled draft freezes (REQ-6.5)');
    assert.equal(frozen.risk, 'L1');
  });
});

test('tasks.md absent: stderr warning, draft still generated with every verification unresolved (REQ-1.6/4.4)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(PARTIAL_BODY) });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /warning: .*tasks\.md not found/);

    const text = readFileSync(res.draftPath, 'utf8');
    const doc = parseYaml(text);
    assert.deepEqual(doc.acceptance_criteria, []);
    const pending = doc.pending_acceptance_criteria as { verification: string }[];
    assert.equal(pending.length, 3);
    for (const ac of pending) assert.equal(ac.verification, 'TODO');
    assert.throws(() => freezeContract(Buffer.from(text, 'utf8'), doc), ContractInvalidError);
  });
});

test('header gate: draft status refused with no bypass, amended approved form passes (REQ-1.4)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY, '> Status: draft'), tasks: FULL_TASKS });
    const refused = generate(dir, 'fixture-feat');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /"> Status: draft"/);
    assert.match(refused.stderr, /must be approved/);

    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY, '> Status: approved 2026-07-11, amended 2026-07-12 (wording fix)') });
    const ok = generate(dir, 'fixture-feat');
    assert.equal(ok.status, 0, ok.stderr);
  });
});

test('refusals: missing requirements.md / no REQ headings / duplicate id / empty REQ (REQ-1.3/1.5/1.7/1.8)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'no-req', { tasks: FULL_TASKS });
    const missing = generate(dir, 'no-req');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /requirements\.md not found/);
    assert.match(missing.stderr, /usage: scripts\/spec-to-goal\.sh/);

    writeSpec(dir, 'no-headings', { requirements: reqDoc('prose only, F-1/B-2 bugfix ids, no REQ headings.') });
    const bugfix = generate(dir, 'no-headings');
    assert.equal(bugfix.status, 1);
    assert.match(bugfix.stderr, /only REQ-form feature specs are supported/);

    writeSpec(dir, 'dup-id', { requirements: reqDoc(['## REQ-1: Dup', '', '- 1.1 THE SYSTEM SHALL a', '- 1.1 THE SYSTEM SHALL b'].join('\n')) });
    const dup = generate(dir, 'dup-id');
    assert.equal(dup.status, 1);
    assert.match(dup.stderr, /duplicate criterion id 1\.1/);

    writeSpec(dir, 'empty-req', { requirements: reqDoc(['## REQ-1: Full', '', '- 1.1 THE SYSTEM SHALL a', '', '## REQ-2: Empty', '', 'no criteria under this heading.'].join('\n')) });
    const empty = generate(dir, 'empty-req');
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /REQ-2 has no criterion lines/);
  });
});

test('output safety: existing draft refused byte-identical without --force, overwritten with it (REQ-4.2/4.3)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    assert.equal(generate(dir, 'fixture-feat').status, 0);
    const draftPath = join(dir, 'fixture-feat', 'goal.draft.yaml');
    const original = readFileSync(draftPath);

    const refused = generate(dir, 'fixture-feat');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already exists — pass --force to overwrite/);
    assert.deepEqual(readFileSync(draftPath), original, 'existing file left byte-identical (REQ-4.2)');

    writeFileSync(draftPath, 'garbage to be replaced');
    const forced = runGen(['fixture-feat', '--specs-dir', dir, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(draftPath, 'utf8'), /^# spec-to-goal draft/, 'overwritten with a fresh draft (REQ-4.3)');
  });
});

test('draft shape: goal id/title, TODO placeholders, budget scaffold, provenance sha256, HUMAN banner (REQ-3.1..3.6)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(PARTIAL_BODY), tasks: PARTIAL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const text = readFileSync(res.draftPath, 'utf8');
    const doc = parseYaml(text);

    assert.equal(doc.goal.id, 'FIXTURE-FEAT-001', 'slug uppercased + -001 (REQ-3.1)');
    assert.equal(doc.goal.title, 'fixture-feat — Fixture Feature', 'title from H1 (REQ-3.2)');
    assert.equal(doc.goal.objective, 'TODO');
    assert.equal(doc.risk, 'TODO');
    assert.deepEqual(doc.scope, { include: ['TODO'], exclude: ['TODO'] }, 'scope placeholders (REQ-3.3)');
    assert.deepEqual(doc.constraints, { forbidden: ['TODO'] }, 'forbidden placeholder (REQ-3.3)');
    assert.deepEqual(
      doc.budget,
      { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30, max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 },
      'six-key scaffold pinned to issues.ts goalDraftYaml (REQ-3.4)',
    );
    assert.deepEqual(doc.approval_policy, { require_human_approval: ['TODO'] });

    const sha = createHash('sha256').update(readFileSync(join(specDir, 'requirements.md'))).digest('hex');
    assert.ok(text.includes(`# requirements_sha256: ${sha}`), 'sha256 of the exact bytes read (REQ-3.5)');
    assert.match(text, /# source: .*requirements\.md/);
    assert.match(text, /# head_commit: /);
    assert.match(text, /# generated_at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);

    // HUMAN banner: every remaining decision listed (REQ-3.6) + the promotion step
    // (stage-2 REQ-5.5) and the stage-2-accurate structural-gate warning.
    assert.match(text, /# HUMAN: \(1\) review pending_acceptance_criteria \+ fill every TODO verification/);
    assert.match(text, /rename pending_acceptance_criteria -> acceptance_criteria/);
    assert.match(text, /WARNING: freezeContract does NOT reject "TODO" \*verification\* strings/);
    assert.match(text, /risk "TODO" placeholder \(schema \+ freezeContract both reject it/);
    assert.match(text, /set risk \(L0-L4\), decide golden flags, set approval_policy/);
    assert.match(text, /write goal\.objective \(one sentence\) \+ fill scope\/forbidden/);
    assert.match(text, /rename goal\.draft\.yaml -> goal\.yaml \(promotion —/, 'promotion is the final banner step (REQ-5.5)');
  });
});

test('spec_trace refactor regression: spec-trace.sh still green on the archived phase4 spec (REQ-2.3)', { skip }, () => {
  const res = spawnSync('bash', [traceWrapper, 'platform-phase4', join(repoRoot, '.ai', 'specs', 'archive')], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
});

test('real archive phase4 via --specs-dir: header on line 3 + amended form pass, em-dash H1 title, valid YAML (REQ-1.1/1.2/1.4/3.2/3.7)', { skip }, () => {
  withSpecsDir((dir) => {
    cpSync(join(repoRoot, '.ai', 'specs', 'archive', 'platform-phase4'), join(dir, 'platform-phase4'), { recursive: true });
    const res = generate(dir, 'platform-phase4');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /126 acceptance criteria, 126 resolved \/ 0 unresolved/, 'archive resolved split pinned (fanout review PR #102)');
    const doc = parseYaml(readFileSync(res.draftPath, 'utf8'));
    assert.equal(doc.goal.title, 'platform-phase4', 'H1 `# Requirements — platform-phase4` form (REQ-3.2)');
    assert.equal(doc.goal.id, 'PLATFORM-PHASE4-001');
    assert.equal(doc.pending_acceptance_criteria, undefined, 'nothing shifted to pending on the real archive');
    const active = (doc.acceptance_criteria ?? []) as { verification?: string }[];
    const pending = (doc.pending_acceptance_criteria ?? []) as { verification?: string }[];
    assert.equal(active.length + pending.length, 126, 'one AC per archived criterion (REQ-2.1)');
    for (const ac of [...active, ...pending]) {
      assert.ok(!String(ac.verification).includes('Evidence:'), 'Evidence transcript never leaks into verification (PR #102 Codex P2)');
    }
  });
});

test('generator touches nothing but goal.draft.yaml — no temp files left, inputs untouched (REQ-4.1/4.6)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const reqBefore = readFileSync(join(specDir, 'requirements.md'));
    const tasksBefore = readFileSync(join(specDir, 'tasks.md'));
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readdirSync(specDir).sort(), ['goal.draft.yaml', 'requirements.md', 'tasks.md'], 'exactly one new file (REQ-4.1/4.6)');
    assert.deepEqual(readFileSync(join(specDir, 'requirements.md')), reqBefore);
    assert.deepEqual(readFileSync(join(specDir, 'tasks.md')), tasksBefore);
  });
});

test('wrapper: scripts/spec-to-goal.sh happy path (REQ-5.1)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = spawnSync('bash', [wrapper, 'fixture-feat', '--specs-dir', dir], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /5 acceptance criteria/);
    assert.ok(readFileSync(join(dir, 'fixture-feat', 'goal.draft.yaml'), 'utf8').startsWith('# spec-to-goal draft'));
  });
});
