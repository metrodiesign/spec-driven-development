// Least-privilege path policy per role (spec §6.1, REQ-1.2/1.3/1.6).
// Defaults: planner read-only; test_designer writes test/ai-generated/**;
// implementer writes src/** + test/ai-generated/**; test/golden/** read-only for ALL.
// Paths are checked in normalized worktree-relative form; every executor mutation
// additionally crosses the descriptor-relative, no-follow path boundary at commit.

import { isAbsolute, normalize, sep } from 'node:path';

import type { Role } from '../types.ts';
import type { FrozenRedArtifactIndex } from '../gates/red-provenance.ts';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface PathPolicy {
  checkWrite(role: Role, relPath: string): PolicyDecision;
  checkRead(role: Role, relPath: string): PolicyDecision;
  /**
   * Role gate for RUN_COMMAND, enforced BEFORE spawn (spec §6.1). Only implementer
   * and diagnostician may run commands; every other role is rejected so no process
   * is created. REQUIRED (not optional): an absent method would default to
   * fail-open, exactly the gap this closes.
   */
  checkCommand(role: Role): PolicyDecision;
  /** Normalized worktree-relative roots a role may durably mutate through RUN_COMMAND. */
  writeRoots(role: Role): readonly string[];
  /** Core-owned frozen RED tests denied to implementers on every write surface. */
  frozenRedArtifacts?: FrozenRedArtifactIndex;
}

const GOLDEN_PREFIX = `test${sep}golden${sep}`;

/**
 * Roles permitted to EXECUTE RUN_COMMAND (spec §6.1) — not to propose it.
 * Prompt advertising is a separate, deliberately asymmetric concern: diagnostician
 * executes here (hypothesis probe, deploy stage) while its prompt does NOT list
 * RUN_COMMAND. Do not add it back to that prompt on the strength of this list.
 */
const COMMAND_ROLES: readonly Role[] = ['implementer', 'diagnostician'];

const WRITE_PREFIXES: Record<Role, string[]> = {
  planner: [],
  test_designer: [`test${sep}ai-generated${sep}`],
  implementer: [`src${sep}`, `test${sep}ai-generated${sep}`],
  // Diagnostician reads + runs probe RUN_COMMANDs; it never writes (REQ-4.3).
  diagnostician: [],
  // Reviewer (fusion blind judge, REQ-4.2) is reasoning-only; it never writes.
  reviewer: [],
};

/**
 * Normalize to a worktree-relative path, or null when it escapes the worktree.
 *
 * `relPath` is typed `unknown` on purpose: every value that reaches here comes,
 * directly or through an accumulator, from a model-authored action field, which
 * is UNTRUSTED (INV-1/INV-2) and typed by nothing upstream. A non-string used to
 * throw `TypeError: The "path" argument must be of type string` out of
 * `isAbsolute()` — past `propose()` and `executeValidAction()`, neither of which
 * has a catch for it, killing the whole run. A non-string is now fail-closed the
 * same way a worktree escape is: `null`, never a throw. String behaviour is
 * unchanged.
 */
export function normalizeWorktreeRelativePath(relPath: unknown): string | null {
  if (typeof relPath !== 'string' || relPath.length === 0 || isAbsolute(relPath)) return null;
  // Accept platform-neutral action paths, then canonicalize before every
  // frozen-RED lookup. This closes `dir/../frozen.test.ts` and slash-alias
  // gaps between preflight and mutation-path commit checks.
  const norm = normalize(relPath.replaceAll('\\', sep));
  if (norm === '..' || norm.startsWith(`..${sep}`)) return null;
  return norm;
}

function contain(relPath: string): string | null {
  return normalizeWorktreeRelativePath(relPath);
}

export function createDefaultPathPolicy(
  options: { frozenRedArtifacts?: FrozenRedArtifactIndex; redArtifacts?: FrozenRedArtifactIndex } = {},
): PathPolicy {
  const frozenRedArtifacts = options.frozenRedArtifacts ?? options.redArtifacts;
  return {
    ...(frozenRedArtifacts === undefined
      ? {}
      : { frozenRedArtifacts }),
    writeRoots(role) {
      return WRITE_PREFIXES[role].map((prefix) => prefix.endsWith(sep) ? prefix.slice(0, -1) : prefix);
    },

    checkWrite(role, relPath) {
      const norm = contain(relPath);
      if (norm === null) {
        return { allowed: false, reason: 'path_outside_allowlist' };
      }
      if (norm.startsWith(GOLDEN_PREFIX) || norm === `test${sep}golden`) {
        return { allowed: false, reason: 'golden_write_denied' };
      }
      if (role === 'implementer' && frozenRedArtifacts?.get(norm) !== undefined) {
        return { allowed: false, reason: 'red_artifact_frozen' };
      }
      const prefixes = WRITE_PREFIXES[role];
      if (!prefixes.some((p) => norm.startsWith(p))) {
        return { allowed: false, reason: 'path_outside_allowlist' };
      }
      return { allowed: true };
    },

    checkRead(_role, relPath) {
      return contain(relPath) === null
        ? { allowed: false, reason: 'path_outside_allowlist' }
        : { allowed: true };
    },

    checkCommand(role) {
      return COMMAND_ROLES.includes(role)
        ? { allowed: true }
        : { allowed: false, reason: 'command_role_denied' };
    },
  };
}
