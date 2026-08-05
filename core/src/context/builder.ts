// Deterministic Context Builder v1 (spec §9.4, REQ-7). Six stages:
// SEED -> EXPAND -> COMPRESS(symbol-heuristic reduction, byte-truncation
// fallback; REQ-22) -> GOVERN(secret block) -> MARK(untrusted-data markers +
// injection canary) -> MANIFEST. Pure
// function of (contract, worktree files, seedPaths, canaryToken): identical
// inputs => byte-identical manifest.
//
// NOTE (v1.8): `seedPaths` is no longer fixed per task — the caller grows it each
// round with the paths the role requested via READ_FILE (normalized + capped in
// aal/src/source.ts), so a later round legitimately builds a larger bundle. This
// function is unchanged and still pure; only the inputs it is handed differ.
// See unified-platform-spec.md §9.4/§17 and .ai/specs/context-accumulation/.
//
// Machine-config exclusion (REQ-7.7) is enforced by core but PARAMETERIZED: the
// list of machine-config paths is vendor-specific, so naming those files here
// would violate INV-7 (core must be vendor-name-free). The caller — the
// composition root, which is allowed to know the vendor — supplies `excludePath`;
// core honors whatever predicate it is given and defaults to excluding nothing.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { normalizeWorktreeRelativePath } from '../executor/path-policy.ts';
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
  /**
   * AC-15: pieces the builder skipped rather than including or throwing for —
   * an EXPAND-only secret (AC-12) or a containment violation (AC-10). No file
   * content here; the caller logs {path, kind} onto CONTEXT_BUILT.
   */
  piecesBlocked: { path: string; kind: string }[];
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

/**
 * Read a worktree-relative path with containment enforced at the read edge
 * (AC-10): `normalizeWorktreeRelativePath` rejects a syntactic escape (`..`,
 * absolute) before resolution, then the resolved target must stay under the
 * worktree's OWN realpath — parent-dir realpath check, then an O_NOFOLLOW open —
 * the same idiom `readCandidate` in ../gates/red-provenance.ts uses, which also
 * resolves the worktree side so a symlinked worktree root (e.g. macOS's
 * /tmp -> /private/tmp) still reads its own files normally. Neither case
 * throws, but the two are distinguished (AC-15): a plain missing file
 * (`blocked: 'not-found'`) stays silent, same as before; a containment
 * violation (traversal, or a symlink anywhere in the resolved path,
 * `blocked: 'containment'`) is named so the caller can signal it instead of
 * it looking identical to a file that never existed.
 */
function readWithinWorktree(
  worktreeDir: string,
  relPath: string,
): { content: string | null; blocked: 'not-found' | 'containment' | null } {
  const norm = normalizeWorktreeRelativePath(relPath);
  if (norm === null) return { content: null, blocked: 'containment' };
  const absolute = resolve(worktreeDir, norm);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return { content: null, blocked: 'not-found' }; // ENOENT, ENOTDIR — no file at this path
  }
  try {
    if (!stat.isFile()) return { content: null, blocked: 'containment' }; // symlink or directory, not a plain file
    const root = realpathSync(worktreeDir);
    const parent = realpathSync(dirname(absolute));
    if (parent !== root && !parent.startsWith(`${root}${sep}`)) return { content: null, blocked: 'containment' };
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return { content: null, blocked: 'containment' };
      return { content: readFileSync(fd, 'utf8'), blocked: null };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { content: null, blocked: 'containment' }; // ELOOP (O_NOFOLLOW hit a symlink) or another failure after existence was confirmed
  }
}

/**
 * Fail-closed existence probe at the SAME containment edge `readWithinWorktree`
 * uses (v1.9). `false` — the ONLY answer that means "there is no entry here" —
 * requires ALL of: the path normalizes to a worktree-relative path, an `lstat`
 * of the resolved path reports `ENOENT`, and the deepest directory that DOES
 * exist on the way to it still realpath-resolves inside the worktree. Every
 * other outcome answers `true`: an absolute path or a `..` escape (normalize
 * returns null), a symlink (`lstat` does NOT follow it, so even a DANGLING
 * symlink is an entry — the case `existsSync` gets wrong), a directory, a path
 * that leaves the worktree through a directory symlink, live or dangling
 * (`src/link/new.ts` under a `src/link` -> outside), or any other stat failure
 * (EACCES, ENOTDIR, …).
 *
 * Lives in core, next to `readWithinWorktree`, so "does this worktree path hold
 * something" has ONE definition — a second `lstatSync` in Ring 1 would be a
 * second definition of the same rule, free to drift (spec §9.4 "containment
 * บังคับที่ขอบการอ่านจริงของ builder").
 *
 * The caller is `aal/src/source.ts`'s WRITE_FILE provenance gate: a write to a
 * path with no entry is creating a NEW file, which destroys nothing the model
 * never saw. No `isFile()` branch is needed here — every non-ENOENT outcome,
 * regular file or not, is already `true`.
 */
export function worktreeEntryExists(worktreeDir: string, relPath: string): boolean {
  const norm = normalizeWorktreeRelativePath(relPath);
  if (norm === null) return true;
  const absolute = resolve(worktreeDir, norm);
  try {
    lstatSync(absolute);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true;
  }
  // Nothing at the path itself — but `lstat` FOLLOWS the directory components
  // leading to it, so an ENOENT can also mean "no such file under a directory
  // that is not in this worktree at all" (`src/link/new.ts` where `src/link` is
  // a symlink pointing out). Hence the parent-realpath check `readWithinWorktree`
  // does, walked up to the deepest directory that exists — the parent of a
  // genuinely new file (`src/newdir/a.ts`) need not exist yet.
  let root: string;
  try {
    root = realpathSync(worktreeDir);
  } catch {
    return true; // the worktree root itself does not resolve — undecidable, fail closed
  }
  let probe = dirname(absolute);
  for (;;) {
    try {
      const real = realpathSync(probe);
      // Inverted on purpose: a deepest-existing dir OUTSIDE the worktree -> `true`
      // = treat as existing (fail closed, an escape is never a new file); contained
      // -> `false` = a genuinely new file the gate may allow.
      return real !== root && !real.startsWith(`${root}${sep}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      // `realpath` reports ENOENT for a DANGLING directory symlink too — the
      // entry IS here, only its target is missing. Walking past it would judge
      // containment by a directory that is not on this path's route at all, so
      // `src/dangling/new.ts` (src/dangling -> a not-yet-created dir outside)
      // would come back "new file". Only an ENOENT that `lstat` confirms —
      // nothing here at all — may walk up; every other lstat outcome (EACCES,
      // ELOOP, ENOTDIR, …) is undecidable and fail-closed, same as above.
      try {
        lstatSync(probe);
        return true;
      } catch (probeErr) {
        if ((probeErr as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
      const parent = dirname(probe);
      if (parent === probe) return true; // walked past the filesystem root
      probe = parent;
    }
  }
}

export function buildContext(input: ContextBuildInput): ContextBuildResult {
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const depthBudget = input.depthBudget ?? 1;
  const excludePath = input.excludePath ?? (() => false);
  // AC-12: a path the caller actually seeded (composition's literal seedPaths OR
  // the accumulated READ_FILE-requested set the caller already folded in there) —
  // used below to tell a seeded/accumulated secret (still a whole-build abort)
  // apart from an EXPAND-only one (a per-piece skip). Checked against
  // input.seedPaths directly, NOT the 'seed' reason collected() records below,
  // because visit() can reach a seeded path via EXPAND first (another seed's
  // import resolves to it before its own turn in the seedPaths loop) — the
  // reason string alone would then mislabel a real seeded secret as EXPAND-only.
  const seedPathSet = new Set(input.seedPaths);

  // AC-15: pieces the builder itself decided to skip rather than include or
  // throw for — a containment violation (AC-10, filled by visit() below) or a
  // secret reached only via EXPAND (AC-12, filled in the GOVERN loop below).
  // Content never lands here — path + kind only, for the caller to log. A
  // plain missing file is NOT included (stays silent, same as always).
  const piecesBlocked: { path: string; kind: string }[] = [];

  // SEED + EXPAND: collect a deterministic set of {path, reason, content}, machine
  // config excluded. Containment (AC-10) is enforced by readWithinWorktree at this
  // single read edge — a path that is absolute, escapes the worktree via `..`, or
  // resolves (through a symlink) outside the worktree is treated exactly like a
  // missing file for bundle purposes (silently not collected, for BOTH a literal
  // seed path and an EXPAND-derived one) but is distinguished from an ordinary
  // missing file in piecesBlocked (AC-15).
  const collected = new Map<string, { reason: string; content: string }>(); // path -> {reason, content}
  const visit = (relPath: string, reason: string, depth: number): void => {
    if (excludePath(relPath) || collected.has(relPath)) return;
    const read = readWithinWorktree(input.worktreeDir, relPath);
    if (read.content === null) {
      // Dedupe by path: a containment-blocked path never enters `collected`, so
      // the collected.has() guard above can't stop every importer of it from
      // reaching here — without this, one out-of-worktree import referenced N
      // times pushes N identical entries (LOW-2). GOVERN's push below walks the
      // deduped `paths`, so it needs no such guard.
      if (read.blocked === 'containment' && !piecesBlocked.some((b) => b.path === relPath)) {
        piecesBlocked.push({ path: relPath, kind: 'containment' });
      }
      return; // missing or blocked — not included (recall will reflect it)
    }
    collected.set(relPath, { reason, content: read.content });
    if (depth < depthBudget) {
      for (const imp of localImports(read.content)) {
        // Resolve a relative import against the repo root, best-effort with .ts.
        const cand = imp.replace(/^\.\//, '').replace(/^\.\.\//, '');
        visit(cand.endsWith('.ts') ? cand : `${cand}.ts`, `expand:depth-${depth + 1}`, depth + 1);
      }
    }
  };
  for (const p of input.seedPaths) visit(p, 'seed', 0);

  // Deterministic order: sort by path, THEN assign stable piece ids.
  const paths = [...collected.keys()].sort();

  // COMPRESS + GOVERN + MARK. Content was already read (and containment-checked,
  // AC-10) once during SEED/EXPAND above; reusing it here avoids a second raw
  // read that would reopen the TOCTOU window the containment check just closed.
  const pieces: ContextPiece[] = [];
  const rules: { pieceId: string; reason: string }[] = [];
  paths.forEach((relPath, i) => {
    const entry = collected.get(relPath);
    if (entry === undefined) return; // unreachable: paths is collected.keys()
    const full = entry.content;
    const hit = scanForSecret(full); // GOVERN scans the FULL file, pre-compression/pre-truncation
    if (hit.hit) {
      // AC-12: a secret reached ONLY via EXPAND (never in the caller's
      // seedPaths, which already carries seed ∪ accumulated) is a per-piece
      // skip — same precedent as a blocked lesson/plan below, never the
      // whole-build abort a seeded/accumulated secret still triggers.
      if (!seedPathSet.has(relPath)) {
        piecesBlocked.push({ path: relPath, kind: hit.kind ?? 'unknown' }); // AC-15
        return;
      }
      throw new SecretInContextError(relPath, hit.kind ?? 'unknown');
    }
    const { content, reason } = compressOrTruncate(full, maxFileBytes, entry.reason);
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
  return { bundle, manifestRef, rules, lessonsInjected, lessonsBlocked, planInjected, planBlocked, piecesBlocked };
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
