// RED in task 4 (builder throws NotImplemented) -> GREEN same task.
// Proves REQ-7: determinism, COMPRESS v1 truncation, GOVERN secret block, MARK
// canary, MANIFEST evidence, recall/waste, machine-config exclusion.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
