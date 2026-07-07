// Deterministic Context Builder v1 (spec §9.4, REQ-7). Six stages:
// SEED -> EXPAND -> COMPRESS(v1 whole-file + rule truncation) -> GOVERN(secret
// block) -> MARK(untrusted-data markers + injection canary) -> MANIFEST. Pure
// function of (contract, worktree files, seedPaths, canaryToken): identical
// inputs => byte-identical manifest.
//
// Machine-config exclusion (REQ-7.7) is enforced by core but PARAMETERIZED: the
// list of machine-config paths is vendor-specific, so naming those files here
// would violate INV-7 (core must be vendor-name-free). The caller — the
// composition root, which is allowed to know the vendor — supplies `excludePath`;
// core honors whatever predicate it is given and defaults to excluding nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scanForSecret } from './secret-scan.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { ContextBundle, ContextPiece, TaskContractExcerpt } from '../types.ts';

export interface ContextBuildInput {
  taskId: string;
  taskContract: TaskContractExcerpt;
  worktreeDir: string;
  seedPaths: string[];
  canaryToken: string;
  evidence: EvidenceStore;
  maxFileBytes?: number;
  depthBudget?: number;
  /** Caller-supplied machine-config matcher (REQ-7.7). Vendor-specific list lives OUTSIDE core. */
  excludePath?: (relPath: string) => boolean;
}

export interface ContextBuildResult {
  bundle: ContextBundle;
  manifestRef: string;
  rules: { pieceId: string; reason: string }[];
}

export class SecretInContextError extends Error {
  readonly file: string;
  readonly kind: string;
  constructor(file: string, kind: string) {
    super(`secret detected in ${file} (${kind}); bundle build blocked — content NOT sent`);
    this.file = file;
    this.kind = kind;
    this.name = 'SecretInContextError';
  }
}

const DEFAULT_MAX_FILE_BYTES = 8_000;

/** EXPAND: local relative imports referenced by a file's content. */
function localImports(content: string): string[] {
  const out = new Set<string>();
  const re = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return [...out];
}

function truncate(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) return content;
  return content.slice(0, maxBytes) + '\n…[truncated]';
}

export function buildContext(input: ContextBuildInput): ContextBuildResult {
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const depthBudget = input.depthBudget ?? 1;
  const excludePath = input.excludePath ?? (() => false);

  // SEED + EXPAND: collect a deterministic set of {path, reason}, machine config excluded.
  const collected = new Map<string, string>(); // path -> reason
  const visit = (relPath: string, reason: string, depth: number): void => {
    if (excludePath(relPath) || collected.has(relPath)) return;
    let content: string;
    try {
      content = readFileSync(join(input.worktreeDir, relPath), 'utf8');
    } catch {
      return; // a missing seed/import is simply not included (recall will reflect it)
    }
    collected.set(relPath, reason);
    if (depth < depthBudget) {
      for (const imp of localImports(content)) {
        // Resolve a relative import against the repo root, best-effort with .ts.
        const cand = imp.replace(/^\.\//, '').replace(/^\.\.\//, '');
        visit(cand.endsWith('.ts') ? cand : `${cand}.ts`, `expand:depth-${depth + 1}`, depth + 1);
      }
    }
  };
  for (const p of input.seedPaths) visit(p, 'seed', 0);

  // Deterministic order: sort by path, THEN assign stable piece ids.
  const paths = [...collected.keys()].sort();

  // COMPRESS + GOVERN + MARK.
  const pieces: ContextPiece[] = [];
  const rules: { pieceId: string; reason: string }[] = [];
  paths.forEach((relPath, i) => {
    const full = readFileSync(join(input.worktreeDir, relPath), 'utf8');
    const hit = scanForSecret(full); // GOVERN scans the FULL file, pre-truncation
    if (hit.hit) throw new SecretInContextError(relPath, hit.kind ?? 'unknown');
    const reason = collected.get(relPath) ?? 'seed';
    const id = `p-${i}`;
    pieces.push({ id, kind: 'file', path: relPath, content: truncate(full, maxFileBytes), reason });
    rules.push({ pieceId: id, reason });
  });

  const bytes = pieces.reduce((n, p) => n + p.content.length, 0);
  const bundle: ContextBundle = {
    pieces,
    canaryToken: input.canaryToken,
    stats: { bytes, pieceCount: pieces.length },
  };

  // MANIFEST — canonical JSON (sorted keys) so identical inputs hash identically.
  const manifest = {
    taskId: input.taskId,
    canaryToken: input.canaryToken,
    rules,
    stats: bundle.stats,
  };
  const manifestRef = input.evidence.put(JSON.stringify(manifest));
  return { bundle, manifestRef, rules };
}

export function computeContextMetrics(
  bundle: ContextBundle,
  touchedPaths: string[],
): { recall: number; waste: number } {
  const bundlePaths = new Set(bundle.pieces.map((p) => p.path).filter((p): p is string => p !== undefined));
  const touched = new Set(touchedPaths);
  const inBoth = [...touched].filter((p) => bundlePaths.has(p)).length;
  const recall = touched.size === 0 ? 1 : inBoth / touched.size;
  const unused = [...bundlePaths].filter((p) => !touched.has(p)).length;
  const waste = bundlePaths.size === 0 ? 0 : unused / bundlePaths.size;
  return { recall, waste };
}

export function serializeBundle(bundle: ContextBundle): string {
  return bundle.pieces
    .map(
      (p) =>
        `<<<UNTRUSTED-DATA canary=${bundle.canaryToken}>>>\n` +
        `[piece ${p.id} | path=${p.path ?? '(inline)'} | reason=${p.reason}]\n` +
        `${p.content}\n` +
        `<<<END-UNTRUSTED-DATA>>>`,
    )
    .join('\n');
}
