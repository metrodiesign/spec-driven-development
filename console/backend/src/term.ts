// F-Term backend (spec §4.1, REQ-13) — the highest-risk surface (INV-17), so it
// is fail-closed and backend-owned. The PTY spawner is INJECTED so lifecycle is
// testable with `sh` (no quota, no real `claude`); production passes node-pty's
// spawn. PTYs are owned by the backend: closing the browser does NOT kill them;
// re-attach replays a ring buffer; only DELETE reaps. Exactly one active writer.

export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => PtyLike;

export type TermMode = 'claude-only' | 'full-shell';

export interface AuditEntry {
  event: 'spawn' | 'close' | 'attach';
  ptyId: string;
  project: string;
  mode: TermMode;
  at: number;
}

export interface CreateSessionInput {
  project: string;
  mode: TermMode;
  /** `claude --resume <id>` when set. */
  resume?: string;
}

const RING_BYTES = 64 * 1024;

interface Session {
  id: string;
  project: string;
  mode: TermMode;
  pty: PtyLike;
  ring: string;
  alive: boolean;
  /** The single active writer's ticket; a new attach takes over (REQ-13.9). */
  writerTicket: string | null;
  /** Live output taps (WS bridges). Reads are unrestricted; writes stay single-writer. */
  taps: Set<(data: string) => void>;
}

export interface TermManagerDeps {
  spawn: SpawnPty;
  now(): number;
  /** Injected id/ticket sources for determinism in tests. */
  nextId(): string;
  nextTicket(): string;
  ticketTtlS: number;
  /** How the `claude` invocation is built for a session (kept out of core; vendor lives here). */
  buildCommand(input: CreateSessionInput): { file: string; args: string[] };
  audit(entry: AuditEntry): void;
  cwdFor(project: string): string;
}

export interface TermManager {
  create(input: CreateSessionInput): { ptyId: string; ticket: string };
  /** Issue a fresh single-use ticket and return the replay buffer (re-attach). */
  attach(ptyId: string): { ticket: string; buffer: string } | null;
  /** Consume a ticket for a WS connection; returns false if invalid/expired/reused. */
  redeemTicket(ptyId: string, ticket: string): boolean;
  /** Tap live PTY output (REQ-13.2 streaming). Returns an unsubscribe. */
  onData(ptyId: string, cb: (data: string) => void): () => void;
  write(ptyId: string, ticket: string, data: string): boolean;
  list(): { ptyId: string; project: string; mode: TermMode; alive: boolean }[];
  kill(ptyId: string): boolean;
}

/** F-Term is loopback-ONLY and hard: refused on any non-loopback bind, even with
 *  --insecure (REQ-13.4). Phase 1 ships no auth provider, so remote F-Term is
 *  impossible by construction — stricter than INV-17's auth minimum. */
export function termAccessAllowed(bindHost: string): boolean {
  return bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost';
}

export function createTermManager(deps: TermManagerDeps): TermManager {
  const sessions = new Map<string, Session>();
  const tickets = new Map<string, { ptyId: string; expiresAt: number }>();

  function issueTicket(ptyId: string): string {
    const ticket = deps.nextTicket();
    tickets.set(ticket, { ptyId, expiresAt: deps.now() + deps.ticketTtlS * 1000 });
    return ticket;
  }

  return {
    create(input) {
      const { file, args } = deps.buildCommand(input);
      const pty = deps.spawn(file, args, { cwd: deps.cwdFor(input.project), env: { TERM: 'xterm-256color' } });
      const id = deps.nextId();
      const s: Session = { id, project: input.project, mode: input.mode, pty, ring: '', alive: true, writerTicket: null, taps: new Set() };
      pty.onData((d) => {
        s.ring = (s.ring + d).slice(-RING_BYTES);
        for (const tap of s.taps) tap(d);
      });
      pty.onExit(() => {
        s.alive = false;
      });
      sessions.set(id, s);
      deps.audit({ event: 'spawn', ptyId: id, project: input.project, mode: input.mode, at: deps.now() });
      const ticket = issueTicket(id);
      s.writerTicket = ticket;
      return { ptyId: id, ticket };
    },

    attach(ptyId) {
      const s = sessions.get(ptyId);
      if (s === undefined) return null;
      const ticket = issueTicket(ptyId);
      // Single active writer: the newest attach takes over (REQ-13.9).
      s.writerTicket = ticket;
      deps.audit({ event: 'attach', ptyId, project: s.project, mode: s.mode, at: deps.now() });
      return { ticket, buffer: s.ring };
    },

    redeemTicket(ptyId, ticket) {
      const t = tickets.get(ticket);
      tickets.delete(ticket); // single-use, always consumed on redeem
      if (t === undefined || t.ptyId !== ptyId) return false;
      return t.expiresAt >= deps.now();
    },

    onData(ptyId, cb) {
      const s = sessions.get(ptyId);
      if (s === undefined) return () => {};
      s.taps.add(cb);
      return () => s.taps.delete(cb);
    },

    write(ptyId, ticket, data) {
      const s = sessions.get(ptyId);
      if (s === undefined || !s.alive) return false;
      if (s.writerTicket !== ticket) return false; // only the active writer
      s.pty.write(data);
      return true;
    },

    list() {
      return [...sessions.values()].map((s) => ({ ptyId: s.id, project: s.project, mode: s.mode, alive: s.alive }));
    },

    kill(ptyId) {
      const s = sessions.get(ptyId);
      if (s === undefined) return false;
      s.pty.kill('SIGHUP');
      s.alive = false;
      sessions.delete(ptyId);
      deps.audit({ event: 'close', ptyId, project: s.project, mode: s.mode, at: deps.now() });
      return true;
    },
  };
}
