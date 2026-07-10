// F-Chat (REQ-17/18/19): card-style chat surface over the SDK's query() +
// canUseTool via a ticketed WS bridge (INV-17 exemption — design.md G). NOT
// CLI parity: no slash commands, no plan mode — the banner below says so,
// always. Pure event-folding lives in logic/chat.ts; this view stays thin.

import { useEffect, useRef, useState } from 'react';

import {
  applyServerEvent,
  appendUserMessage,
  chatWsUrl,
  initialChatUiState,
  resolveApproval,
  type ChatServerEvent,
  type ChatUiState,
} from './logic/chat.ts';
import { windowSummary, type WindowInfo } from './logic/format.ts';
import { fetchStateFromResponse, FETCH_LOADING, FETCH_ERROR, type FetchState } from './logic/fetchState.ts';
import { useI18n } from './I18nContext.tsx';

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};

export function Chat({ project }: { project: string }) {
  const { t } = useI18n();
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [state, setState] = useState<ChatUiState>(initialChatUiState);
  const [input, setInput] = useState('');
  const [resume, setResume] = useState('');
  const [fork, setFork] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quota, setQuota] = useState<FetchState<WindowInfo | null>>(FETCH_LOADING);

  useEffect(() => {
    fetch('/api/usage/estimate')
      .then((r) =>
        r.json().then((d: { currentWindow: WindowInfo | null }) => setQuota(fetchStateFromResponse(r.ok, d.currentWindow))),
      )
      .catch(() => setQuota(FETCH_ERROR));
  }, []);

  useEffect(() => () => wsRef.current?.close(), []);

  async function start(): Promise<void> {
    // Reentry guard (PR #50 review): the Start button used to stay enabled until
    // `connected` flips true on ws.onopen, so a double-click could create a second
    // WebSocket without ever closing the first (leak + duplicate event handling).
    if (connecting || connected) return;
    setConnecting(true);
    try {
      const body: Record<string, string | boolean> = { projectDir: project };
      if (resume.trim().length > 0) body['resume'] = resume.trim();
      if (fork) body['fork'] = true;
      const r = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setNote(t('chatSessionCreateFailed', { error: ((await r.json()) as { error?: string }).error ?? r.status }));
        return;
      }
      const { wsTicket } = (await r.json()) as { sessionId: string; wsTicket: string };
      setState(initialChatUiState);
      const ws = new WebSocket(chatWsUrl(wsTicket));
      ws.onopen = () => setConnected(true);
      ws.onclose = () => setConnected(false);
      ws.onmessage = (ev) => {
        const event = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as ChatServerEvent;
        setState((s) => applyServerEvent(s, event));
      };
      wsRef.current = ws;
      setNote(null);
    } catch {
      setNote(t('fetchUnavailable'));
    } finally {
      setConnecting(false);
    }
  }

  function send(): void {
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN || input.trim().length === 0) return;
    ws.send(JSON.stringify({ type: 'user_message', text: input }));
    setState((s) => appendUserMessage(s, input));
    setInput('');
  }

  function decide(toolUseId: string, decision: 'allow' | 'deny'): void {
    wsRef.current?.send(JSON.stringify({ type: 'tool_decision', toolUseId, decision }));
    setState((s) => resolveApproval(s, toolUseId));
  }

  return (
    <section aria-label={t('chatHeading')}>
      <h2>{t('chatHeading')}</h2>
      <p
        role="alert"
        style={{ border: '2px solid var(--color-danger)', color: 'var(--color-danger)', padding: '0.5rem', marginBottom: '0.75rem' }}
      >
        {t('chatNonParityBanner')}
      </p>
      <p role="status">
        <small>
          {t('chatQuotaLabel')}{' '}
          {quota.kind === 'error' ? t('fetchUnavailable') : windowSummary(quota.kind === 'data' ? quota.value : null, Date.now())}
        </small>
      </p>
      {note !== null && <p role="alert">{note}</p>}

      {!connected && (
        <div style={box} aria-label={t('chatStartButton')}>
          <label>
            {t('chatResumeLabel')}{' '}
            <input
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              style={{ width: '20rem', maxWidth: '100%' }}
            />
          </label>{' '}
          <label>
            <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} /> {t('chatForkLabel')}
          </label>{' '}
          <button type="button" disabled={connecting} onClick={() => void start()}>
            {t('chatStartButton')}
          </button>
        </div>
      )}

      {connected && (
        <>
          <div style={{ ...box, minHeight: '8rem' }} aria-label={t('chatTranscriptAriaLabel')}>
            {state.messages.length === 0 ? (
              <p>{t('chatEmptyTranscript')}</p>
            ) : (
              state.messages.map((m, i) => (
                <p key={i} role={m.role === 'error' ? 'alert' : undefined}>
                  <strong>{m.role}:</strong> {m.text}
                </p>
              ))
            )}
          </div>

          {state.toolCards.map((t) => (
            <p key={t.toolUseId}>
              <code>{t.name}</code> <small>{JSON.stringify(t.input)}</small>
            </p>
          ))}

          {state.pendingApprovals.map((a) => (
            <div key={a.toolUseId} role="alert" style={{ ...box, borderColor: 'var(--color-warning)' }}>
              <p>
                {t('chatApproveToolPrefix')} <code>{a.name}</code>
                {t('chatApproveToolSuffix')} <small>{JSON.stringify(a.input)}</small>
              </p>
              <button type="button" onClick={() => decide(a.toolUseId, 'allow')}>
                {t('approve')}
              </button>{' '}
              <button type="button" onClick={() => decide(a.toolUseId, 'deny')}>
                {t('deny')}
              </button>
            </div>
          ))}

          <p>
            <input
              aria-label={t('chatMessageAriaLabel')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              style={{ width: '24rem', maxWidth: '100%' }}
            />{' '}
            <button type="button" onClick={send} disabled={input.trim().length === 0}>
              {t('chatSend')}
            </button>
          </p>
        </>
      )}
    </section>
  );
}
