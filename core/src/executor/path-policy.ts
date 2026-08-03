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
  /** Normalized worktree-relative roots a role may durably mutate through RUN_COMMAND. */
  writeRoots(role: Role): readonly string[];
  /** Core-owned frozen RED tests denied to implementers on every write surface. */
  frozenRedArtifacts?: FrozenRedArtifactIndex;
}

const GOLDEN_PREFIX = `test${sep}golden${sep}`;

const WRITE_PREFIXES: Record<Role, string[]> = {
  planner: [],
  test_designer: [`test${sep}ai-generated${sep}`],
  implementer: [`src${sep}`, `test${sep}ai-generated${sep}`],
  // Diagnostician reads + runs probe RUN_COMMANDs; it never writes (REQ-4.3).
  diagnostician: [],
  // Reviewer (fusion blind judge, REQ-4.2) is reasoning-only; it never writes.
  reviewer: [],
};

/** Normalize to a worktree-relative path, or null when it escapes the worktree. */
export function normalizeWorktreeRelativePath(relPath: string): string | null {
  if (relPath.length === 0 || isAbsolute(relPath)) return null;
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
  };
}
