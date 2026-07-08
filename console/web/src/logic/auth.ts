// Pure display/interpretation logic for remote auth (REQ-19). The view
// (Login.tsx) and App.tsx's auth gate stay thin — same split as logic/sched.ts.

export type AuthGateState = 'checking' | 'authed' | 'unauthed';

/** A 401 on the auth probe means no valid session; anything else lets the dashboard try. */
export function interpretAuthProbe(status: number): AuthGateState {
  return status === 401 ? 'unauthed' : 'authed';
}

export type LoginOutcome = { ok: true } | { ok: false; error: string };

/** Interpret POST /auth/login's status + body into a display-ready outcome. */
export function interpretLoginResponse(status: number, body: { error?: string }): LoginOutcome {
  if (status === 200) return { ok: true };
  return { ok: false, error: body.error ?? `login failed (http ${status})` };
}

export type ProviderKind = 'basic' | 'oidc';

/**
 * Interpret GET /auth/provider's status + body (REQ-20): which form Login
 * should render. Defaults to 'basic' on any non-200/malformed response — a
 * network hiccup should degrade to the password form, never a dead end.
 */
export function interpretProviderProbe(status: number, body: { kind?: string }): ProviderKind {
  return status === 200 && body.kind === 'oidc' ? 'oidc' : 'basic';
}
