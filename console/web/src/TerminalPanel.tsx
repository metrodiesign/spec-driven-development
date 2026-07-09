// F-Term browser terminal (REQ-13): xterm.js over the ticketed WS bridge.
// Backend owns the PTY — Detach closes only the socket; Re-attach replays the
// ring buffer and resumes streaming. Pure helpers live in logic/term.ts.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { termWsUrl } from './logic/term.ts';
import { useI18n } from './I18nContext.tsx';

interface SessionRow {
  ptyId: string;
  project: string;
  mode: 'claude-only' | 'full-shell';
  alive: boolean;
}

export function TerminalPanel({ project }: { project: string }) {
  const { t } = useI18n();
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

  async function create(opts?: { mcp?: boolean }): Promise<void> {
    const body: Record<string, string | boolean> = { project, mode: 'claude-only' };
    if (opts?.mcp === true) body['mcp'] = true;
    else if (resume.trim().length > 0) body['resume'] = resume.trim();
    const r = await fetch('/api/term/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setNote(t('termCreateFailed', { error: ((await r.json()) as { error?: string }).error ?? r.status }));
      return;
    }
    const { ptyId: id, ticket } = (await r.json()) as { ptyId: string; ticket: string };
    termRef.current?.reset();
    openWs(id, ticket);
    refreshSessions();
  }

  // F-MCP Authenticate deep link (REQ-18.1): `/terminal?cmd=mcp` auto-opens a
  // claude-only session running `claude mcp` instead of requiring a manual click.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('cmd') === 'mcp') {
      void create({ mcp: true });
    }
  }, []);

  async function reattach(id: string): Promise<void> {
    wsRef.current?.close();
    const r = await fetch(`/api/term/sessions/${encodeURIComponent(id)}/attach`, { method: 'POST' });
    if (!r.ok) {
      setNote(t('termAttachFailed', { status: r.status }));
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
    setNote(t('termDetachedNote'));
  }

  return (
    <section aria-label={t('termHeading')}>
      <h2>{t('termHeading')}</h2>
      <p>
        <button onClick={() => void create()}>{t('termOpenButton')}</button>{' '}
        <input
          aria-label={t('termResumeAriaLabel')}
          placeholder={t('termResumePlaceholder')}
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          style={{ width: '24rem', maxWidth: '100%' }}
        />{' '}
        {attached && <button onClick={detach}>{t('termDetachButton')}</button>}
      </p>
      {note !== null && <p role="status">{note}</p>}
      {sessions.length > 0 && (
        <ul>
          {sessions.map((s) => (
            <li key={s.ptyId}>
              <code>{s.ptyId}</code> · {s.mode}
              {s.alive ? '' : t('termExitedSuffix')}{' '}
              <button onClick={() => void reattach(s.ptyId)}>{t('termReattachButton')}</button>
            </li>
          ))}
        </ul>
      )}
      <div ref={hostRef} style={{ overflowX: 'auto', border: '1px solid var(--color-border-strong)' }} />
      <p>
        <small>
          {t('termPtyPrefix')} {ptyId ?? '—'} · {attached ? t('termAttachedStatus') : t('termNotAttachedStatus')}
        </small>
      </p>
    </section>
  );
}
