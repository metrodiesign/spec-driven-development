// Golden truth is an operator-owned, read-only input (REQ-8).  This module may
// verify and copy those bytes, but it must never create a manifest or invent a
// golden test. Manifest bytes are treated as input and are intentionally not
// exposed through a truth-generation API.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const MANIFEST = '_MANIFEST.sha256';

export type GoldenVerdict =
  | { ok: true; files: number }
  | { ok: false; reason: 'golden_manifest_mismatch' | 'manifest_missing'; detail: string };

export type GoldenFixtureErrorCode =
  | 'operator_golden_fixture_missing'
  | 'operator_golden_fixture_invalid'
  | 'operator_golden_fixture_target_exists';

export class GoldenFixtureError extends Error {
  readonly code: GoldenFixtureErrorCode;

  constructor(code: GoldenFixtureErrorCode, message: string) {
    super(message);
    this.name = 'GoldenFixtureError';
    this.code = code;
  }
}

export interface GoldenFixtureProvenance {
  source: string;
  sourceHash: string;
  target: string;
  manifestHash: string;
  files: number;
  attribution: 'operator-supplied';
}

export interface GoldenManifestCheckOptions {
  /** Trusted bytes/hash captured outside the mutable golden directory. */
  expectedManifestHashes?: Readonly<Record<string, string>>;
}

export type GoldenManifestsVerdict =
  | { ok: true; roots: Array<{ root: string; files: number; manifestHash: string; sourceHash: string }> }
  | { ok: false; reason: 'golden_manifest_mismatch' | 'manifest_missing'; detail: string; root: string };

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.name === MANIFEST && dir === root) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new GoldenFixtureError('operator_golden_fixture_invalid', `unsupported golden node: ${path}`);
    }
  };
  walk(root);
  return files;
}

/** Internal verifier representation with the canonical manifest bytes retained. */
function canonicalManifest(root: string): { bytes: string; files: number } {
  // Sort by relative path (code units), matching `find | sort` under LC_ALL=C in
  // scripts/check-golden-manifests.sh and plain `shasum`-generated manifests.
  // Sorting the full hash-prefixed lines would order by digest and reject real
  // operator manifests whose name order differs from hash order.
  const lines = walkFiles(root)
    .map((path) => ({ rel: relative(root, path).split(sep).join('/'), path }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ rel, path }) => `${sha256Hex(readFileSync(path))}  ${rel}`);
  return { bytes: lines.length === 0 ? '' : `${lines.join('\n')}\n`, files: lines.length };
}

function describeMismatch(recorded: string, actual: string): string {
  const recordedSet = new Set(recorded.split('\n').filter((line) => line.length > 0));
  const actualSet = new Set(actual.split('\n').filter((line) => line.length > 0));
  const changed = [
    ...[...actualSet].filter((line) => !recordedSet.has(line)).map((line) => `+ ${line}`),
    ...[...recordedSet].filter((line) => !actualSet.has(line)).map((line) => `- ${line}`),
  ];
  return changed.join('; ').slice(0, 2000) || 'manifest formatting or duplicate-entry mismatch';
}

/** Verify one `test/golden` directory against its operator-supplied manifest. */
export function verifyGoldenManifest(worktreeDir: string, options: GoldenManifestCheckOptions = {}): GoldenVerdict {
  const goldenDir = join(worktreeDir, 'test', 'golden');
  return verifyGoldenRoot(goldenDir, options);
}

/** Verify one configured golden root. `root` is the directory containing the manifest. */
export function verifyGoldenRoot(rootInput: string, options: GoldenManifestCheckOptions = {}): GoldenVerdict {
  const root = resolve(rootInput);
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(root) || !existsSync(manifestPath)) {
    return { ok: false, reason: 'manifest_missing', detail: `expected ${MANIFEST} under ${root}`, };
  }
  if (!statSync(root).isDirectory() || !lstatSync(manifestPath).isFile()) {
    return { ok: false, reason: 'manifest_missing', detail: `expected regular golden root ${root}`, };
  }
  const recorded = readFileSync(manifestPath, 'utf8');
  let actual: { bytes: string; files: number };
  try {
    actual = canonicalManifest(root);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'golden_manifest_mismatch', detail };
  }
  const expectedManifestHash = Object.entries(options.expectedManifestHashes ?? {}).find(
    ([key]) => key === rootInput || resolve(key) === root,
  )?.[1];
  if (expectedManifestHash !== undefined && sha256Hex(Buffer.from(recorded)) !== expectedManifestHash) {
    return { ok: false, reason: 'golden_manifest_mismatch', detail: `manifest hash mismatch for ${manifestPath}`, };
  }
  if (actual.files === 0) {
    return { ok: false, reason: 'golden_manifest_mismatch', detail: 'operator golden manifest contains no files', };
  }
  if (recorded !== actual.bytes) {
    return { ok: false, reason: 'golden_manifest_mismatch', detail: describeMismatch(recorded, actual.bytes), };
  }
  return { ok: true, files: actual.files };
}

/**
 * Verify every manifest under configured roots. Roots may be manifest directories
 * themselves or a parent tree; a parent is recursively scanned for manifests.
 */
export function verifyGoldenManifests(
  roots: readonly string[],
  options: GoldenManifestCheckOptions = {},
): GoldenManifestsVerdict {
  const manifests: string[] = [];
  const seen = new Set<string>();
  const discover = (rootInput: string): void => {
    const root = resolve(rootInput);
    if (!existsSync(root)) return;
    const info = lstatSync(root);
    if (info.isFile()) {
      if (basename(root) === MANIFEST && !seen.has(dirname(root))) {
        seen.add(dirname(root));
        manifests.push(dirname(root));
      }
      return;
    }
    if (!info.isDirectory()) return;
    if (basename(root) === MANIFEST) return;
    if (existsSync(join(root, MANIFEST))) {
      if (!seen.has(root)) {
        seen.add(root);
        manifests.push(root);
      }
      return;
    }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) discover(join(root, entry.name));
    }
  };
  for (const root of roots) discover(root);
  if (manifests.length === 0) {
    return { ok: false, reason: 'manifest_missing', detail: 'no operator-supplied _MANIFEST.sha256 found', root: roots[0] ?? '' };
  }
  manifests.sort();
  const checked: Array<{ root: string; files: number; manifestHash: string; sourceHash: string }> = [];
  for (const root of manifests) {
    const verdict = verifyGoldenRoot(root, options);
    if (!verdict.ok) return { ...verdict, root };
    const manifestBytes = readFileSync(join(root, MANIFEST));
    checked.push({ root, files: verdict.files, manifestHash: sha256Hex(manifestBytes), sourceHash: hashGoldenTree(root) });
  }
  return { ok: true, roots: checked };
}

/**
 * Copy operator bytes only. The target must not already contain files, and no
 * manifest is generated or rewritten by this operation.
 */
export function copyOperatorGoldenFixture(sourceGoldenDirInput: string, targetGoldenDirInput: string): GoldenFixtureProvenance {
  const sourceInput = resolve(sourceGoldenDirInput);
  // Accept either the operator's fixture root or its explicit `test/golden`
  // directory; the bytes copied are always the latter.
  const source = existsSync(join(sourceInput, MANIFEST)) ? sourceInput : join(sourceInput, 'test', 'golden');
  const target = resolve(targetGoldenDirInput);
  if (!existsSync(source) || !existsSync(join(source, MANIFEST))) {
    throw new GoldenFixtureError('operator_golden_fixture_missing', `operator golden fixture is missing: ${sourceInput}`);
  }
  if (!lstatSync(source).isDirectory()) {
    throw new GoldenFixtureError('operator_golden_fixture_invalid', `operator golden fixture is not a directory: ${source}`);
  }
  const sourceVerdict = verifyGoldenRoot(source);
  if (!sourceVerdict.ok) {
    throw new GoldenFixtureError('operator_golden_fixture_invalid', `${sourceVerdict.reason}: ${sourceVerdict.detail}`);
  }
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory()) {
      throw new GoldenFixtureError('operator_golden_fixture_target_exists', `target golden path is not a directory: ${target}`);
    }
    const entries = readdirSync(target);
    if (entries.length > 0) {
      throw new GoldenFixtureError('operator_golden_fixture_target_exists', `target golden directory is not empty: ${target}`);
    }
  } else {
    mkdirSync(target, { recursive: true });
  }
  for (const path of walkFiles(source)) {
    const rel = relative(source, path);
    const destination = join(target, rel);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination, { errorOnExist: true, force: false });
  }
  // walkFiles intentionally excludes only a root manifest, so copy that exact
  // operator byte separately; there is no regeneration path here.
  cpSync(join(source, MANIFEST), join(target, MANIFEST), { errorOnExist: true, force: false });
  const manifestBytes = readFileSync(join(source, MANIFEST));
  return {
    source,
    sourceHash: hashGoldenTree(source),
    target,
    manifestHash: sha256Hex(manifestBytes),
    files: sourceVerdict.files,
    attribution: 'operator-supplied',
  };
}

function hashGoldenTree(root: string): string {
  const hash = createHash('sha256');
  for (const path of walkFiles(root).sort()) {
    hash.update(relative(root, path).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  hash.update(MANIFEST);
  hash.update('\0');
  hash.update(readFileSync(join(root, MANIFEST)));
  return hash.digest('hex');
}
