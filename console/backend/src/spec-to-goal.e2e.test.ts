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
import { ContractInvalidError, freezeContract, freezeTaskGraph } from 'core';

import { validateGoalShape } from './goal-schema.ts';
import { validateTaskGraphShape } from './task-graph-schema.ts';

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

// Rooted inside the repo (unlike withSpecsDir's os.tmpdir()) so the generator's
// spec_path relative_to(repo_root) succeeds — exercises the "in-repo" branch of
// critique D1, the twin of withSpecsDir's "outside repo" branch.
function withInRepoSpecsDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(repoRoot, '.tmp-spec2goal-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Provenance = { spec_path: string; requirements_commit: string; requirements_sha256: string; generated_at: string };

function extractProvenance(text: string): Provenance {
  const line = text.split('\n').find((l) => l.startsWith('provenance:'));
  assert.ok(line, 'draft has a top-level provenance: line at column 0');
  return JSON.parse(line!.slice('provenance:'.length).trim()) as Provenance;
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

test('Thai requirements H1 and readable Evidence format generate the same title and task contract', { skip }, () => {
  withSpecsDir((dir) => {
    const requirements = [
      '# ข้อกำหนด: การบันทึกฉบับร่าง',
      HEADER,
      '',
      '## ภาพรวม',
      '',
      'บันทึกงานเพื่อกลับมาแก้ไขภายหลัง',
      '',
      '## REQ-1: การบันทึกฉบับร่าง',
      '',
      '**ความต้องการของผู้ใช้:** ในฐานะผู้ใช้ ฉันต้องการบันทึกฉบับร่าง',
      '',
      '**เกณฑ์การยอมรับ:**',
      '',
      '- 1.1 เมื่อผู้ใช้กดบันทึก ระบบต้องเก็บเนื้อหาฉบับร่าง',
      '',
    ].join('\n');
    const tasks = [
      '# รายการงาน: การบันทึกฉบับร่าง',
      HEADER,
      '',
      '- [x] 1. บันทึกและเรียกคืนฉบับร่าง',
      '  Satisfies: REQ-1.1',
      '  Verify: node --test draft.test.ts',
      '',
      '  Evidence:',
      '',
      '  - test: `node --test draft.test.ts` -> 1 ผ่าน',
      '  - deviations: ไม่มี',
      '',
    ].join('\n');
    writeSpec(dir, 'thai-fixture', { requirements, tasks });

    const res = generate(dir, 'thai-fixture');
    assert.equal(res.status, 0, res.stderr);
    const doc = parseYaml(readFileSync(res.draftPath, 'utf8'));
    assert.equal(doc.goal.title, 'การบันทึกฉบับร่าง');
    assert.equal(doc.acceptance_criteria[0].description, 'เมื่อผู้ใช้กดบันทึก ระบบต้องเก็บเนื้อหาฉบับร่าง');
    assert.equal(doc.acceptance_criteria[0].verification, 'node --test draft.test.ts');

    const { graph } = readGraph(dir, 'thai-fixture');
    assert.equal(graph.tasks[0]!.title, 'บันทึกและเรียกคืนฉบับร่าง');
    assert.deepEqual(graph.tasks[0]!.satisfies, ['AC-1.1']);
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

    // Provenance now a structured `provenance:` flow mapping, not comment lines
    // (supersedes stage-1 REQ-3.5's comment form — phase5-stage3 REQ-2.1/2.2/2.6).
    const sha = createHash('sha256').update(readFileSync(join(specDir, 'requirements.md'))).digest('hex');
    const provenance = extractProvenance(text);
    assert.equal(provenance.requirements_sha256, sha, 'sha256 of the exact bytes read (REQ-2.6)');
    assert.match(provenance.spec_path, /requirements\.md$/);
    assert.match(provenance.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(provenance.requirements_commit.length > 0);

    // HUMAN banner: every remaining decision listed (REQ-3.6) + the promotion step
    // (stage-2 REQ-5.5) and the stage-2-accurate structural-gate warning.
    assert.match(text, /# HUMAN: \(1\) review pending_acceptance_criteria \+ fill every TODO verification/);
    assert.match(text, /rename pending_acceptance_criteria -> acceptance_criteria/);
    assert.match(text, /WARNING: freezeContract does NOT reject "TODO" \*verification\* strings/);
    assert.match(text, /risk "TODO" placeholder \(schema \+ freezeContract both reject it/);
    assert.match(text, /set risk \(L0-L4\), decide golden flags, set approval_policy/);
    assert.match(text, /write goal\.objective \(one sentence\) \+ fill scope\/forbidden/);
    assert.match(text, /rename goal\.draft\.yaml -> goal\.yaml \(promotion —/, 'promotion is the final banner step (REQ-5.5)');
    assert.match(text, /do not hand-edit or reflow the machine-stamped provenance: line/, 'no-reflow instruction (phase5-stage3 REQ-2.3)');
  });
});

test('provenance: single-line JSON-parseable flow mapping at column 0, exactly the four keys, ahead of goal:, old comment-form header gone, no provenance shape errors (phase5-stage3 REQ-2.1/2.2/2.4/2.6)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const text = readFileSync(res.draftPath, 'utf8');
    const lines = text.split('\n');

    const provenanceLines = lines.filter((l) => l.startsWith('provenance:'));
    assert.equal(provenanceLines.length, 1, 'exactly one top-level provenance: line (column 0)');
    const provenance = extractProvenance(text);
    assert.deepEqual(
      Object.keys(provenance).sort(),
      ['generated_at', 'requirements_commit', 'requirements_sha256', 'spec_path'],
      'exactly the four defined fields (REQ-2.1)',
    );

    for (const gone of ['# source:', '# requirements_sha256:', '# head_commit:', '# generated_at:']) {
      assert.ok(!text.includes(gone), `old comment-form line removed (REQ-2.2): ${gone}`);
    }
    assert.ok(text.startsWith('# spec-to-goal draft — DO NOT run as-is\n'), 'DO-NOT-run banner retained (REQ-2.2)');

    const provIdx = lines.findIndex((l) => l.startsWith('provenance:'));
    const goalIdx = lines.findIndex((l) => l.startsWith('goal:'));
    assert.ok(provIdx >= 0 && goalIdx > provIdx, 'provenance: is the first real YAML key, ahead of goal: (REQ-2.1)');

    const sha = createHash('sha256').update(readFileSync(join(specDir, 'requirements.md'))).digest('hex');
    assert.equal(provenance.requirements_sha256, sha, 'sha256 of the exact bytes read (REQ-2.6)');

    const doc = parseYaml(text) as Record<string, unknown>;
    const shapeErrors = validateGoalShape(doc);
    assert.ok(
      !shapeErrors.some((e) => e.startsWith('/provenance')),
      `no provenance-related shape errors (REQ-2.4), got: ${shapeErrors.join(' | ')}`,
    );
  });
});

test('spec_path: outside-repo temp dir falls back to the path as given (absolute); in-repo dir resolves repo-root-relative with no leading / (design critique D1, phase5-stage3 REQ-2.1)', { skip }, () => {
  withSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const provenance = extractProvenance(readFileSync(res.draftPath, 'utf8'));
    assert.ok(provenance.spec_path.startsWith('/'), `outside-repo temp dir falls back to an absolute as-given path, got: ${provenance.spec_path}`);
    assert.match(provenance.spec_path, /requirements\.md$/);
  });

  withInRepoSpecsDir((dir) => {
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const provenance = extractProvenance(readFileSync(res.draftPath, 'utf8'));
    assert.ok(!provenance.spec_path.startsWith('/'), `in-repo dir resolves relative to repo root, got: ${provenance.spec_path}`);
    assert.match(provenance.spec_path, /requirements\.md$/);
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

// stage-4 REQ-2.1 supersedes stage-1 REQ-4.1/4.6's singular "only goal.draft.yaml"
// output: the generator now also emits task-graph.draft.json. The invariant this
// case actually guards — no temp files left behind, inputs untouched, and nothing
// promoted (never goal.yaml / task-graph.json) — is unchanged.
test('generator touches nothing but the two drafts — no temp files left, inputs untouched (REQ-4.1/4.6, stage-4 REQ-2.1/2.7)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const reqBefore = readFileSync(join(specDir, 'requirements.md'));
    const tasksBefore = readFileSync(join(specDir, 'tasks.md'));
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(readdirSync(specDir).sort(), ['goal.draft.yaml', 'requirements.md', 'task-graph.draft.json', 'tasks.md'], 'exactly the two drafts, no temp file left (REQ-4.1/4.6)');
    assert.deepEqual(readFileSync(join(specDir, 'requirements.md')), reqBefore);
    assert.deepEqual(readFileSync(join(specDir, 'tasks.md')), tasksBefore);
  });
});

// ---------------------------------------------------------------------------
// platform-phase5-stage4 REQ-2 — task-graph draft emission. Same conventions as
// everything above: the real generator via spawnSync, assertions against the REAL
// `validateTaskGraphShape` (ajv edge) and core `freezeTaskGraph` (planning gate).
// ---------------------------------------------------------------------------

type GraphTask = { id: string; title: string; satisfies: string[]; depends_on?: string[] };
type Graph = { goal_id: string; tasks: GraphTask[]; checks: { max_diff_budget_per_task: number } };

function readGraph(specsDir: string, feature: string): { raw: Buffer; graph: Graph } {
  const raw = readFileSync(join(specsDir, feature, 'task-graph.draft.json'));
  return { raw, graph: JSON.parse(raw.toString('utf8')) as Graph };
}

/** Freeze the goal draft the SAME run produced (risk filled, as a human would) — the
 *  contract `freezeTaskGraph` gates the graph against (goal_id binding, AC coverage). */
function contractFromDraft(draftPath: string) {
  const doc = parseYaml(readFileSync(draftPath, 'utf8')) as Record<string, unknown>;
  const filled = { ...doc, risk: 'L2' };
  return freezeContract(Buffer.from(JSON.stringify(filled), 'utf8'), filled);
}

test('task-graph draft: 3 tasks in file order, deps, key order, checks 400, schema-clean, freezes against the same run goal (REQ-2.1/2.2/2.3/2.7)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /task-graph\.draft\.json — 3 tasks/, 'graph summary line');
    assert.ok(!readdirSync(specDir).includes('task-graph.json'), 'never auto-promotes (REQ-2.7)');

    const { raw, graph } = readGraph(dir, 'fixture-feat');
    assert.deepEqual(Object.keys(graph), ['goal_id', 'tasks', 'checks'], 'top-level key order pinned (REQ-2.2)');
    assert.equal(graph.goal_id, 'FIXTURE-FEAT-001', 'same goal.id the goal draft stamps (REQ-2.1)');
    assert.deepEqual(graph.checks, { max_diff_budget_per_task: 400 }, '§11.2 default stamped (REQ-2.3)');
    assert.ok(raw.toString('utf8').endsWith('}\n'), 'trailing newline (REQ-2.2)');
    assert.match(raw.toString('utf8'), /^\{\n {2}"goal_id"/, '2-space indent (REQ-2.2)');

    assert.deepEqual(graph.tasks.map((t) => t.id), ['T-1', 'T-2', 'T-3'], 'one entry per block, file order (REQ-2.1)');
    assert.deepEqual(Object.keys(graph.tasks[0]!), ['id', 'title', 'satisfies'], 'depends_on omitted when empty (REQ-2.2)');
    assert.deepEqual(Object.keys(graph.tasks[2]!), ['id', 'title', 'satisfies', 'depends_on'], 'task key order pinned (REQ-2.2)');
    assert.equal(graph.tasks[0]!.title, 'Cover REQ-1 whole.', 'title = text between ordinal and first marker (REQ-2.1)');
    assert.deepEqual(graph.tasks[0]!.satisfies, ['AC-1.1', 'AC-1.2'], 'whole-REQ Satisfies expanded to AC ids (REQ-2.1)');
    assert.deepEqual(graph.tasks[1]!.satisfies, ['AC-2.1', 'AC-2.2'], 'dash range expanded (REQ-2.1)');
    assert.deepEqual(graph.tasks[2]!.satisfies, ['AC-2.3']);
    assert.deepEqual(graph.tasks[2]!.depends_on, ['T-1'], 'Depends on: 1 -> T-1 (REQ-2.1)');
    for (const t of graph.tasks) assert.ok(!/Satisfies:|Verify:|Depends on:|Batch:/.test(t.title), `${t.id} title stops at the first marker`);

    // The draft must survive BOTH real gates, not just look right.
    assert.deepEqual(validateTaskGraphShape(graph), [], 'schema-clean at the edge (REQ-1.3)');
    const contract = contractFromDraft(join(specDir, 'goal.draft.yaml'));
    const { graph: frozen, gate } = freezeTaskGraph(raw, graph, contract);
    assert.deepEqual(gate.taskIds, ['T-1', 'T-2', 'T-3']);
    assert.deepEqual(gate.uncoveredAcs, [], 'generated graph covers every contract AC');
    assert.deepEqual(gate.orphanTasks, []);
    assert.deepEqual(frozen.tasks[2]!.dependsOn, ['T-1']);
    assert.equal(frozen.checks.maxDiffBudgetPerTask, 400);
  });
});

test('Depends on: grammar is narrow — the real stage-2 line (number + Thai parenthetical + other numbers) yields exactly T-1 (REQ-2.6, A7)', { skip }, () => {
  withSpecsDir((dir) => {
    const body = ['## REQ-6: Pinned', '', '- 6.1 THE SYSTEM SHALL a', '- 6.2 THE SYSTEM SHALL b', '- 6.3 THE SYSTEM SHALL c'].join('\n');
    // Verbatim shape of .ai/specs/platform-phase5-stage2/tasks.md:37 — prose and
    // further numbers after the dependency list must be ignored entirely.
    const tasks = [
      '- [x] 1. First.',
      '     Satisfies: 6.1. Verify: pnpm test one',
      '- [x] 2. Second.',
      '     Satisfies: REQ-6.2, REQ-6.3. Depends on: 1 (เฉพาะความครบของ 6.2/6.3 — โค้ด core',
      '     ไม่ import อะไรจาก task 1).',
      '     Verify: pnpm -C core test.',
    ].join('\n');
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(body), tasks });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const { graph } = readGraph(dir, 'fixture-feat');
    assert.deepEqual(graph.tasks[1]!.depends_on, ['T-1'], 'only the first conforming run counts — no T-6/T-2/T-3 from the prose');
    assert.deepEqual(graph.tasks[1]!.satisfies, ['AC-6.2', 'AC-6.3'], 'Satisfies segment still ends at Depends on:');
    assert.deepEqual(graph.tasks[0]!.satisfies, ['AC-6.1']);
  });
});

test('indented checkbox block + title fallback/cut: block head parsed through the indent, title cut at 120 chars (REQ-2.1/2.9, D13)', { skip }, () => {
  withSpecsDir((dir) => {
    const body = ['## REQ-1: Indent', '', '- 1.1 THE SYSTEM SHALL a', '- 1.2 THE SYSTEM SHALL b'].join('\n');
    const longTitle = 'Indented checkbox block carrying a title long enough that the generator must cut it at exactly one hundred twenty characters, dropping this tail.';
    const tasks = [
      '## A nested checklist',
      '',
      `  - [ ] 1. ${longTitle}`,
      '       Satisfies: 1.1. Verify: pnpm test one',
      '  - [x] 2. Marker-less block keeps its whole remainder as the title.',
    ].join('\n');
    writeSpec(dir, 'fixture-feat', { requirements: reqDoc(body), tasks });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    const { graph } = readGraph(dir, 'fixture-feat');
    assert.deepEqual(graph.tasks.map((t) => t.id), ['T-1', 'T-2'], 'indented checkboxes are task blocks');
    assert.equal(graph.tasks[0]!.title, longTitle.slice(0, 120), 'title truncated to 120 (REQ-2.1)');
    assert.equal(graph.tasks[1]!.title, 'Marker-less block keeps its whole remainder as the title.', 'no marker -> whole remainder (D13)');
    assert.deepEqual(graph.tasks[1]!.satisfies, [], 'no Satisfies -> empty (shape-legal; freeze calls it an orphan)');
    assert.deepEqual(validateTaskGraphShape(graph), [], 'still schema-clean');
  });
});

test('generation fails on a dangling Depends ref / dangling Satisfies id / missing ordinal / duplicate ordinal — no draft written at all (REQ-2.6/2.8/2.9)', { skip }, () => {
  const body = ['## REQ-1: Fail', '', '- 1.1 THE SYSTEM SHALL a', '- 1.2 THE SYSTEM SHALL b'].join('\n');
  const cases: { feature: string; tasks: string; expect: RegExp }[] = [
    {
      feature: 'dangling-dep',
      tasks: ['- [ ] 1. One.', '     Satisfies: 1.1. Verify: pnpm test one', '- [ ] 2. Two.', '     Satisfies: 1.2. Depends on: 9. Verify: pnpm test two'].join('\n'),
      expect: /'Depends on:' references task 9 which has no task block/,
    },
    {
      feature: 'dangling-satisfies',
      tasks: ['- [ ] 1. One.', '     Satisfies: 1.1, 9.9. Verify: pnpm test one'].join('\n'),
      expect: /Satisfies ref AC-9\.9 has no matching criterion/,
    },
    {
      feature: 'no-ordinal',
      tasks: ['- [ ] 1. One.', '     Satisfies: 1.1. Verify: pnpm test one', '- [ ] Ordinal-less block that must be refused.', '     Satisfies: 1.2. Verify: pnpm test two'].join('\n'),
      expect: /no leading ordinal '- \[ \] N\.': - \[ \] Ordinal-less block/,
    },
    {
      feature: 'dup-ordinal',
      tasks: ['- [ ] 1. One.', '     Satisfies: 1.1. Verify: pnpm test one', '- [ ] 1. One again.', '     Satisfies: 1.2. Verify: pnpm test two'].join('\n'),
      expect: /duplicate task ordinal 1 in tasks\.md/,
    },
  ];
  for (const c of cases) {
    withSpecsDir((dir) => {
      const specDir = writeSpec(dir, c.feature, { requirements: reqDoc(body), tasks: c.tasks });
      const res = generate(dir, c.feature);
      assert.equal(res.status, 1, `${c.feature} must exit 1, got ${res.status}: ${res.stdout}`);
      assert.match(res.stderr, c.expect, c.feature);
      assert.deepEqual(readdirSync(specDir).sort(), ['requirements.md', 'tasks.md'], `${c.feature}: validation precedes output — neither draft written`);
    });
  }
});

test('output gate is per file: a stale graph draft blocks only itself, a stale goal draft blocks only itself, --force overwrites both (REQ-2.5)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(FULL_BODY), tasks: FULL_TASKS });
    assert.equal(generate(dir, 'fixture-feat').status, 0);
    const goalPath = join(specDir, 'goal.draft.yaml');
    const graphPath = join(specDir, 'task-graph.draft.json');
    const graphBefore = readFileSync(graphPath);

    // goal draft gone, graph draft stale -> goal is rewritten, graph refused, exit 1.
    rmSync(goalPath);
    const graphBlocked = generate(dir, 'fixture-feat');
    assert.equal(graphBlocked.status, 1);
    assert.match(graphBlocked.stderr, /task-graph\.draft\.json already exists — pass --force/);
    assert.ok(!graphBlocked.stderr.includes('goal.draft.yaml already exists'), 'the missing goal draft is not blocked by the graph collision');
    assert.match(graphBlocked.stdout, /goal\.draft\.yaml — 5 acceptance criteria/, 'the writable file IS written (D17)');
    assert.deepEqual(readFileSync(graphPath), graphBefore, 'colliding file left byte-identical');

    // Mirror: graph draft gone, goal draft stale.
    const goalBefore = readFileSync(goalPath);
    rmSync(graphPath);
    const goalBlocked = generate(dir, 'fixture-feat');
    assert.equal(goalBlocked.status, 1);
    assert.match(goalBlocked.stderr, /goal\.draft\.yaml already exists — pass --force/);
    assert.ok(!goalBlocked.stderr.includes('task-graph.draft.json already exists'));
    assert.match(goalBlocked.stdout, /task-graph\.draft\.json — 3 tasks/);
    assert.deepEqual(readFileSync(goalPath), goalBefore);

    // --force overwrites both.
    writeFileSync(goalPath, 'garbage');
    writeFileSync(graphPath, '{"garbage": true}');
    const forced = runGen(['fixture-feat', '--specs-dir', dir, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(readFileSync(goalPath, 'utf8'), /^# spec-to-goal draft/);
    assert.deepEqual(readGraph(dir, 'fixture-feat').graph.tasks.map((t) => t.id), ['T-1', 'T-2', 'T-3']);
  });
});

test('tasks.md absent: graph emission skipped with a stderr warning, goal draft still generated (REQ-2.4)', { skip }, () => {
  withSpecsDir((dir) => {
    const specDir = writeSpec(dir, 'fixture-feat', { requirements: reqDoc(PARTIAL_BODY) });
    const res = generate(dir, 'fixture-feat');
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /tasks\.md not found .* task-graph draft skipped/);
    assert.deepEqual(readdirSync(specDir).sort(), ['goal.draft.yaml', 'requirements.md'], 'goal draft still written, no graph');
  });
});

// Pre-flight sweep (design D18): REQ-2.6/2.8/2.9 make the generator strict about
// input that used to pass silently. Every approved spec in the repo must still
// generate — a failure here is a real spec to fix, never a check to weaken.
test('pre-flight sweep: every approved spec under .ai/specs still generates, and its graph draft is schema-clean (REQ-2.6/2.8/2.9, D18)', { skip }, () => {
  const specsRoot = join(repoRoot, '.ai', 'specs');
  const features = readdirSync(specsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive')
    .map((e) => e.name)
    .filter((name) => {
      const req = join(specsRoot, name, 'requirements.md');
      return readdirSync(join(specsRoot, name)).includes('requirements.md')
        && readdirSync(join(specsRoot, name)).includes('tasks.md')
        && readFileSync(req, 'utf8').split('\n').some((l) => l.startsWith('> Status: approved'));
    });
  assert.ok(features.length >= 5, `sweep must find the real corpus, found: ${features.join(', ')}`);

  withSpecsDir((dir) => {
    for (const feature of features) {
      // Copy only the two inputs — the sweep must never touch the repo's own specs.
      mkdirSync(join(dir, feature), { recursive: true });
      for (const file of ['requirements.md', 'tasks.md']) {
        cpSync(join(specsRoot, feature, file), join(dir, feature, file));
      }
      const res = generate(dir, feature);
      assert.equal(res.status, 0, `${feature} fails the stage-4 generator rules — fix the spec, not the validation:\n${res.stderr}`);
      const { graph } = readGraph(dir, feature);
      assert.deepEqual(validateTaskGraphShape(graph), [], `${feature} graph draft is schema-clean`);
      assert.ok(graph.tasks.length > 0);
    }
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
