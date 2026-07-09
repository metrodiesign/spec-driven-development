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

const box: React.CSSProperties = {
  border: '1px solid #8884',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};

export function Chat({ project }: { project: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<ChatUiState>(initialChatUiState);
  const [input, setInput] = useState('');
  const [resume, setResume] = useState('');
  const [fork, setFork] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [quota, setQuota] = useState<WindowInfo | null>(null);

  useEffect(() => {
    fetch('/api/usage/estimate')
      .then((r) => r.json())
      .then((d: { currentWindow: WindowInfo | null }) => setQuota(d.currentWindow))
      .catch(() => setQuota(null));
  }, []);

  useEffect(() => () => wsRef.current?.close(), []);

  async function start(): Promise<void> {
    const body: Record<string, string | boolean> = { projectDir: project };
    if (resume.trim().length > 0) body['resume'] = resume.trim();
    if (fork) body['fork'] = true;
    const r = await fetch('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setNote(`session create failed: ${((await r.json()) as { error?: string }).error ?? r.status}`);
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
    <section aria-label="Chat">
      <h2>Chat</h2>
      <p role="alert" style={{ border: '2px solid #b30000', color: '#b30000', padding: '0.5rem', marginBottom: '0.75rem' }}>
        ไม่ครบเท่า CLI — slash commands/plan mode ไม่มี; ใช้ Terminal สำหรับ 100% parity
      </p>
      <p role="status">
        <small>Quota: {windowSummary(quota, Date.now())}</small>
      </p>
      {note !== null && <p role="alert">{note}</p>}

      {!connected && (
        <div style={box} aria-label="Start chat">
          <label>
            resume session id (optional){' '}
            <input
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              style={{ width: '20rem', maxWidth: '100%' }}
            />
          </label>{' '}
          <label>
            <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} /> fork
          </label>{' '}
          <button type="button" onClick={() => void start()}>
            Start chat
          </button>
        </div>
      )}

      {connected && (
        <>
          <div style={{ ...box, minHeight: '8rem' }} aria-label="Transcript">
            {state.messages.length === 0 ? (
              <p>say something…</p>
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
            <div key={a.toolUseId} role="alert" style={{ ...box, borderColor: '#b8860b' }}>
              <p>
                approve tool <code>{a.name}</code>? <small>{JSON.stringify(a.input)}</small>
              </p>
              <button type="button" onClick={() => decide(a.toolUseId, 'allow')}>
                Approve
              </button>{' '}
              <button type="button" onClick={() => decide(a.toolUseId, 'deny')}>
                Deny
              </button>
            </div>
          ))}

          <p>
            <input
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
              style={{ width: '24rem', maxWidth: '100%' }}
            />{' '}
            <button type="button" onClick={send} disabled={input.trim().length === 0}>
              Send
            </button>
          </p>
        </>
      )}
    </section>
  );
}
