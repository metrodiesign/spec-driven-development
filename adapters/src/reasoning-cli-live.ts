import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdapterError } from 'aal';
import type { AdapterInterface } from 'aal';

import { providerEnvironment, terminateChild } from './control.ts';
import {
  createReasoningCliAdapter,
  type ReasoningCliAdapterOptions,
  type ReasoningCliExec,
  type ReasoningCliResult,
} from './reasoning-cli.ts';

const DENY_ALL_GEMINI_POLICY = `[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n`;
const DENY_ALL_OPENCODE_CONFIG = JSON.stringify({
  permission: 'deny',
  instructions: [],
  plugin: [],
  autoupdate: false,
});

export function buildGeminiReviewArgv(prompt: string, model: string | undefined, policyPath: string): string[] {
  const argv = [
    '--prompt', prompt,
    '--output-format', 'json',
    '--approval-mode', 'plan',
    '--extensions', 'none',
    '--policy', policyPath,
  ];
  if (model !== undefined) argv.push('--model', model);
  return argv;
}

export function buildOpenCodeReviewArgv(prompt: string, model: string | undefined): string[] {
  const argv = ['run', '--pure', '--format', 'json'];
  if (model !== undefined) argv.push('--model', model);
  argv.push(prompt);
  return argv;
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // Non-JSON diagnostic line stays in transcript but is not a protocol event.
    }
  }
  return out;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseGemini(stdout: string): Pick<ReasoningCliResult, 'responseText' | 'usage' | 'toolUseCount'> {
  const root = JSON.parse(stdout) as Record<string, unknown>;
  const stats = (root['stats'] ?? {}) as Record<string, unknown>;
  const models = (stats['models'] ?? {}) as Record<string, unknown>;
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  for (const model of Object.values(models)) {
    if (model === null || typeof model !== 'object') continue;
    const tokens = ((model as Record<string, unknown>)['tokens'] ?? {}) as Record<string, unknown>;
    inputTokens += numeric(tokens['prompt']) + numeric(tokens['input']);
    outputTokens += numeric(tokens['candidates']) + numeric(tokens['output']);
    reasoningTokens += numeric(tokens['thoughts']) + numeric(tokens['reasoning']);
  }
  const tools = (stats['tools'] ?? {}) as Record<string, unknown>;
  return {
    responseText: typeof root['response'] === 'string' ? root.response : '',
    usage: { inputTokens, outputTokens, reasoningTokens },
    toolUseCount: numeric(tools['totalCalls']),
  };
}

function parseOpenCode(stdout: string): Pick<ReasoningCliResult, 'responseText' | 'usage' | 'toolUseCount'> {
  const events = jsonLines(stdout);
  let responseText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let toolUseCount = 0;
  for (const event of events) {
    const part = (event['part'] ?? event) as Record<string, unknown>;
    const type = String(part['type'] ?? event['type'] ?? '');
    if (type === 'text' && typeof part['text'] === 'string') responseText += part.text;
    if (/tool/i.test(type)) toolUseCount += 1;
    const tokens = (part['tokens'] ?? {}) as Record<string, unknown>;
    inputTokens += numeric(tokens['input']);
    outputTokens += numeric(tokens['output']);
    reasoningTokens += numeric(tokens['reasoning']);
  }
  return { responseText, usage: { inputTokens, outputTokens, reasoningTokens }, toolUseCount };
}

function runChild(input: {
  binary: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  parse(stdout: string): Pick<ReasoningCliResult, 'responseText' | 'usage' | 'toolUseCount'>;
}): Promise<ReasoningCliResult> {
  return new Promise((resolve) => {
    const child = spawn(input.binary, input.argv, {
      cwd: input.cwd,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let reason: 'cancelled' | 'timed_out' | null = null;
    let finished = false;
    let forceKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      reason = 'timed_out';
      forceKill ??= terminateChild(child);
    }, input.timeoutMs ?? 600_000);
    const cancel = (): void => {
      if (reason === null) reason = 'cancelled';
      forceKill ??= terminateChild(child);
    };
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (forceKill !== undefined) clearTimeout(forceKill);
      input.signal?.removeEventListener('abort', cancel);
      if (reason !== null) {
        resolve({
          exitCode: 143,
          responseText: '',
          transcript: stdout,
          stderr: `${stderr}\nprovider call ${reason}`,
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          toolUseCount: 0,
        });
        return;
      }
      try {
        resolve({ exitCode, transcript: stdout, stderr, ...input.parse(stdout) });
      } catch (error) {
        resolve({
          exitCode: exitCode === 0 ? 1 : exitCode,
          responseText: '',
          transcript: stdout,
          stderr: `${stderr}\ninvalid provider JSON: ${String(error)}`,
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          toolUseCount: 0,
        });
      }
    };
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (error) => {
      stderr += String(error);
      finish(1);
    });
  });
}

type LiveReasoningOptions = Omit<ReasoningCliAdapterOptions, 'exec' | 'id' | 'lineage' | 'contextWindowTokens'> & {
  binary?: string;
};

export function createLiveGeminiAdapter(opts: LiveReasoningOptions): AdapterInterface {
  const exec: ReasoningCliExec = async ({ prompt, model, signal, timeoutMs }) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-gate-gemini-'));
    const policyDir = join(root, '.gemini', 'policies');
    mkdirSync(policyDir, { recursive: true });
    const policyPath = join(policyDir, 'deny-all.toml');
    writeFileSync(policyPath, DENY_ALL_GEMINI_POLICY);
    try {
      return await runChild({
        binary: opts.binary ?? 'gemini',
        argv: buildGeminiReviewArgv(prompt, model, policyPath),
        cwd: root,
        env: {
          ...providerEnvironment(process.env, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
          GEMINI_CLI_HOME: root,
        },
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        parse: parseGemini,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return createReasoningCliAdapter({ ...opts, id: 'gemini-cli', lineage: 'google', contextWindowTokens: 1_000_000, exec });
}

export function createLiveOpenCodeDeepSeekAdapter(opts: LiveReasoningOptions): AdapterInterface {
  const exec: ReasoningCliExec = async ({ prompt, model, signal, timeoutMs }) => {
    const root = mkdtempSync(join(tmpdir(), 'pr-gate-opencode-'));
    try {
      return await runChild({
        binary: opts.binary ?? 'opencode',
        argv: buildOpenCodeReviewArgv(prompt, model),
        cwd: root,
        env: {
          ...providerEnvironment(process.env, ['DEEPSEEK_API_KEY']),
          HOME: root,
          OPENCODE_CONFIG_DIR: join(root, 'config'),
          OPENCODE_CONFIG_CONTENT: DENY_ALL_OPENCODE_CONFIG,
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
        },
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        parse: parseOpenCode,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return createReasoningCliAdapter({
    ...opts,
    model: opts.model ?? 'deepseek/deepseek-chat',
    id: 'opencode-deepseek',
    lineage: 'deepseek',
    contextWindowTokens: 128_000,
    exec,
  });
}

// --- opencode-glm lane (spec: .ai/specs/opencode-glm) -------------------------
// Fifth lineage: GLM-5.3 served through the OpenCode Go gateway on the credential
// this machine already holds (auth store at <data dir>/opencode/auth.json). The
// hosted credential lives in the REAL home, while the deny-all sandbox uses a
// temp HOME — so exactly one file (auth.json, 0600) is copied into the sandbox
// per invocation and destroyed afterwards; config isolation is never loosened.

/** Model id on the OpenCode Go gateway (overridable for future glm releases). */
export const OPENCODE_GLM_DEFAULT_MODEL = 'opencode-go/glm-5.3';

export interface OpenCodeGlmOptions extends LiveReasoningOptions {
  /** Override the auth-store data dir — tests inject a temp dir; default resolves the real one. */
  authDataDir?: string;
}

/**
 * Resolve the OpenCode credential store (REQ-2.2/2.3). Pure fs probe: returns the
 * auth.json path or null — never reads or returns file CONTENT. Default data dir
 * follows OpenCode's own lookup: <XDG_DATA_HOME | ~/.local/share>/opencode.
 */
export function resolveOpenCodeAuthStore(dataDir?: string): string | null {
  const base = dataDir ?? process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  const store = join(base, 'opencode', 'auth.json');
  return existsSync(store) ? store : null;
}

/**
 * Assemble the child env for one invocation (REQ-2.1/2.2): the safe provider
 * env base, then HOME/XDG_* pointed INSIDE the sandbox root with the deny-all
 * config content and autoupdate off — identical isolation to the deepseek lane,
 * plus the data dir that carries the per-invocation auth copy.
 */
export function buildOpenCodeGlmEnv(root: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...providerEnvironment(source),
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    OPENCODE_CONFIG_DIR: join(root, 'config'),
    OPENCODE_CONFIG_CONTENT: DENY_ALL_OPENCODE_CONFIG,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  };
}

export function createLiveOpenCodeGlmAdapter(opts: OpenCodeGlmOptions): AdapterInterface {
  // Factory-time fail-fast (REQ-2.3): a missing store is a wiring error — surface it
  // before any sandbox/spawn. The message names the fix, never file content (REQ-2.5).
  const store = resolveOpenCodeAuthStore(opts.authDataDir);
  if (store === null) {
    throw new AdapterError('auth_unavailable', 'opencode auth store not found — run `opencode auth login`');
  }
  const exec: ReasoningCliExec = async ({ prompt, model, signal, timeoutMs }) => {
    const root = mkdtempSync(join(tmpdir(), 'platform-opencode-glm-'));
    try {
      const dataDir = join(root, 'data', 'opencode');
      mkdirSync(dataDir, { recursive: true });
      // Verbatim bytes then owner-only mode (REQ-2.4): copyFileSync's third arg is
      // a copy mask (0-7), not a mode — the explicit chmod is the real 0600.
      const authCopy = join(dataDir, 'auth.json');
      copyFileSync(store, authCopy);
      chmodSync(authCopy, 0o600);
      return await runChild({
        binary: opts.binary ?? 'opencode',
        argv: buildOpenCodeReviewArgv(prompt, model),
        cwd: root,
        env: buildOpenCodeGlmEnv(root),
        ...(signal !== undefined ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        parse: parseOpenCode,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return createReasoningCliAdapter({
    ...opts,
    model: opts.model ?? OPENCODE_GLM_DEFAULT_MODEL,
    id: 'opencode-glm',
    // Shared with the direct-API glm adapter BY DESIGN (clarifications): same model
    // family — fusion/susceptibility routing must not treat the two transports as
    // decorrelated lineages.
    lineage: 'zai',
    contextWindowTokens: 1_000_000,
    exec,
  });
}
