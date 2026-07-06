// Least-privilege path policy per role (spec §6.1, REQ-1.2/1.3/1.6).
// Defaults: planner read-only; test_designer writes test/ai-generated/**;
// implementer writes src/** + test/ai-generated/**; test/golden/** read-only for ALL.
// Paths are checked in normalized worktree-relative form; the executor
// additionally enforces realpath containment at apply time (symlink escapes).

import { isAbsolute, normalize, sep } from 'node:path';

import type { Role } from '../types.ts';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface PathPolicy {
  checkWrite(role: Role, relPath: string): PolicyDecision;
  checkRead(role: Role, relPath: string): PolicyDecision;
}

const GOLDEN_PREFIX = `test${sep}golden${sep}`;

const WRITE_PREFIXES: Record<Role, string[]> = {
  planner: [],
  test_designer: [`test${sep}ai-generated${sep}`],
  implementer: [`src${sep}`, `test${sep}ai-generated${sep}`],
};

/** Normalize to a worktree-relative path, or null when it escapes the worktree. */
function contain(relPath: string): string | null {
  if (relPath.length === 0 || isAbsolute(relPath)) return null;
  const norm = normalize(relPath);
  if (norm === '..' || norm.startsWith(`..${sep}`)) return null;
  return norm;
}

export function createDefaultPathPolicy(): PathPolicy {
  return {
    checkWrite(role, relPath) {
      const norm = contain(relPath);
      if (norm === null) {
        return { allowed: false, reason: 'path_outside_allowlist' };
      }
      if (norm.startsWith(GOLDEN_PREFIX) || norm === `test${sep}golden`) {
        return { allowed: false, reason: 'golden_write_denied' };
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
