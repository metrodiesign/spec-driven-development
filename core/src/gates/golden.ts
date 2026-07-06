// Golden harness (spec §6.5, REQ-9): test/golden/** is read-only for every role
// and its _MANIFEST.sha256 is recomputed at T1 — a mismatch fails the gate with
// golden_manifest_mismatch. Phase scope (REQ-9.3): this detects TAMPERING only;
// a vacuous-but-passing generated test is caught by the later RED-check, not here.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export type GoldenVerdict =
  | { ok: true; files: number }
  | { ok: false; reason: 'golden_manifest_mismatch' | 'manifest_missing'; detail: string };

const MANIFEST = '_MANIFEST.sha256';

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Manifest format: `<sha256>  <path relative to golden dir>` per line, sorted. */
export function computeGoldenManifest(goldenDir: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name !== MANIFEST) {
        lines.push(`${sha256Hex(readFileSync(p))}  ${relative(goldenDir, p)}`);
      }
    }
  };
  walk(goldenDir);
  return lines.sort().join('\n') + '\n';
}

export function verifyGoldenManifest(worktreeDir: string): GoldenVerdict {
  const goldenDir = join(worktreeDir, 'test', 'golden');
  const manifestPath = join(goldenDir, MANIFEST);
  // Fail-closed: a target without a frozen golden manifest has no independent
  // truth base — that is a gate failure, not a silent pass.
  if (!existsSync(goldenDir) || !existsSync(manifestPath)) {
    return {
      ok: false,
      reason: 'manifest_missing',
      detail: `expected ${MANIFEST} under test/golden/`,
    };
  }
  const recorded = readFileSync(manifestPath, 'utf8');
  const actual = computeGoldenManifest(goldenDir);
  if (recorded !== actual) {
    const recordedSet = new Set(recorded.split('\n').filter((l) => l.length > 0));
    const actualSet = new Set(actual.split('\n').filter((l) => l.length > 0));
    const changed = [
      ...[...actualSet].filter((l) => !recordedSet.has(l)).map((l) => `+ ${l}`),
      ...[...recordedSet].filter((l) => !actualSet.has(l)).map((l) => `- ${l}`),
    ];
    return {
      ok: false,
      reason: 'golden_manifest_mismatch',
      detail: changed.join('; ').slice(0, 2000),
    };
  }
  return { ok: true, files: actual.split('\n').filter((l) => l.length > 0).length };
}
