// F-Term display logic (pure, unit-tested). The full xterm.js render + live WS
// streaming is browser-verified against the real CLI in task 11 (PARTIAL, per A4);
// these helpers are the deterministic parts.

export type TermMode = 'claude-only' | 'full-shell';

/** WS URL for a ticketed attach (single-use ticket in the query, REQ-13.3). */
export function termWsUrl(ptyId: string, ticket: string): string {
  return `/api/term/ws?ptyId=${encodeURIComponent(ptyId)}&ticket=${encodeURIComponent(ticket)}`;
}

/** Deep-link -> a create request body (spec §8 deep-linkable, REQ-13.6 resume). */
export function createBodyFromQuery(params: URLSearchParams): { project: string; mode: TermMode; resume?: string } | null {
  const project = params.get('project');
  if (project === null || project.length === 0) return null;
  const mode: TermMode = params.get('shell') === '1' ? 'full-shell' : 'claude-only';
  const resume = params.get('resume');
  return resume !== null ? { project, mode, resume } : { project, mode };
}

/** Human label for a session row. */
export function sessionRowLabel(s: { ptyId: string; project: string; mode: TermMode; alive: boolean }): string {
  return `${s.project} · ${s.mode}${s.alive ? '' : ' (exited)'} · ${s.ptyId}`;
}
