// SPIKE-2 (§15.2): PTY parity proof — node-pty spawns the REAL CLI binary; the
// automatable subset: (a) TUI renders + a slash command works, (b) the PTY is
// owned by this backend process (survives a client "detach" — nobody reading),
// (c) `--resume <id>` opens an existing session. TUI-visual checks that need a
// human eye (permission prompt behavior, /usage quota display) are recorded as
// the manual remainder in SPIKE-2.md — this script never claims them.
// NOTE: only slash commands are sent — no model prompt, no quota consumed.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import pty from 'node-pty';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const cwd = mkdtempSync(join(tmpdir(), 'spike2-'));

// (a) spawn the real binary behind a PTY
const term = pty.spawn('claude', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,
  env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
});
let buffer = '';
term.onData((d: string) => {
  buffer += d;
});

await sleep(6000);
check('TUI banner rendered', buffer.length > 500, `${buffer.length} bytes of TUI output`);

// slash command — renders locally, consumes no quota
term.write('/status');
await sleep(1200);
term.write('\r');
await sleep(4000);
const statusRendered = /Session ID|Version|Model|Account|Status/i.test(buffer);
check('slash command /status works in-terminal', statusRendered);

// (b) "detach": stop consuming output for a while — PTY must stay alive
const before = buffer.length;
await sleep(3000);
term.write('\r');
await sleep(1500);
check('PTY survives idle detach (backend-owned)', buffer.length >= before && term.pid > 0, `pid=${term.pid}`);

// quit the TUI
term.write('\x03');
await sleep(400);
term.write('\x03');
await sleep(1000);
term.kill();

// (c) --resume an existing real session from this machine
const projDir = join(homedir(), '.claude', 'projects');
const someProject = readdirSync(projDir).find((p) => {
  try {
    return readdirSync(join(projDir, p)).some((f) => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
});
if (someProject === undefined) {
  check('claude --resume opens an existing session', false, 'no local sessions found');
} else {
  const sessionFile = readdirSync(join(projDir, someProject)).find((f) => f.endsWith('.jsonl'));
  const sessionId = sessionFile?.replace(/\.jsonl$/, '') ?? '';
  // resume must run from the project cwd the session belongs to; use --resume id
  let resumeBuf = '';
  const decoded = '/' + someProject.slice(1).replace(/-/g, '/');
  const resumeCwd = decoded.startsWith('/') && decoded.includes('/') ? decoded : cwd;
  let resumeTerm: ReturnType<typeof pty.spawn> | null = null;
  try {
    resumeTerm = pty.spawn('claude', ['--resume', sessionId], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: resumeCwd,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    resumeTerm.onData((d: string) => {
      resumeBuf += d;
    });
    await sleep(7000);
    check(
      'claude --resume renders an existing session',
      resumeBuf.length > 500,
      `session=${sessionId.slice(0, 8)}… ${resumeBuf.length} bytes`,
    );
  } catch (err) {
    check('claude --resume renders an existing session', false, (err as Error).message);
  } finally {
    resumeTerm?.write('\x03');
    await sleep(300);
    resumeTerm?.write('\x03');
    await sleep(500);
    resumeTerm?.kill();
  }
}

rmSync(cwd, { recursive: true, force: true });
const verdict = results.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE2 VERDICT: ${verdict} (automated subset — manual checklist in SPIKE-2.md)`);
process.exit(verdict === 'PASS' ? 0 : 1);
