import type { AdapterErrorKind, AgentCallControl } from 'aal';
import type { ChildProcess } from 'node:child_process';

const SAFE_RUNTIME_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
] as const;

export type ProviderEnvironmentKey =
  | 'HOME' | 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME' | 'XDG_CACHE_HOME'
  | 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'
  | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY' | 'GOOGLE_API_KEY' | 'DEEPSEEK_API_KEY';

/** Explicit allowlist: GitHub reporter credentials and unrelated process state never cross provider boundary. */
export function providerEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  providerKeys: readonly ProviderEnvironmentKey[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...SAFE_RUNTIME_ENV_KEYS, ...providerKeys]) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function terminateChild(child: Pick<ChildProcess, 'kill'>, graceMs = 5_000): NodeJS.Timeout {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  timer.unref();
  return timer;
}

export function linkCallControl(control?: AgentCallControl): {
  controller?: AbortController;
  reason(): Extract<AdapterErrorKind, 'timed_out' | 'cancelled'> | null;
  dispose(): void;
} {
  if (control === undefined) return { reason: () => null, dispose: () => {} };
  const controller = new AbortController();
  let reason: 'timed_out' | 'cancelled' | null = null;
  const cancel = (): void => {
    if (reason === null) reason = 'cancelled';
    controller.abort(control.signal.reason);
  };
  control.signal.addEventListener('abort', cancel, { once: true });
  if (control.signal.aborted) cancel();
  const timer = setTimeout(() => {
    if (reason === null) reason = 'timed_out';
    controller.abort(new Error(`provider timeout after ${control.timeoutMs}ms`));
  }, control.timeoutMs);
  return {
    controller,
    reason: () => reason,
    dispose() {
      clearTimeout(timer);
      control.signal.removeEventListener('abort', cancel);
    },
  };
}
