// F-Term browser terminal (REQ-13): xterm.js over the ticketed WS bridge.
// Backend owns the PTY — Detach closes only the socket; Re-attach replays the
// ring buffer and resumes streaming. Pure helpers live in logic/term.ts.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { termWsUrl } from './logic/term.ts';

interface SessionRow {
  ptyId: string;
  project: string;
  mode: 'claude-only' | 'full-shell';
  alive: boolean;
}

export function TerminalPanel({ project }: { project: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataSubRef = useRef<{ dispose(): void } | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [resume, setResume] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const refreshSessions = () => {
    fetch('/api/term/sessions')
      .then((r) => r.json())
      .then((rows: SessionRow[]) => setSessions(rows))
      .catch(() => setSessions([]));
  };
  useEffect(refreshSessions, []);

  // One xterm instance for the panel's lifetime; sized to the backend PTY (120x32).
  useEffect(() => {
    if (hostRef.current === null || termRef.current !== null) return;
    const t = new Terminal({ cols: 120, rows: 32, convertEol: false, scrollback: 5000 });
    t.open(hostRef.current);
    termRef.current = t;
    return () => {
      t.dispose();
      termRef.current = null;
    };
  }, []);

  function openWs(id: string, ticket: string): void {
    const ws = new WebSocket(termWsUrl(id, ticket));
    ws.onmessage = (ev) => termRef.current?.write(typeof ev.data === 'string' ? ev.data : '');
    ws.onclose = () => setAttached(false);
    // Exactly one keyboard->WS subscription — the previous socket's is disposed,
    // and a closed socket is never written to.
    dataSubRef.current?.dispose();
    dataSubRef.current = termRef.current?.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    }) ?? null;
    wsRef.current = ws;
    setPtyId(id);
    setAttached(true);
    setNote(null);
  }

  async function create(): Promise<void> {
    const body: Record<string, string> = { project, mode: 'claude-only' };
    if (resume.trim().length > 0) body['resume'] = resume.trim();
    const r = await fetch('/api/term/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setNote(`create failed: ${((await r.json()) as { error?: string }).error ?? r.status}`);
      return;
    }
    const { ptyId: id, ticket } = (await r.json()) as { ptyId: string; ticket: string };
    termRef.current?.reset();
    openWs(id, ticket);
    refreshSessions();
  }

  async function reattach(id: string): Promise<void> {
    wsRef.current?.close();
    const r = await fetch(`/api/term/sessions/${encodeURIComponent(id)}/attach`, { method: 'POST' });
    if (!r.ok) {
      setNote(`attach failed: ${r.status}`);
      return;
    }
    const { ticket } = (await r.json()) as { ticket: string; buffer: string };
    termRef.current?.reset();
    // The WS handshake replays the ring buffer itself — no client-side splice.
    openWs(id, ticket);
  }

  function detach(): void {
    wsRef.current?.close();
    wsRef.current = null;
    setAttached(false);
    setNote('detached — the PTY keeps running on the backend (re-attach to resume)');
  }

  return (
    <section aria-label="Terminal">
      <h2>Terminal</h2>
      <p>
        <button onClick={() => void create()}>Open Terminal (claude)</button>{' '}
        <input
          aria-label="Resume session id"
          placeholder="resume session id (optional)"
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          style={{ width: '24rem', maxWidth: '100%' }}
        />{' '}
        {attached && <button onClick={detach}>Detach</button>}
      </p>
      {note !== null && <p role="status">{note}</p>}
      {sessions.length > 0 && (
        <ul>
          {sessions.map((s) => (
            <li key={s.ptyId}>
              <code>{s.ptyId}</code> · {s.mode}
              {s.alive ? '' : ' (exited)'}{' '}
              <button onClick={() => void reattach(s.ptyId)}>Re-attach</button>
            </li>
          ))}
        </ul>
      )}
      <div ref={hostRef} style={{ overflowX: 'auto', border: '1px solid #444' }} />
      <p>
        <small>
          PTY {ptyId ?? '—'} · {attached ? 'attached (single active writer)' : 'not attached'}
        </small>
      </p>
    </section>
  );
}
