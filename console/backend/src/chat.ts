// F-Chat backend (spec §8, REQ-17/18/19) — a Claude-specific console surface;
// INV-17's "interactive approval = CLI-native" rule scopes to F-Term only, so
// F-Chat is sanctioned to drive query()/canUseTool from the web (design.md G).
// The SDK entry is INJECTED as `queryFn` so this file imports nothing from
// the SDK and stays fully unit-testable with a scripted fake (REQ-17.4). Real
// wiring (the `ws` transport + the real SDK `query`) lives in chat-runtime.ts,
// mirroring the term.ts / term-runtime.ts split (verified live, not in CI).

export interface CreateChatSessionInput {
  projectDir: string;
  resume?: string;
  fork?: boolean;
}

export interface ChatManagerDeps {
  now(): number;
  nextId(): string;
  nextTicket(): string;
  ticketTtlS: number;
}

export interface ChatManager {
  create(input: CreateChatSessionInput): { sessionId: string; ticket: string };
  /** Single-use, TTL-bound (REQ-17.1/17.2): consumed on redeem regardless of validity, same as F-Term. */
  redeemTicket(ticket: string): (CreateChatSessionInput & { sessionId: string }) | null;
}

export function createChatManager(deps: ChatManagerDeps): ChatManager {
  const tickets = new Map<string, { input: CreateChatSessionInput; sessionId: string; expiresAt: number }>();
  return {
    create(input) {
      const sessionId = deps.nextId();
      const ticket = deps.nextTicket();
      tickets.set(ticket, { input, sessionId, expiresAt: deps.now() + deps.ticketTtlS * 1000 });
      return { sessionId, ticket };
    },
    redeemTicket(ticket) {
      const t = tickets.get(ticket);
      tickets.delete(ticket); // single-use, always consumed on redeem
      if (t === undefined || t.expiresAt < deps.now()) return null;
      return { ...t.input, sessionId: t.sessionId };
    },
  };
}

/** A minimal, structurally-honest subset of the real SDK's message shape (own
 *  field names, no SDK import — same pattern as adapters/anthropic.ts's local
 *  `SdkMessage`). `content` blocks mirror the Anthropic API's TextBlock /
 *  ToolUseBlock shape so chat-runtime.ts's cast onto the real SDK stream is a
 *  narrowing read, not a type lie. */
export interface ChatContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
export interface ChatSdkMessage {
  type: string;
  session_id?: string;
  message?: { content?: ChatContentBlock[] };
  is_error?: boolean;
  result?: string;
  errors?: string[];
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

export type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { toolUseID: string },
) => Promise<PermissionDecision>;

export type ChatQueryFn = (args: {
  prompt: string;
  options: { cwd: string; resume?: string; forkSession?: boolean; canUseTool: CanUseToolFn };
}) => AsyncIterable<ChatSdkMessage>;

export type ChatServerEvent =
  | { type: 'stream_delta'; text: string }
  | { type: 'tool_card'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'approval_request'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: 'error'; message: string }
  | { type: 'done'; sdkSessionId: string | null };

export interface ChatTimer {
  cancel(): void;
}

export interface ChatConnectionDeps {
  queryFn: ChatQueryFn;
  cwd: string;
  initialResume?: string;
  initialFork?: boolean;
  /** canUseTool expiry -> deny, fail-closed (REQ-18.3). */
  approvalTimeoutMs: number;
  now(): number;
  setTimer(cb: () => void, ms: number): ChatTimer;
  send(event: ChatServerEvent): void;
  audit(entry: Record<string, unknown>): void;
  /** Closes the transport. Called only after a stream error (REQ-18.4) — a
   *  normal `done` leaves the session open for the next user_message. */
  close(): void;
}

export interface ChatConnection {
  handleUserMessage(text: string): Promise<void>;
  handleToolDecision(toolUseId: string, decision: 'allow' | 'deny'): void;
  handleDisconnect(): void;
}

/** Drives one turn at a time over an injected sink — WS-transport-agnostic so
 *  it's testable with a fake sink + scripted queryFn (design.md's "chat.ts
 *  tests with scripted queryFn"). One `queryFn` call per user_message,
 *  chained via `resume` = the previous turn's SDK session id (REQ-19.1) —
 *  simpler than holding one long-lived streaming Query open across however
 *  long the operator takes to type the next message, and mirrors adapters/
 *  anthropic.ts's own per-request `query()` call precedent. */
export function createChatConnection(deps: ChatConnectionDeps): ChatConnection {
  let sdkSessionId: string | null = null;
  let usedInitialTurn = false;
  let busy = false;
  const pending = new Map<string, { resolve(d: 'allow' | 'deny'): void }>();

  const canUseTool: CanUseToolFn = (toolName, input, opts) =>
    new Promise((resolve) => {
      const timer = deps.setTimer(() => {
        pending.delete(opts.toolUseID);
        deps.audit({ event: 'chat_tool_decision', decision: 'timeout', toolUseId: opts.toolUseID, name: toolName, at: deps.now() });
        resolve({ behavior: 'deny', message: 'approval timed out' });
      }, deps.approvalTimeoutMs);
      pending.set(opts.toolUseID, {
        resolve: (decision) => {
          timer.cancel();
          resolve(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'denied by operator' });
        },
      });
      deps.send({ type: 'approval_request', toolUseId: opts.toolUseID, name: toolName, input });
    });

  return {
    async handleUserMessage(text) {
      if (busy) {
        deps.send({ type: 'error', message: 'a turn is already in progress' });
        return;
      }
      busy = true;
      const resume = usedInitialTurn ? (sdkSessionId ?? undefined) : deps.initialResume;
      const forkSession = !usedInitialTurn && deps.initialFork === true;
      usedInitialTurn = true;
      try {
        const options: { cwd: string; resume?: string; forkSession?: boolean; canUseTool: CanUseToolFn } = {
          cwd: deps.cwd,
          forkSession,
          canUseTool,
        };
        if (resume !== undefined) options.resume = resume;
        for await (const msg of deps.queryFn({ prompt: text, options })) {
          if (msg.session_id !== undefined) sdkSessionId = msg.session_id;
          if (msg.type === 'assistant') {
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && block.text !== undefined) {
                deps.send({ type: 'stream_delta', text: block.text });
              } else if (block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
                deps.send({ type: 'tool_card', toolUseId: block.id, name: block.name, input: block.input ?? {} });
              }
            }
          }
          if (msg.type === 'result' && msg.is_error === true) {
            const message = msg.result ?? msg.errors?.join('; ') ?? 'unknown error';
            deps.send({ type: 'error', message });
            deps.audit({ event: 'chat_stream_error', message, at: deps.now() });
            deps.close();
            return;
          }
        }
        deps.send({ type: 'done', sdkSessionId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.send({ type: 'error', message });
        deps.audit({ event: 'chat_stream_error', message, at: deps.now() });
        deps.close();
      } finally {
        busy = false;
      }
    },

    handleToolDecision(toolUseId, decision) {
      const p = pending.get(toolUseId);
      if (p === undefined) return; // stale/unknown id — ignore, mirrors awaitDecision's single-resolver idiom
      pending.delete(toolUseId);
      deps.audit({ event: 'chat_tool_decision', decision, toolUseId, at: deps.now() });
      p.resolve(decision);
    },

    handleDisconnect() {
      for (const [toolUseId, p] of pending) {
        deps.audit({ event: 'chat_tool_decision', decision: 'ws_drop', toolUseId, at: deps.now() });
        p.resolve('deny');
      }
      pending.clear();
    },
  };
}
