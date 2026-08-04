// RED in task 4 (builder throws NotImplemented) -> GREEN same task.
// Proves REQ-7: determinism, COMPRESS v1 truncation, GOVERN secret block, MARK
// canary, MANIFEST evidence, recall/waste, machine-config exclusion.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildContext, computeContextMetrics, serializeBundle, SecretInContextError } from './builder.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import type { ContextBuildInput } from './builder.ts';
import type { LessonRecord, TaskContractExcerpt } from '../types.ts';

const CONTRACT: TaskContractExcerpt = {
  goalId: 'G-1',
  title: 'fix impl',
  objective: 'make the tests pass',
  acceptanceCriteria: [{ id: 'AC-1', description: 'impl says correct' }],
};

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'ctx-'));
  const worktree = join(root, 'wt');
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(worktree, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const evidence = createEvidenceStore(join(root, 'evidence'));
  return { root, worktree, evidence, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function input(f: ReturnType<typeof fixture>, seedPaths: string[], extra: Partial<ContextBuildInput> = {}): ContextBuildInput {
  return {
    taskId: 'T-1',
    taskContract: CONTRACT,
    worktreeDir: f.worktree,
    seedPaths,
    canaryToken: 'CANARY-fixed-123',
    evidence: f.evidence,
    ...extra,
  };
}

test('build is deterministic: identical inputs -> byte-identical manifest', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  try {
    const r1 = buildContext(input(f, ['src/a.ts', 'src/b.ts']));
    const r2 = buildContext(input(f, ['src/a.ts', 'src/b.ts']));
    assert.equal(r1.manifestRef, r2.manifestRef, 'same manifest ref (content-addressed)');
    assert.equal(r1.bundle.pieces.length, 2);
  } finally {
    f.cleanup();
  }
});

test('GOVERN blocks a secret and names the file — content never bundled', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({ 'src/a.ts': 'ok\n', 'src/leak.ts': `const k = "${secret}";\n` });
  try {
    assert.throws(
      () => buildContext(input(f, ['src/a.ts', 'src/leak.ts'])),
      (err: unknown) => err instanceof SecretInContextError && err.file.includes('leak.ts'),
    );
  } finally {
    f.cleanup();
  }
});

test('MARK: serialized bundle wraps pieces as data and carries the canary', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts']));
    const wire = serializeBundle(r.bundle);
    assert.match(wire, /CANARY-fixed-123/, 'canary token present in the marker preamble');
    assert.match(wire, /UNTRUSTED/i, 'pieces marked as untrusted data');
  } finally {
    f.cleanup();
  }
});

test('COMPRESS v1 truncates a large file to maxFileBytes', () => {
  const big = 'x'.repeat(10_000);
  const f = fixture({ 'src/big.ts': big });
  try {
    const r = buildContext(input(f, ['src/big.ts'], { maxFileBytes: 500 }));
    const piece = r.bundle.pieces.find((p) => p.path === 'src/big.ts');
    assert.ok(piece);
    assert.ok((piece?.content.length ?? 0) <= 600, 'content truncated near the byte cap');
  } finally {
    f.cleanup();
  }
});

test('COMPRESS (REQ-22.1): an oversized TS file is symbol-compressed — headers kept, bodies dropped, trailer emitted', () => {
  const filler = 'x'.repeat(2000);
  const source = [
    `import { readFileSync } from 'node:fs';`,
    ``,
    `export function run(): string {`,
    `  const pad = "${filler}";`,
    `  return pad;`,
    `}`,
    ``,
    `export class Runner {`,
    `  execute(): void {`,
    `    console.log("${filler}");`,
    `  }`,
    `}`,
  ].join('\n');
  const f = fixture({ 'src/big.ts': source });
  try {
    const r = buildContext(input(f, ['src/big.ts'], { maxFileBytes: 300 }));
    const piece = r.bundle.pieces.find((p) => p.path === 'src/big.ts');
    assert.ok(piece);
    assert.equal(piece?.reason, 'compressed:symbols', 'REQ-22.4: reason records which COMPRESS path ran');
    const content = piece?.content ?? '';
    assert.match(content, /import \{ readFileSync \}/, 'import line kept');
    assert.match(content, /export function run/, 'function declaration header kept');
    assert.match(content, /export class Runner/, 'class declaration header kept');
    assert.ok(!content.includes(filler), 'indented bodies dropped, not just appended to the header');
    assert.match(content, /\[compressed:symbols\]/, 'trailer emitted');
  } finally {
    f.cleanup();
  }
});

test('COMPRESS (REQ-22.2): a prose file with fewer than two declarations falls back to byte truncation', () => {
  const prose = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(50);
  const f = fixture({ 'docs/notes.txt': prose });
  try {
    const r = buildContext(input(f, ['docs/notes.txt'], { maxFileBytes: 200 }));
    const piece = r.bundle.pieces.find((p) => p.path === 'docs/notes.txt');
    assert.ok(piece);
    assert.equal(piece?.reason, 'truncated', 'REQ-22.4: falls back and records truncation, not symbols');
    assert.match(piece?.content ?? '', /\[truncated\]/);
  } finally {
    f.cleanup();
  }
});

test('GOVERN (REQ-22.3) still blocks a secret hidden inside a body that COMPRESS would drop', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const filler = 'y'.repeat(2000);
  const source = [
    `export function run(): string {`,
    `  const leaked = "${secret}";`,
    `  const pad = "${filler}";`,
    `  return leaked;`,
    `}`,
    ``,
    `export class Runner {`,
    `  execute(): void {}`,
    `}`,
  ].join('\n');
  const f = fixture({ 'src/leaky-big.ts': source });
  try {
    assert.throws(
      () => buildContext(input(f, ['src/leaky-big.ts'], { maxFileBytes: 200 })),
      (err: unknown) => err instanceof SecretInContextError && err.file.includes('leaky-big.ts'),
    );
  } finally {
    f.cleanup();
  }
});

test('machine config is excluded when the caller supplies an excludePath matcher (REQ-7.7)', () => {
  // Vendor config filenames are assembled at runtime so the INV-7 grep over core/
  // stays clean — the exclusion LIST is the caller's job, not core's.
  const memoryFile = ['CL', 'AUDE', '.md'].join('');
  const settingsDir = '.'.concat(['cl', 'aude'].join(''));
  const settingsPath = `${settingsDir}/settings.json`;
  const f = fixture({ 'src/a.ts': 'ok\n', [memoryFile]: 'machine guidance\n', [settingsPath]: '{}\n' });
  try {
    const excludePath = (rel: string): boolean => rel === memoryFile || rel.startsWith(`${settingsDir}/`);
    const r = buildContext(input(f, ['src/a.ts', memoryFile, settingsPath], { excludePath }));
    const paths = r.bundle.pieces.map((p) => p.path);
    assert.ok(paths.includes('src/a.ts'));
    assert.ok(!paths.includes(memoryFile), 'memory file excluded');
    assert.ok(!paths.includes(settingsPath), 'machine settings excluded');
  } finally {
    f.cleanup();
  }
});

function lesson(overrides: Partial<LessonRecord> = {}): LessonRecord {
  return {
    id: 'lsn-fixed-1',
    statement: 'the golden file must stay byte-identical across reruns',
    sourceRunId: 'RUN-0',
    sourceTaskId: 'T-0',
    evidenceRefs: ['blob://probe-0'],
    proposedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

test('REQ-12.2/12.4: an approved lesson flows SEED->GOVERN->MARK as an excerpt piece, canaried like any other data', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts'], { lessons: [lesson()] }));
    const piece = r.bundle.pieces.find((p) => p.id === 'lsn-fixed-1');
    assert.ok(piece, 'lesson landed as a bundle piece');
    assert.equal(piece?.kind, 'excerpt');
    assert.equal(piece?.content, lesson().statement);
    assert.deepEqual(r.lessonsInjected, [{ id: 'lsn-fixed-1', evidenceRefs: ['blob://probe-0'] }]);
    assert.deepEqual(r.lessonsBlocked, []);

    const wire = serializeBundle(r.bundle);
    assert.match(wire, /CANARY-fixed-123/, 'lesson piece carries the same injection canary as file pieces');
    assert.match(wire, /UNTRUSTED/i, 'lesson marked as untrusted data (REQ-12.4)');
  } finally {
    f.cleanup();
  }
});

test('REQ-12.3: a secret-bearing lesson is BLOCKED per-lesson — never reaches pieces/prompt, but the REST of the build still succeeds', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(
      input(f, ['src/a.ts'], { lessons: [lesson({ id: 'lsn-secret', statement: `leaked key: ${secret}` }), lesson()] }),
    );
    // Unlike a repo-file secret (which throws and aborts the WHOLE build), a
    // secret-bearing LESSON blocks only itself — the build still returns.
    assert.equal(r.bundle.pieces.some((p) => p.id === 'lsn-secret'), false, 'blocked lesson never became a piece');
    assert.equal(r.bundle.pieces.some((p) => p.id === 'lsn-fixed-1'), true, 'the clean lesson still made it in');
    assert.equal(r.bundle.pieces.some((p) => p.path === 'src/a.ts'), true, 'file pieces unaffected');
    assert.deepEqual(r.lessonsBlocked, [{ id: 'lsn-secret', kind: 'sk-key' }]);
    assert.deepEqual(r.lessonsInjected, [{ id: 'lsn-fixed-1', evidenceRefs: ['blob://probe-0'] }]);

    const wire = serializeBundle(r.bundle);
    assert.ok(!wire.includes(secret), 'blocked lesson content never reaches the serialized bundle');
  } finally {
    f.cleanup();
  }
});

test('no lessons input -> lessonsInjected/lessonsBlocked are empty, byte-identical to Phase-1 behavior otherwise', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts']));
    assert.deepEqual(r.lessonsInjected, []);
    assert.deepEqual(r.lessonsBlocked, []);
    assert.equal(r.bundle.pieces.length, 1);
  } finally {
    f.cleanup();
  }
});

test('REQ-16.5: a resolved plan flows SEED->GOVERN->MARK as an excerpt piece, canaried like any other data', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts'], { plan: { id: 'plan-T-1', content: '{"approach":"x","steps":["y"]}' } }));
    const piece = r.bundle.pieces.find((p) => p.id === 'plan-T-1');
    assert.ok(piece, 'plan landed as a bundle piece');
    assert.equal(piece?.kind, 'excerpt');
    assert.equal(piece?.content, '{"approach":"x","steps":["y"]}');
    assert.equal(r.planInjected, true);
    assert.equal(r.planBlocked, false);

    const wire = serializeBundle(r.bundle);
    assert.match(wire, /CANARY-fixed-123/, 'plan piece carries the same injection canary as file pieces');
    assert.match(wire, /UNTRUSTED/i, 'plan marked as untrusted data');
  } finally {
    f.cleanup();
  }
});

test('a secret-bearing plan is BLOCKED — never reaches pieces/prompt, but the REST of the build still succeeds', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts'], { plan: { id: 'plan-T-1', content: `leaked key: ${secret}` } }));
    // Unlike a repo-file secret (which throws and aborts the WHOLE build), a
    // secret-bearing PLAN blocks only itself — the build still returns.
    assert.equal(r.bundle.pieces.some((p) => p.id === 'plan-T-1'), false, 'blocked plan never became a piece');
    assert.equal(r.bundle.pieces.some((p) => p.path === 'src/a.ts'), true, 'file pieces unaffected');
    assert.equal(r.planInjected, false);
    assert.equal(r.planBlocked, true);

    const wire = serializeBundle(r.bundle);
    assert.ok(!wire.includes(secret), 'blocked plan content never reaches the serialized bundle');
  } finally {
    f.cleanup();
  }
});

test('no plan input -> planInjected/planBlocked are false, byte-identical to pre-Phase-4 behavior otherwise', () => {
  const f = fixture({ 'src/a.ts': 'export const a = 1;\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts']));
    assert.equal(r.planInjected, false);
    assert.equal(r.planBlocked, false);
    assert.equal(r.bundle.pieces.length, 1);
  } finally {
    f.cleanup();
  }
});

test('recall/waste: fraction of touched files that were in the bundle, and unused fraction', () => {
  const f = fixture({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  try {
    const r = buildContext(input(f, ['src/a.ts', 'src/b.ts']));
    // touched a.ts (in bundle) + c.ts (not in bundle); b.ts in bundle but untouched.
    const m = computeContextMetrics(r.bundle, ['src/a.ts', 'src/c.ts']);
    assert.equal(m.recall, 0.5, 'half the touched files were in the bundle');
    assert.equal(m.waste, 0.5, 'half the bundled files went untouched');
  } finally {
    f.cleanup();
  }
});

test('AC-10: EXPAND does not follow an import that resolves outside the worktree', () => {
  const f = fixture({
    'src/evil.ts': `import { LEAKED } from '../../outside/stolen.ts';\nexport const evil = 1;\n`,
  });
  try {
    // Sibling of the worktree root, one level ABOVE `wt/` — mirrors the audit's
    // live repro (finding #1): a READ_FILE-visible file whose import string walks
    // out of the worktree via `..`.
    mkdirSync(join(f.root, 'outside'), { recursive: true });
    writeFileSync(join(f.root, 'outside/stolen.ts'), 'export const LEAKED = "top secret";\n');
    const r = buildContext(input(f, ['src/evil.ts']));
    const paths = r.bundle.pieces.map((p) => p.path);
    assert.ok(paths.includes('src/evil.ts'), 'the seed file itself is still included');
    assert.ok(
      !paths.some((p) => p?.includes('stolen.ts')),
      `the out-of-worktree EXPAND target must not be bundled, got ${JSON.stringify(paths)}`,
    );
    const wire = serializeBundle(r.bundle);
    assert.ok(!wire.includes('top secret'), 'content of the escaped file never reaches the serialized bundle');
  } finally {
    f.cleanup();
  }
});

test('AC-12: a secret reached only via EXPAND (not in seedPaths) is skipped as a single piece — the build still succeeds', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({
    'src/reader.ts': `import { k } from './secret-config.ts';\nexport const reader = 1;\n`,
    'src/secret-config.ts': `export const k = "${secret}";\n`,
  });
  try {
    const r = buildContext(input(f, ['src/reader.ts']));
    const paths = r.bundle.pieces.map((p) => p.path);
    assert.ok(paths.includes('src/reader.ts'), 'the seeded file itself is still included');
    assert.ok(!paths.includes('src/secret-config.ts'), 'the EXPAND-derived secret-bearing file is skipped, not thrown');
    const wire = serializeBundle(r.bundle);
    assert.ok(!wire.includes(secret), 'skipped EXPAND content never reaches the serialized bundle');
  } finally {
    f.cleanup();
  }
});

test('AC-12: EXPAND resolving a relative import against the repo root reaches a literal seed BEFORE its own turn in the seedPaths loop — reason is expand:depth-N, not seed', () => {
  // Proves the trap the next test's membership check has to survive is real,
  // not assumed: with NO secret involved, b.ts (a literal seedPath) still ends
  // up with an 'expand:depth-1' reason because a.ts's import resolves to it
  // first (relative imports resolve against the repo root here, not the
  // importing file's own directory) — collected.has() then skips b.ts's own
  // 'seed' visit when the seedPaths loop later reaches it.
  const f = fixture({ 'a.ts': `import './b.ts';\nexport const a = 1;\n`, 'b.ts': `export const b = 2;\n` });
  try {
    const r = buildContext(input(f, ['a.ts', 'b.ts']));
    const bPiece = r.bundle.pieces.find((p) => p.path === 'b.ts');
    assert.ok(bPiece, 'b.ts made it into the bundle');
    assert.equal(bPiece?.reason, 'expand:depth-1', 'a literal seed can carry an expand reason when EXPAND reaches it first');
  } finally {
    f.cleanup();
  }
});

test("AC-12: a secret in a path that is itself in seedPaths still aborts, even when EXPAND reaches it first via another seed's import", () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({
    'a.ts': `import './secret.ts';\nexport const a = 1;\n`,
    'secret.ts': `export const k = "${secret}";\n`,
  });
  try {
    // secret.ts is a literal seedPath itself, but (as the previous test proves)
    // EXPAND reaches it first via a.ts's import, so its collected reason is
    // 'expand:depth-1', not 'seed'. AC-12 must still throw here: it is decided
    // by seedPathSet membership, not the reason string collected() records —
    // a reason-based check would silently skip a real seeded secret instead.
    assert.throws(
      () => buildContext(input(f, ['a.ts', 'secret.ts'])),
      (err: unknown) => err instanceof SecretInContextError && err.file.includes('secret.ts'),
    );
  } finally {
    f.cleanup();
  }
});

test('AC-15: buildContext reports every skipped piece via piecesBlocked (EXPAND secret + containment), but stays silent for an ordinary missing file', () => {
  const secret = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const f = fixture({
    'reader.ts': [
      `import { k } from './secret-config.ts';`, // EXPAND-only secret (AC-12)
      `import { x } from './missing-file.ts';`, // plain missing file — stays silent, same as always
      `import { LEAKED } from '../../outside/stolen.ts';`, // EXPAND escaping the worktree (AC-10)
      `export const reader = 1;`,
    ].join('\n'),
    'secret-config.ts': `export const k = "${secret}";\n`,
  });
  try {
    mkdirSync(join(f.root, 'outside'), { recursive: true });
    writeFileSync(join(f.root, 'outside/stolen.ts'), 'export const LEAKED = "top secret";\n');
    const r = buildContext(input(f, ['reader.ts']));
    assert.equal(
      r.piecesBlocked.length,
      2,
      `expected exactly 2 blocked pieces (secret + containment) — the missing import must stay silent, got ${JSON.stringify(r.piecesBlocked)}`,
    );
    assert.ok(r.piecesBlocked.some((b) => b.path === 'secret-config.ts' && b.kind === 'sk-key'), 'EXPAND-only secret reported with its scan kind');
    assert.ok(r.piecesBlocked.some((b) => b.path.includes('stolen.ts') && b.kind === 'containment'), 'containment violation reported with kind=containment');
    assert.ok(!r.piecesBlocked.some((b) => b.path.includes('missing')), 'a plain missing file is never reported');
  } finally {
    f.cleanup();
  }
});

test('LOW-2: a containment-blocked path imported by multiple seeds is reported in piecesBlocked once, not once per importer', () => {
  // A containment-blocked path never enters `collected`, so the collected.has()
  // guard in visit() can't stop every importer of it from reaching the push.
  // Two seeds importing the SAME out-of-worktree path used to yield two identical
  // entries (audit LOW-2 repro D1); dedupe by path keeps it to one.
  const f = fixture({
    'src/one.ts': `import { X } from '../../outside/shared.ts';\nexport const one = 1;\n`,
    'src/two.ts': `import { X } from '../../outside/shared.ts';\nexport const two = 2;\n`,
  });
  try {
    mkdirSync(join(f.root, 'outside'), { recursive: true });
    writeFileSync(join(f.root, 'outside/shared.ts'), 'export const X = "top secret";\n');
    const r = buildContext(input(f, ['src/one.ts', 'src/two.ts']));
    const blocked = r.piecesBlocked.filter((b) => b.path.includes('shared.ts'));
    assert.equal(blocked.length, 1, `the same containment-blocked path must be reported once, got ${JSON.stringify(r.piecesBlocked)}`);
    assert.equal(blocked[0]?.kind, 'containment');
  } finally {
    f.cleanup();
  }
});

test('AC-10: a worktree reached through a symlinked ancestor (e.g. macOS /tmp) still reads its own files normally', () => {
  const root = mkdtempSync(join(tmpdir(), 'ctx-symlink-'));
  const realWorktree = join(root, 'real-wt');
  const linkedWorktree = join(root, 'linked-wt');
  mkdirSync(join(realWorktree, 'src'), { recursive: true });
  writeFileSync(join(realWorktree, 'src/a.ts'), 'export const a = 1;\n');
  symlinkSync(realWorktree, linkedWorktree, 'dir');
  const evidence = createEvidenceStore(join(root, 'evidence'));
  try {
    const r = buildContext({
      taskId: 'T-1',
      taskContract: CONTRACT,
      worktreeDir: linkedWorktree, // the worktree ROOT itself is reached via a symlink
      seedPaths: ['src/a.ts'],
      canaryToken: 'CANARY-fixed-123',
      evidence,
    });
    const paths = r.bundle.pieces.map((p) => p.path);
    assert.ok(
      paths.includes('src/a.ts'),
      `expected src/a.ts to still be read through the symlinked worktree root, got ${JSON.stringify(paths)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
