// Console governance logic (spec §8; REQ-14/15/16/17). Pure, unit-tested pieces:
// write-safety (schema validate -> optimistic-concurrency baseHash -> atomic
// rename), the Effective-View resolver (full precedence chain + provenance), the
// permission simulator, and idempotent guard-rule installation. Data-loss
// prevention is a hard requirement — never simplified away.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export type WriteResult =
  | { ok: true; newHash: string }
  | { ok: false; reason: 'conflict'; currentHash: string }
  | { ok: false; reason: 'invalid'; detail: string };

/**
 * Write with optimistic concurrency (REQ-14.2): the caller passes the baseHash it
 * read; if the file changed underneath, the write is refused (409) with the fresh
 * hash. Validation runs first; the write itself is temp-file + atomic rename.
 */
export function writeSafe(
  path: string,
  content: string,
  baseHash: string | null,
  validate?: (c: string) => string | null,
): WriteResult {
  if (validate !== undefined) {
    const err = validate(content);
    if (err !== null) return { ok: false, reason: 'invalid', detail: err };
  }
  if (existsSync(path)) {
    const currentHash = sha256(readFileSync(path, 'utf8'));
    if (baseHash !== currentHash) return { ok: false, reason: 'conflict', currentHash };
  } else if (baseHash !== null) {
    // Caller thinks the file exists but it doesn't — treat as a conflict.
    return { ok: false, reason: 'conflict', currentHash: '' };
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
  return { ok: true, newHash: sha256(content) };
}

export interface ScopeValues {
  scope: string;
  values: Record<string, unknown>;
}

export interface EffectiveEntry {
  value: unknown;
  scope: string;
}

/**
 * Resolve effective settings across the FULL precedence chain (REQ-14.3). Input is
 * ordered LOW precedence -> HIGH precedence (e.g. managed, user, project, local);
 * a later scope overrides an earlier one, and provenance records which scope won.
 * Labeled "computed from files" — parity-checked against the CLI where it exposes
 * effective values (that check lives in the endpoint layer / task 11).
 */
export function resolveEffectiveSettings(scopesLowToHigh: ScopeValues[]): Record<string, EffectiveEntry> {
  const out: Record<string, EffectiveEntry> = {};
  for (const { scope, values } of scopesLowToHigh) {
    for (const [key, value] of Object.entries(values)) {
      out[key] = { value, scope };
    }
  }
  return out;
}

export type PermAction = 'allow' | 'deny' | 'ask';
export interface PermRule {
  action: PermAction;
  /** Tool name or `Tool(path-glob)` — matched by a simple prefix/glob. */
  pattern: string;
  /** Optional source scope supplied to the simulator for provenance display. */
  scope?: string;
}

function globToRe(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\0/g, '.*');
  return new RegExp(`^${esc}$`);
}

/** True iff a rule pattern matches a tool + path. `Tool(glob)` matches the path; a
 *  bare `Tool` matches any path for that tool. */
function ruleMatches(pattern: string, tool: string, path: string): boolean {
  const m = /^([^(]+)\(([^)]*)\)$/.exec(pattern);
  if (m === null) return pattern === tool;
  if (m[1] !== tool) return false;
  return globToRe(m[2] ?? '').test(path);
}

/** Permission simulator (REQ-15.2): deny wins over allow wins over ask; default ask. */
export function permissionDecision(
  rules: PermRule[],
  tool: string,
  path: string,
): { decision: PermAction; rule: PermRule | null; provenance: { scope: string; source: string } | null } {
  const matched = rules.filter((r) => ruleMatches(r.pattern, tool, path));
  for (const action of ['deny', 'allow', 'ask'] as const) {
    const r = matched.find((x) => x.action === action);
    if (r !== undefined) {
      const scope = r.scope ?? 'provided';
      return { decision: action, rule: r, provenance: { scope, source: `${scope} simulator input` } };
    }
  }
  return { decision: 'ask', rule: null, provenance: null };
}

/** Deny rules that protect the golden set + worktrees from interactive sessions too (§4). */
export const GUARD_RULES: PermRule[] = [
  { action: 'deny', pattern: 'Write(test/golden/**)' },
  { action: 'deny', pattern: 'Edit(test/golden/**)' },
  { action: 'deny', pattern: 'Write(worktrees/**)' },
  { action: 'deny', pattern: 'Edit(worktrees/**)' },
];

/** Install guard rules idempotently (REQ-15.3) — re-running adds nothing new. */
export function installGuardRules(existing: PermRule[]): PermRule[] {
  const has = (r: PermRule): boolean => existing.some((e) => e.action === r.action && e.pattern === r.pattern);
  return [...existing, ...GUARD_RULES.filter((r) => !has(r))];
}
