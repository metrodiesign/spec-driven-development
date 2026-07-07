// Injection canary tripwire (REQ-11.1, spec §10.1). A per-request random token is
// planted in every context piece's untrusted-data marker (core/context builder).
// A model that echoes or acts on that token in its OWN output exhibits the
// signature of a successful prompt injection — detect it and reject the round.
// Mitigation, not proof (§16 claim discipline): a silent injection that never
// surfaces the token is not caught here; the canary raises the cost of the obvious
// attack and gives an observable trip event when it fires.

import type { Action } from '../types.ts';

/**
 * True iff the round's canary token appears in the model's structuredResult or any
 * inline action field (cmd/path/name — written file bodies travel as evidence refs,
 * never inline, so they cannot carry the token through the response).
 */
export function canaryTripped(
  response: { structuredResult: unknown; actionRequests: Action[] },
  canaryToken: string,
): boolean {
  if (canaryToken.length === 0) return false;
  const haystack =
    (JSON.stringify(response.structuredResult) ?? '') +
    (JSON.stringify(response.actionRequests) ?? '');
  return haystack.includes(canaryToken);
}
