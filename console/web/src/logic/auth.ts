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
