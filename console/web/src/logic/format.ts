// Pure display logic for the console views — testable without a DOM
// (ARCHITECTURE: logic separate from presentation).

export interface AuthInfo {
  shadowing: boolean;
  shadowingVars: string[];
  severity: 'red' | 'ok';
  guidance: string | null;
  /** REQ-18.3: the peer half of the single remote definition (REQ-20.8). */
  remote: boolean;
}

export function authBanner(auth: AuthInfo): { tone: 'red' | 'ok'; text: string } {
  if (!auth.shadowing) {
    return { tone: 'ok', text: 'Auth: subscription credential chain active — no env shadowing.' };
  }
  return {
    tone: 'red',
    text:
      `WARNING: ${auth.shadowingVars.join(', ')} is set — it silently overrides your ` +
      `subscription and bills API rates. ${auth.guidance ?? ''}`.trim(),
  };
}

export interface WindowInfo {
  start: string;
  end: string;
  entryCount: number;
}

export function windowSummary(w: WindowInfo | null, nowMs: number): string {
  if (w === null) return 'No open 5h window — the next prompt starts one.';
  const remainingMs = Date.parse(w.end) - nowMs;
  if (Number.isNaN(remainingMs) || remainingMs <= 0) return 'Window just closed.';
  const h = Math.floor(remainingMs / 3_600_000);
  const m = Math.round((remainingMs % 3_600_000) / 60_000);
  return `Open 5h window: ${w.entryCount} entries, resets in ~${h}h ${m}m (estimate).`;
}

export function projectLabel(p: { id: string; cwd: string | null; loopManaged: boolean }): string {
  const path = p.cwd ?? p.id;
  return p.loopManaged ? `${path} [loop-managed]` : path;
}
