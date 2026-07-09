// Production wiring for F-Chat (REQ-17/18/19): the real `ws` transport + the
// real Agent SDK `query`. RUNTIME glue — verified live (browser + real SDK,
// task 12), not in CI. The pure session/turn logic it drives is fully
// unit-tested in chat.test.ts with a scripted queryFn (REQ-17.4); keep
// behavior here thin, mirrors term.ts / term-runtime.ts.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'node:http';

import {
  createChatConnection,
  createChatManager,
  type ChatManager,
  type ChatQueryFn,
  type ChatSdkMessage,
} from './chat.ts';

/** Bridges the real SDK query into chat.ts's minimal, structurally-honest
 *  message shape (same cast pattern as adapters/live.ts's liveQuery). */
const liveChatQuery: ChatQueryFn = (args) =>
  sdkQuery({
    prompt: args.prompt,
    options: {
      cwd: args.options.cwd,
      ...(args.options.resume !== undefined ? { resume: args.options.resume } : {}),
      ...(args.options.forkSession !== undefined ? { forkSession: args.options.forkSession } : {}),
      canUseTool: args.options.canUseTool,
    },
  }) as unknown as AsyncIterable<ChatSdkMessage>;

export interface ChatRuntime {
  manager: ChatManager;
  /** Attach the WS bridge to the HTTP server after the app is listening. */
  attachWs(server: Server): void;
}

export function createChatRuntime(opts: { auditPath: string; ticketTtlS: number; approvalTimeoutMs: number }): ChatRuntime {
  const audit = (entry: unknown): void => {
    mkdirSync(dirname(opts.auditPath), { recursive: true });
    appendFileSync(opts.auditPath, JSON.stringify(entry) + '\n');
  };
  const manager = createChatManager({
    now: () => Date.now(),
    nextId: () => `chat-${randomUUID()}`,
    nextTicket: () => randomUUID(),
    ticketTtlS: opts.ticketTtlS,
  });

  function attachWs(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/chat/ws') return;
      const ticket = url.searchParams.get('ticket') ?? '';
      const redeemed = manager.redeemTicket(ticket);
      if (redeemed === null) {
        // Complete the handshake then close 4403 (AZ-14) — the WS close-code
        // precedent term-runtime.ts sets for a bad session (4404), not a raw
        // HTTP refusal (REQ-17.2).
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4403, 'bad ticket'));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = createChatConnection({
          queryFn: liveChatQuery,
          cwd: redeemed.projectDir,
          ...(redeemed.resume !== undefined ? { initialResume: redeemed.resume } : {}),
          ...(redeemed.fork !== undefined ? { initialFork: redeemed.fork } : {}),
          approvalTimeoutMs: opts.approvalTimeoutMs,
          now: () => Date.now(),
          setTimer: (cb, ms) => {
            const t = setTimeout(cb, ms);
            return { cancel: () => clearTimeout(t) };
          },
          send: (event) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
          },
          audit,
          close: () => ws.close(),
        });
        ws.on('message', (data: Buffer) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString('utf8'));
          } catch {
            return;
          }
          const msg = parsed as { type?: string; text?: string; toolUseId?: string; decision?: string };
          if (msg.type === 'user_message' && typeof msg.text === 'string') void conn.handleUserMessage(msg.text);
          if (msg.type === 'tool_decision' && typeof msg.toolUseId === 'string' && (msg.decision === 'allow' || msg.decision === 'deny')) {
            conn.handleToolDecision(msg.toolUseId, msg.decision);
          }
        });
        ws.on('close', () => conn.handleDisconnect());
      });
    });
  }

  return { manager, attachWs };
}
