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
import { providerEnvironment, terminateChild } from './control.ts';

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

// OpenAI Structured Outputs "strict" mode (what `codex exec --output-schema` validates
// against) requires, at EVERY object node: additionalProperties:false and required
// listing EVERY property key — there is no "optional property" in strict mode, only a
// nullable one. Anthropic has no such requirement, so the shared outputSchema (used by
// both lineages, aal/src/conformance/harness.ts) stays plain JSON Schema; this
// normalization is purely a Codex/OpenAI wire quirk and stays local to the live spawn.
// Empirically confirmed against codex-cli 0.139.0 (docs/spikes/SPIKE-6.md's residual —
// live task 13): missing additionalProperties, missing array items, and incomplete
// required each fail closed with a distinct `invalid_json_schema` error.
function strictifyForCodex(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
  const schema = { ...(node as Record<string, unknown>) };
  if (schema['type'] === 'object') {
    const props = (schema['properties'] ?? {}) as Record<string, unknown>;
    const requiredBefore = new Set(Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : []);
    const nextProps: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      const strict = strictifyForCodex(propSchema) as Record<string, unknown>;
      if (!requiredBefore.has(key)) {
        const t = strict['type'];
        const types = Array.isArray(t) ? t : [t];
        // Already nullable (the shared schema may declare `['string','null']` itself,
        // e.g. for a field a repair-check also validates) — don't double up ['x','null','null'],
        // which codex-cli 0.139.0 rejects outright (invalid_json_schema).
        strict['type'] = types.includes('null') ? types : [...types, 'null'];
      }
      nextProps[key] = strict;
    }
    schema['properties'] = nextProps;
    schema['required'] = Object.keys(nextProps);
    schema['additionalProperties'] = false;
  }
  if (schema['type'] === 'array' && schema['items'] !== undefined) {
    schema['items'] = strictifyForCodex(schema['items']);
  }
  return schema;
}

export function createLiveCodexAdapter(opts: Omit<CodexAdapterOptions, 'exec'>): AdapterInterface {
  const killTimeoutMs = opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;

  const exec: ExecFn = ({ prompt, schema, cwd, model, signal, timeoutMs }) =>
    new Promise<CodexExecResult>((resolve) => {
      const tmp = mkdtempSync(join(tmpdir(), 'codex-'));
      const schemaPath = join(tmp, 'schema.json');
      const outPath = join(tmp, 'last.json');
      writeFileSync(schemaPath, JSON.stringify(strictifyForCodex(schema)));
      const argv = buildCodexArgv(prompt, { schemaPath, outPath, ...(model !== undefined ? { model } : {}) });

      const child = spawn('codex', argv, {
        cwd,
        stdio: [...CODEX_STDIO],
        env: providerEnvironment(process.env, ['HOME', 'CODEX_HOME', 'OPENAI_API_KEY']),
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;
      let finished = false;
      let forceKill: NodeJS.Timeout | undefined;
      // Hard kill timeout (REQ-2.9): a hung exec is SIGTERM'd -> non-zero exit -> transport.
      const timer = setTimeout(() => {
        timedOut = true;
        forceKill ??= terminateChild(child);
      }, Math.min(killTimeoutMs, timeoutMs ?? killTimeoutMs));
      const cancel = (): void => {
        cancelled = true;
        forceKill ??= terminateChild(child);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      const finish = (result: CodexExecResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (forceKill !== undefined) clearTimeout(forceKill);
        signal?.removeEventListener('abort', cancel);
        rmSync(tmp, { recursive: true, force: true });
        resolve(result);
      };
      child.on('close', (code) => {
        const lastMessage = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
        finish({
          exitCode: timedOut || cancelled ? 143 : (code ?? 1),
          lastMessage,
          events: parseCodexEvents(stdout),
          stderr: timedOut
            ? `${stderr}\ncodex exec timed out after ${Math.min(killTimeoutMs, timeoutMs ?? killTimeoutMs)}ms`
            : cancelled ? `${stderr}\ncodex exec cancelled` : stderr,
        });
      });
      child.on('error', (err) => {
        finish({ exitCode: 1, lastMessage: '', events: [], stderr: String(err) });
      });
    });

  return createCodexAdapter({ ...opts, exec });
}
