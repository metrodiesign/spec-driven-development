// Least-privilege path policy per role (spec §6.1, REQ-1.2/1.3/1.6).
// Defaults: planner read-only; test_designer writes test/ai-generated/**;
// implementer writes src/** + test/ai-generated/**; test/golden/** read-only for ALL.

import type { Role } from '../types.ts';

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export interface PathPolicy {
  checkWrite(role: Role, relPath: string): PolicyDecision;
  checkRead(role: Role, relPath: string): PolicyDecision;
}

export function createDefaultPathPolicy(): PathPolicy {
  throw new Error('NotImplemented: createDefaultPathPolicy');
}
