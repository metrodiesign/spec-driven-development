// F-Term browser terminal (REQ-13): xterm.js over the ticketed WS bridge.
// Backend owns the PTY — Detach closes only the socket; Re-attach replays the
// ring buffer and resumes streaming. Pure helpers live in logic/term.ts.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { termWsUrl } from './logic/term.ts';
import { FETCH_LOADING, FETCH_ERROR, type FetchState } from './logic/fetchState.ts';
import { useI18n } from './I18nContext.tsx';
import { mergeNamedRecords } from './logic/console.ts';
import { usePendingMutation } from './usePendingMutation.ts';
import { protectedFetch } from './useFetch.ts';

interface SessionRow {
  ptyId: string;
  project: string;
  mode: 'claude-only' | 'full-shell';
  alive: boolean;
}

export function TerminalPanel({
  project,
  intent = null,
}: {
  project: string;
  intent?: 'mcp-authenticate' | null;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dataSubRef = useRef<{ dispose(): void } | null>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [attached, setAttached] = useState(false);
  const [resume, setResume] = useState('');
  const [sessionsState, setSessionsState] = useState<FetchState<SessionRow[]>>(FETCH_LOADING);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [sessionsReadError, setSessionsReadError] = useState(false);
  const [sessionsReadAt, setSessionsReadAt] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mutations = usePendingMutation();

  const refreshSessions = (cursor: string | null = null) => {
    const url = `/api/term/sessions?project=${encodeURIComponent(project)}&limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
    protectedFetch(url)
      .then((r) => r.json().then((body: { sessions: SessionRow[]; nextCursor: string | null }) => {
        if (!r.ok) {
          setSessionsReadError(true);
          setSessionsState((current) => current.kind === 'data' ? current : FETCH_ERROR);
          return;
        }
        setSessionsReadError(false);
        setSessionsReadAt(new Date().toISOString());
        setSessionsState((current) => ({
          kind: 'data',
          value: cursor === null || current.kind !== 'data'
            ? body.sessions
            : [...mergeNamedRecords(current.value, body.sessions, (session) => session.ptyId)],
        }));
        setNextCursor(body.nextCursor);
      }))
      .catch(() => {
        setSessionsReadError(true);
        setSessionsState((current) => current.kind === 'data' ? current : FETCH_ERROR);
      });
  };
  useEffect(() => {
    refreshSessions();
  }, [project]);

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

  useEffect(() => () => {
    dataSubRef.current?.dispose();
    wsRef.current?.close();
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
    const mcp = opts?.mcp === true;
    const identity = { action: mcp ? 'terminal-mcp-authenticate' : 'terminal-create', target: project, concurrencyKey: mcp ? null : resume.trim() || null };
    await mutations.run(identity, async () => {
      try {
        const body: Record<string, string | boolean> = { project, mode: 'claude-only' };
        if (mcp) body['mcp'] = true;
        else if (resume.trim().length > 0) body['resume'] = resume.trim();
        const r = await protectedFetch('/api/term/sessions', {
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
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  async function reattach(id: string): Promise<void> {
    await mutations.run({ action: 'terminal-attach', target: id, concurrencyKey: null }, async () => {
      try {
        wsRef.current?.close();
        const r = await protectedFetch(`/api/term/sessions/${encodeURIComponent(id)}/attach`, { method: 'POST' });
        if (!r.ok) {
          setNote(t('termAttachFailed', { status: r.status }));
          return;
        }
        const { ticket } = (await r.json()) as { ticket: string; buffer: string };
        termRef.current?.reset();
        // The WS handshake replays the ring buffer itself — no client-side splice.
        openWs(id, ticket);
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
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
      {intent === 'mcp-authenticate' && (
        <div className="operation-intent" role="status">
          <p>{t('termMcpIntentPrepared')} <code>claude mcp</code></p>
          <button
            type="button"
            disabled={mutations.isPending({ action: 'terminal-mcp-authenticate', target: project, concurrencyKey: null })}
            onClick={() => void create({ mcp: true })}
          >
            {t('termMcpStartButton')}
          </button>
        </div>
      )}
      <p>
        <button
          type="button"
          disabled={mutations.isPending({ action: 'terminal-create', target: project, concurrencyKey: resume.trim() || null })}
          onClick={() => void create()}
        >
          {t('termOpenButton')}
        </button>{' '}
        <input
          aria-label={t('termResumeAriaLabel')}
          placeholder={t('termResumePlaceholder')}
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          style={{ width: '24rem', maxWidth: '100%' }}
        />{' '}
        {attached && <button type="button" onClick={detach}>{t('termDetachButton')}</button>}
      </p>
      {note !== null && <p role="status">{note}</p>}
      {sessionsReadError && (
        <p role="alert">
          {sessionsState.kind === 'data' ? t('consoleStaleAt', { time: sessionsReadAt ?? 'unknown' }) : t('fetchUnavailable')}{' '}
          <button type="button" onClick={() => refreshSessions()}>{t('shellRetry')}</button>
        </p>
      )}
      {sessionsState.kind === 'data' && sessionsState.value.length > 0 && (
        <ul>
          {sessionsState.value.map((s) => (
            <li key={s.ptyId}>
              <code>{s.ptyId}</code> · {s.mode}
              {s.alive ? '' : t('termExitedSuffix')}{' '}
              <button
                type="button"
                disabled={mutations.isPending({ action: 'terminal-attach', target: s.ptyId, concurrencyKey: null })}
                onClick={() => void reattach(s.ptyId)}
              >
                {t('termReattachButton')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor !== null && (
        <button type="button" onClick={() => refreshSessions(nextCursor)}>{t('consoleLoadMore')}</button>
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
