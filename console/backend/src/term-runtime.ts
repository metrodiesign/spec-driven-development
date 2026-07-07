// Production wiring for F-Term (REQ-13): node-pty spawner + a real TermManager +
// a WS bridge. This is RUNTIME glue — verified live in task 11 (browser + real
// `claude`), not in CI. The pure lifecycle logic it drives is fully unit-tested
// in term.test.ts; keep behavior here thin.

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { spawn as ptySpawn } from 'node-pty';
import { WebSocketServer } from 'ws';
import type { Server } from 'node:http';

import { readProjects } from './claude-data.ts';
import { createTermManager, type CreateSessionInput, type PtyLike, type SpawnPty, type TermManager } from './term.ts';

/** Build the `claude` invocation for a session. claude-only spawns the binary
 *  directly (no arbitrary shell); full-shell is an explicit opt-in (§4.1). */
function buildCommand(input: CreateSessionInput): { file: string; args: string[] } {
  if (input.mode === 'full-shell') return { file: process.env['SHELL'] ?? '/bin/sh', args: [] };
  const args = input.resume !== undefined ? ['--resume', input.resume] : [];
  return { file: 'claude', args };
}

const nodePtySpawn: SpawnPty = (file, args, opts): PtyLike => {
  const p = ptySpawn(file, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  return {
    pid: p.pid,
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(cb),
    write: (d) => p.write(d),
    kill: (s) => p.kill(s),
  };
};

export interface TermRuntime {
  manager: TermManager;
  /** Attach the WS bridge to the HTTP server after the app is listening. */
  attachWs(server: Server): void;
}

export function createTermRuntime(opts: { projectsRoot: string; auditPath: string; ticketTtlS: number }): TermRuntime {
  const audit = (entry: unknown): void => {
    mkdirSync(dirname(opts.auditPath), { recursive: true });
    appendFileSync(opts.auditPath, JSON.stringify(entry) + '\n');
  };
  const manager = createTermManager({
    spawn: nodePtySpawn,
    now: () => Date.now(),
    nextId: () => `pty-${randomUUID()}`,
    nextTicket: () => randomUUID(),
    ticketTtlS: opts.ticketTtlS,
    buildCommand,
    audit,
    // `project` is the MUNGED ~/.claude/projects dir id — the real cwd is
    // recovered from the project's session JSONL (claude-data), never joined raw.
    cwdFor: (project) =>
      readProjects(opts.projectsRoot).projects.find((p) => p.id === project)?.cwd ?? opts.projectsRoot,
  });

  function attachWs(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/term/ws') return;
      const ptyId = url.searchParams.get('ptyId') ?? '';
      const ticket = url.searchParams.get('ticket') ?? '';
      // Single-use ticket redemption (REQ-13.3); a bad/expired/reused ticket closes 4403.
      if (!manager.redeemTicket(ptyId, ticket)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const re = manager.attach(ptyId);
        if (re === null) {
          ws.close(4404);
          return;
        }
        ws.send(re.buffer); // replay ring buffer on (re)attach (REQ-13.2)
        const off = manager.onData(ptyId, (d) => ws.send(d)); // live stream (REQ-13.2)
        ws.on('close', off);
        ws.on('message', (data: Buffer) => manager.write(ptyId, re.ticket, data.toString('utf8')));
      });
    });
  }

  return { manager, attachWs };
}
