// Live wiring for the Codex adapter (Ring 2). Wraps a real `codex exec` child
// process into the adapter's injected ExecFn. Imported only on the `--live` path —
// CI and the fake-ExecFn tests never touch this, so no quota is spent in tests. The
// tested behavior lives in codex.ts + the pure `buildCodexArgv` below (argv snapshot,
// no real spawn); this only bridges to the process (verified live in task 13).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCodexAdapter,
  parseCodexEvents,
  DEFAULT_KILL_TIMEOUT_MS,
  type CodexAdapterOptions,
  type CodexExecResult,
  type ExecFn,
} from './codex.ts';
import type { AdapterInterface } from 'aal';

// SPIKE-6 #1: an open stdin makes `codex exec` block forever on "Reading additional
// input from stdin…". stdin is IGNORED at spawn; the prompt rides argv instead.
export const CODEX_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/**
 * Build the `codex exec` argv (pure — snapshot-tested, REQ-2.8). SPIKE-6 flags:
 * `--sandbox read-only` is the propose-only ENFORCEMENT (not the prompt, #4);
 * `--ephemeral` leaves no session files; `--ignore-user-config` + explicit flags =
 * zero machine-config dependence (#3); `--output-schema` constrains the final message;
 * `-o` writes it to a file; `--json` emits the JSONL event/usage stream. The prompt is
 * the final positional arg because stdin is ignored.
 */
export function buildCodexArgv(prompt: string, opts: { model?: string; schemaPath: string; outPath: string }): string[] {
  const argv = [
    'exec',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--output-schema', opts.schemaPath,
    '-o', opts.outPath,
    '--json',
  ];
  if (opts.model !== undefined) argv.push('-m', opts.model);
  argv.push(prompt);
  return argv;
}

export function createLiveCodexAdapter(opts: Omit<CodexAdapterOptions, 'exec'>): AdapterInterface {
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

  const exec: ExecFn = ({ prompt, schema, cwd, model }) =>
    new Promise<CodexExecResult>((resolve) => {
      const tmp = mkdtempSync(join(tmpdir(), 'codex-'));
      const schemaPath = join(tmp, 'schema.json');
      const outPath = join(tmp, 'last.json');
      writeFileSync(schemaPath, JSON.stringify(schema));
      const argv = buildCodexArgv(prompt, { schemaPath, outPath, ...(model !== undefined ? { model } : {}) });

      const child = spawn('codex', argv, { cwd, stdio: [...CODEX_STDIO] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // Hard kill timeout (REQ-2.9): a hung exec is SIGTERM'd -> non-zero exit -> transport.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, killTimeoutMs);

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const finish = (result: CodexExecResult): void => {
        clearTimeout(timer);
        rmSync(tmp, { recursive: true, force: true });
        resolve(result);
      };
      child.on('close', (code) => {
        const lastMessage = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
        finish({
          exitCode: timedOut ? 143 : (code ?? 1),
          lastMessage,
          events: parseCodexEvents(stdout),
          stderr: timedOut ? `${stderr}\ncodex exec exceeded killTimeoutMs (${killTimeoutMs}ms)` : stderr,
        });
      });
      child.on('error', (err) => {
        finish({ exitCode: 1, lastMessage: '', events: [], stderr: String(err) });
      });
    });

  return createCodexAdapter({ ...opts, exec });
}
