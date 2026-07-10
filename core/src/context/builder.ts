// Deterministic Context Builder v1 (spec §9.4, REQ-7). Six stages:
// SEED -> EXPAND -> COMPRESS(symbol-heuristic reduction, byte-truncation
// fallback; REQ-22) -> GOVERN(secret block) -> MARK(untrusted-data markers +
// injection canary) -> MANIFEST. Pure
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
import type { ContextBundle, ContextPiece, LessonRecord, TaskContractExcerpt } from '../types.ts';

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
  /**
   * REQ-12: approved lessons to inject, already loaded + capped by the caller
   * (`loadApprovedLessons`). buildContext only GOVERNs (secret-scan) and MARKs
   * them — never a free-text post-build append (architect finding #3).
   */
  lessons?: LessonRecord[];
  /**
   * REQ-16.5: the resolved planner-fusion plan (already schema-validated by the
   * caller), injected as MARKed data alongside lessons — same GOVERN treatment
   * (a secret-bearing plan is blocked, never the whole-build abort a repo-file
   * secret triggers above). Absent -> no planner-fusion trigger fired this run
   * (Phase-3 parity, byte-identical).
   */
  plan?: { id: string; content: string };
}

export interface ContextBuildResult {
  bundle: ContextBundle;
  manifestRef: string;
  rules: { pieceId: string; reason: string }[];
  /** REQ-12.5: lessons that made it into this bundle (post-GOVERN) — the caller logs LESSON_INJECTED. */
  lessonsInjected: { id: string; evidenceRefs: string[] }[];
  /** REQ-12.3: lessons GOVERN blocked (a secret hit) — never reached pieces/prompt; the caller records the block. */
  lessonsBlocked: { id: string; kind: string }[];
  /** REQ-16.5: whether `input.plan` (if supplied) made it into this bundle (post-GOVERN). */
  planInjected: boolean;
  /** GOVERN blocked `input.plan` (a secret hit) — never reached pieces/prompt; the caller records the block. */
  planBlocked: boolean;
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

const DECLARATION_HEADER_RE =
  /^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(abstract\s+)?(function\*?|class|interface|type|const)\b/;
const IMPORT_EXPORT_RE = /^(import|export)\b/;
const COMMENT_RE = /^(\/\/|\/\*)/;

/**
 * REQ-22: dependency-free, language-heuristic COMPRESS reducer. Keeps
 * import/export lines, top-level declaration header lines (function/class/
 * interface/type/const), and top-level comment blocks; drops indented body
 * lines. No parser dependency — core stays zero-dep (Ring 0); a garbage
 * result (< 2 declarations) is the caller's cue to fall back to truncation.
 */
function compressToSymbols(content: string): { content: string; declarationCount: number } {
  const kept: string[] = [];
  let declarationCount = 0;
  let inTopLevelComment = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (inTopLevelComment) {
      kept.push(line);
      if (trimmed.endsWith('*/')) inTopLevelComment = false;
      continue;
    }
    if (trimmed === '') continue;
    if (/^[ \t]/.test(line)) continue; // indented: body line, drop
    if (COMMENT_RE.test(trimmed)) {
      kept.push(line);
      if (trimmed.startsWith('/*') && !trimmed.endsWith('*/')) inTopLevelComment = true;
    } else if (DECLARATION_HEADER_RE.test(trimmed)) {
      kept.push(line);
      declarationCount++;
    } else if (IMPORT_EXPORT_RE.test(trimmed)) {
      kept.push(line);
    }
    // else: top-level line that is none of the above (e.g. a stray closing brace) — drop.
  }
  kept.push('[compressed:symbols]');
  return { content: kept.join('\n'), declarationCount };
}

/** COMPRESS: symbol-reduce an oversized file, falling back to byte truncation when the heuristic yields garbage. */
function compressOrTruncate(
  full: string,
  maxFileBytes: number,
  inclusionReason: string,
): { content: string; reason: string } {
  if (full.length <= maxFileBytes) return { content: full, reason: inclusionReason };
  const symbols = compressToSymbols(full);
  if (symbols.declarationCount >= 2) return { content: symbols.content, reason: 'compressed:symbols' };
  return { content: truncate(full, maxFileBytes), reason: 'truncated' };
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
    const hit = scanForSecret(full); // GOVERN scans the FULL file, pre-compression/pre-truncation
    if (hit.hit) throw new SecretInContextError(relPath, hit.kind ?? 'unknown');
    const inclusionReason = collected.get(relPath) ?? 'seed';
    const { content, reason } = compressOrTruncate(full, maxFileBytes, inclusionReason);
    const id = `p-${i}`;
    pieces.push({ id, kind: 'file', path: relPath, content, reason });
    rules.push({ pieceId: id, reason });
  });

  // Lessons (REQ-12): SEED (the caller already loaded+capped them) -> GOVERN (secret
  // scan, per-lesson block — never the whole-build abort a repo-file secret triggers
  // above) -> MARK (reuses the SAME untrusted-data wrapping every piece gets below).
  const lessonsInjected: { id: string; evidenceRefs: string[] }[] = [];
  const lessonsBlocked: { id: string; kind: string }[] = [];
  for (const lesson of input.lessons ?? []) {
    const hit = scanForSecret(lesson.statement);
    if (hit.hit) {
      lessonsBlocked.push({ id: lesson.id, kind: hit.kind ?? 'unknown' });
      continue;
    }
    pieces.push({ id: lesson.id, kind: 'excerpt', content: lesson.statement, reason: 'lesson' });
    rules.push({ pieceId: lesson.id, reason: 'lesson' });
    lessonsInjected.push({ id: lesson.id, evidenceRefs: lesson.evidenceRefs });
  }

  // Plan (REQ-16.5): SEED (the caller already resolved + schema-validated it) ->
  // GOVERN (secret scan, same per-item block as a lesson — never the whole-build
  // abort a repo-file secret triggers above) -> MARK (reuses the untrusted-data
  // wrapping every piece gets below). Reuses ContextPiece.kind:'excerpt' — same
  // choice lessons made; MARK/serialization treats every kind identically, so a
  // new union member would be a distinction with no behavioral difference.
  let planInjected = false;
  let planBlocked = false;
  if (input.plan !== undefined) {
    const hit = scanForSecret(input.plan.content);
    if (hit.hit) {
      planBlocked = true;
    } else {
      pieces.push({ id: input.plan.id, kind: 'excerpt', content: input.plan.content, reason: 'plan' });
      rules.push({ pieceId: input.plan.id, reason: 'plan' });
      planInjected = true;
    }
  }

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
  return { bundle, manifestRef, rules, lessonsInjected, lessonsBlocked, planInjected, planBlocked };
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
