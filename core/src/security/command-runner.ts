// One fail-closed child-process boundary for executor and gate commands (REQ-2).
// It owns sandbox enforcement and writes exit/output evidence directly; callers
// receive structured data and never manufacture a child-process result.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { EvidenceStore } from '../evidence/store.ts';
import type {
  SandboxViolationObservation,
  SandboxWrap,
} from './sandbox.ts';

export interface CommandRequest {
  command: string;
  workspaceRoot: string;
  cwd: string;
  writableRoots: string[];
  protectedRoots: string[];
  /** Phase 0 has no network-grant primitive; callers can only request denial. */
  allowNetwork: false;
  /** Policy-approved offline install profile relaxations — see SandboxCommand. */
  offlineInstall?: { gracefulDenyRoots: readonly string[] };
  timeoutMs: number;
  /** Core-owned cancellation seam used by lease/kill orchestration. */
  signal?: AbortSignal;
}

export type CommandRejectionReason =
  | 'sandbox_unavailable'
  | 'sandbox_violation'
  | 'invalid_request'
  | 'timed_out'
  | 'cancelled'
  | 'output_limit';

export type CommandResult =
  | {
      status: 'completed';
      exitCode: number;
      signal?: null;
      evidenceRef: string;
      egressBlocked: boolean;
    }
  | {
      status: 'signaled';
      exitCode: null;
      signal: NodeJS.Signals;
      evidenceRef: string;
      egressBlocked: boolean;
    }
  | {
      status: 'rejected';
      reason: CommandRejectionReason;
      detail: string;
      evidenceRef: string;
      exitCode: number;
      egressBlocked: boolean;
      observedViolation?: SandboxViolationObservation;
    };

export interface CommandRunner {
  /** Hash of the stable sanitized toolchain and transient-environment policy. */
  readonly environmentHash?: string;
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface CommandRunnerOptions {
  sandbox: SandboxWrap;
  evidence: EvidenceStore;
  /** Optional composition-owned environment; it is sanitized, never inherited whole. */
  environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Fixed control-plane tooling uses the same child-process primitive as sandboxed
 * executor/gate commands. This low-level helper stays internal to Ring 0 and is
 * deliberately not re-exported from the core package.
 */
export interface CoreToolRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  input?: Uint8Array;
  maxOutputBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type CoreToolResult =
  | {
      status: 'completed';
      exitCode: number;
      signal: null;
      stdout: Buffer;
      stderr: Buffer;
    }
  | {
      status: 'signaled';
      exitCode: null;
      signal: NodeJS.Signals;
      stdout: Buffer;
      stderr: Buffer;
    }
  | {
      status: 'timed_out' | 'cancelled' | 'output_limit' | 'launch_failed';
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: Buffer;
      stderr: Buffer;
      detail: string;
    };

interface ChildProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  input?: Uint8Array;
  maxOutputBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

const PROCESS_GROUP_REAP_MS = 500;

async function runChildProcess(request: ChildProcessRequest): Promise<CoreToolResult> {
  return await new Promise<CoreToolResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputTruncated = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      resolve({
        status: 'launch_failed',
        exitCode: null,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        detail: `failed to launch child process: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }

    const signalChildTree = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The direct child and its process group have already exited.
        }
      }
    };

    const waitForProcessGroupExit = async (): Promise<void> => {
      if (child.pid === undefined) return;
      const deadline = Date.now() + PROCESS_GROUP_REAP_MS;
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0);
        } catch {
          return;
        }
        await new Promise<void>((done) => {
          setTimeout(done, 10);
        });
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalChildTree();
    }, request.timeoutMs);
    const abort = (): void => {
      cancelled = true;
      signalChildTree();
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted === true) abort();

    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, request.maxOutputBytes - capturedBytes);
      const accepted = bytes.subarray(0, remaining);
      if (accepted.length > 0) {
        if (stream === 'stdout') stdoutChunks.push(accepted);
        else stderrChunks.push(accepted);
        capturedBytes += accepted.length;
      }
      if (bytes.length > remaining && !outputTruncated) {
        outputTruncated = true;
        signalChildTree();
      }
    };
    child.stdout.on('data', (chunk: Buffer | string) => capture('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer | string) => capture('stderr', chunk));

    child.stdin.on('error', () => {
      // A child may close stdin before consuming all input; its exit result remains authoritative.
    });
    if (request.input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(request.input);
    }

    const finish = async (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      launchError?: string,
    ): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      signalChildTree();
      await waitForProcessGroupExit();
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (launchError !== undefined) {
        resolve({
          status: 'launch_failed',
          exitCode,
          signal,
          stdout,
          stderr,
          detail: launchError,
        });
      } else if (cancelled) {
        resolve({
          status: 'cancelled',
          exitCode,
          signal,
          stdout,
          stderr,
          detail: 'child process cancelled by core',
        });
      } else if (timedOut) {
        resolve({
          status: 'timed_out',
          exitCode,
          signal,
          stdout,
          stderr,
          detail: `child process timed out after ${request.timeoutMs}ms`,
        });
      } else if (outputTruncated) {
        resolve({
          status: 'output_limit',
          exitCode,
          signal,
          stdout,
          stderr,
          detail: `child process output exceeded ${request.maxOutputBytes} bytes`,
        });
      } else if (signal !== null) {
        resolve({ status: 'signaled', exitCode: null, signal, stdout, stderr });
      } else {
        resolve({
          status: 'completed',
          exitCode: exitCode ?? -1,
          signal: null,
          stdout,
          stderr,
        });
      }
    };

    child.on('error', (error) => {
      void finish(null, null, `failed to launch child process: ${error.message}`);
    });
    child.on('close', (code, signal) => {
      void finish(code, signal);
    });
  });
}

export async function runCoreTool(request: CoreToolRequest): Promise<CoreToolResult> {
  if (!isAbsolute(request.executable)) {
    throw new Error('core tool executable must be an absolute path');
  }
  if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0) {
    throw new Error('core tool maxOutputBytes must be a finite positive integer');
  }
  const timeoutError = invalidTimeout(request.timeoutMs);
  if (timeoutError !== null) throw new Error(timeoutError);
  return await runChildProcess({
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    environment: request.environment,
    maxOutputBytes: request.maxOutputBytes,
    timeoutMs: request.timeoutMs,
    ...(request.input === undefined ? {} : { input: request.input }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

export const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_CAPTURE_BYTES = 1_048_576;
const SANDBOX_START_FAILURE = /sandbox_apply:\s*operation not permitted/i;

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sanitizedPath(rawPath: string | undefined): string {
  const candidates = [
    dirname(process.execPath),
    ...(rawPath ?? '').split(delimiter),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!seen.has(real)) {
      seen.add(real);
      resolved.push(real);
    }
  }
  return resolved.join(delimiter);
}

function baseEnvironment(
  supplied: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const source = supplied ?? process.env;
  const configuredCorepackHome =
    source['COREPACK_HOME'] ??
    (source['HOME'] === undefined ? undefined : join(source['HOME'], '.cache', 'node', 'corepack'));
  const corepackHome =
    configuredCorepackHome !== undefined &&
    isAbsolute(configuredCorepackHome) &&
    existsSync(configuredCorepackHome)
      ? realpathSync(configuredCorepackHome)
      : undefined;
  return Object.freeze({
    PATH: sanitizedPath(source['PATH']),
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    NO_COLOR: '1',
    // Corepack shims may read an already-installed package-manager distribution
    // after HOME is replaced with per-command scratch. The sandbox denies writes
    // to this cache and always denies network; a missing distribution fails closed.
    ...(corepackHome === undefined ? {} : { COREPACK_HOME: corepackHome }),
  });
}

function commandEnvironment(
  base: Readonly<Record<string, string>>,
  transientRoot: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: transientRoot,
    TMPDIR: transientRoot,
    TMP: transientRoot,
    TEMP: transientRoot,
    XDG_CACHE_HOME: join(transientRoot, 'cache'),
    npm_config_cache: join(transientRoot, 'npm-cache'),
    pnpm_config_store_dir: join(transientRoot, 'pnpm-store'),
    PNPM_HOME: join(transientRoot, 'pnpm-home'),
  };
}

function toolchainManifest(pathValue: string): Array<{ path: string; sha256: string }> {
  const tools = ['node', 'git', 'sh', 'sandbox-exec', 'python3', 'pnpm', 'npm', 'yarn'];
  const manifest: Array<{ path: string; sha256: string }> = [];
  const seen = new Set<string>();
  for (const directory of pathValue.split(delimiter)) {
    for (const tool of tools) {
      const candidate = join(directory, tool);
      if (!existsSync(candidate)) continue;
      try {
        const path = realpathSync(candidate);
        if (seen.has(path) || !statSync(path).isFile()) continue;
        seen.add(path);
        manifest.push({
          path,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        });
      } catch {
        // A disappearing or unreadable candidate is not an effective executable.
      }
    }
  }
  return manifest.sort((a, b) => a.path.localeCompare(b.path));
}

function evidenceBody(
  request: CommandRequest,
  exitCode: number,
  signal: NodeJS.Signals | null,
  stdout: Buffer,
  stderr: Buffer,
  status: 'completed' | CommandRejectionReason,
  outputTruncated = false,
): Uint8Array {
  const header = Buffer.from(
    [
      `sandbox:${status === 'sandbox_unavailable' ? 'unavailable' : 'enforced'}`,
      'egress-blocked:true',
      `status:${status}`,
      `exit:${exitCode}`,
      `signal:${signal ?? 'none'}`,
      `output-truncated:${String(outputTruncated)}`,
      '--- stdout ---',
      '',
    ].join('\n'),
  );
  const divider = Buffer.from('\n--- stderr ---\n');
  return Buffer.concat([header, stdout, divider, stderr]);
}

function invalidTimeout(timeoutMs: number): string | null {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return 'timeoutMs must be a finite positive integer';
  }
  if (timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    return `timeoutMs exceeds the core policy ceiling of ${MAX_COMMAND_TIMEOUT_MS}`;
  }
  return null;
}

export function createCommandRunner(opts: CommandRunnerOptions): CommandRunner {
  const environment = baseEnvironment(opts.environment);
  const currentEnvironmentHash = (): string =>
    sha256Hex(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        execPath: realpathSync(process.execPath),
        environment,
        toolchain: toolchainManifest(environment['PATH'] ?? ''),
        transientEnvironmentPolicy: commandEnvironment({}, '<command-scratch>'),
      }),
    );

  return {
    get environmentHash() {
      return currentEnvironmentHash();
    },
    async run(request) {
      const egressBlocked = true;
      const timeoutError = invalidTimeout(request.timeoutMs);
      if (timeoutError !== null) {
        const evidenceRef = opts.evidence.put(
          evidenceBody(
            request,
            -1,
            null,
            Buffer.alloc(0),
            Buffer.from(timeoutError),
            'invalid_request',
          ),
        );
        return {
          status: 'rejected',
          reason: 'invalid_request',
          detail: timeoutError,
          evidenceRef,
          exitCode: -1,
          egressBlocked,
        };
      }
      if (opts.sandbox.kind === 'unavailable') {
        const evidenceRef = opts.evidence.put(
          evidenceBody(
            request,
            -1,
            null,
            Buffer.alloc(0),
            Buffer.from(opts.sandbox.reason),
            'sandbox_unavailable',
          ),
        );
        return {
          status: 'rejected',
          reason: 'sandbox_unavailable',
          detail: opts.sandbox.reason,
          evidenceRef,
          exitCode: -1,
          egressBlocked,
        };
      }
      const sandbox = opts.sandbox;

      // Use the canonical path in both SBPL and the child environment. macOS
      // exposes `/var` as a symlink to `/private/var`; mixing the two spellings
      // makes an otherwise contained package-manager store miss its allow rule.
      const transientRoot = realpathSync(mkdtempSync(join(tmpdir(), 'command-scratch-')));
      try {
        let wrapped: ReturnType<Extract<SandboxWrap, { kind: 'available' }>['wrap']>;
        let childCwd: string;
        try {
          const workspaceRoot = realpathSync(request.workspaceRoot);
          childCwd = realpathSync(request.cwd);
          wrapped = sandbox.wrap({
            shellCmd: request.command,
            workspaceRoot,
            writableRoots: request.writableRoots,
            transientWritableRoots: [transientRoot],
            protectedRoots: request.protectedRoots,
            ...(request.offlineInstall === undefined
              ? {}
              : { offlineInstall: request.offlineInstall }),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const evidenceRef = opts.evidence.put(
            evidenceBody(
              request,
              -1,
              null,
              Buffer.alloc(0),
              Buffer.from(detail),
              'sandbox_unavailable',
            ),
          );
          return {
            status: 'rejected',
            reason: 'sandbox_unavailable',
            detail,
            evidenceRef,
            exitCode: -1,
            egressBlocked,
          };
        }

        const direct = await runChildProcess({
          executable: wrapped.cmd,
          args: wrapped.args,
          cwd: childCwd,
          environment: commandEnvironment(environment, transientRoot),
          maxOutputBytes: MAX_CAPTURE_BYTES,
          timeoutMs: request.timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        let status: 'completed' | CommandRejectionReason = 'completed';
        let detail: string | undefined;
        let observedViolation: SandboxViolationObservation | undefined;
        const exitCode = direct.exitCode ?? -1;
        const signal = direct.signal;
        let stderr = direct.stderr;
        const stderrText = stderr.toString('utf8');
        if (direct.status === 'timed_out') {
          status = 'timed_out';
          detail = `command timed out after ${request.timeoutMs}ms`;
        } else if (direct.status === 'cancelled') {
          status = 'cancelled';
          detail = 'command cancelled by core';
        } else if (direct.status === 'output_limit') {
          status = 'output_limit';
          detail = direct.detail;
        } else if (direct.status === 'launch_failed') {
          status = 'sandbox_unavailable';
          detail = `failed to launch enforcing sandbox: ${direct.detail}`;
        } else if (exitCode === 71 && SANDBOX_START_FAILURE.test(stderrText)) {
          status = 'sandbox_unavailable';
          detail = 'enforcing sandbox could not start';
        } else {
          try {
            const observation = sandbox.observeDirectResult?.({ exitCode, signal }) ?? null;
            if (observation !== null) {
              status = 'sandbox_violation';
              detail = `sandbox backend observed a denied ${observation.operation} operation`;
              observedViolation = observation;
            }
          } catch (error) {
            status = 'sandbox_unavailable';
            detail = `sandbox observation channel failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        if (signal !== null) {
          stderr = Buffer.concat([stderr, Buffer.from(`\ncommand terminated by ${signal}`)]);
        }
        const evidenceRef = opts.evidence.put(
          evidenceBody(
            request,
            exitCode,
            signal,
            direct.stdout,
            stderr,
            status,
            direct.status === 'output_limit',
          ),
        );
        if (status === 'completed') {
          if (direct.status === 'signaled') {
            return {
              status: 'signaled',
              exitCode: null,
              signal: direct.signal,
              evidenceRef,
              egressBlocked,
            };
          }
          return {
            status: 'completed',
            exitCode,
            signal: null,
            evidenceRef,
            egressBlocked,
          };
        }
        return {
          status: 'rejected',
          reason: status,
          detail: detail ?? status,
          evidenceRef,
          exitCode,
          egressBlocked,
          ...(observedViolation === undefined ? {} : { observedViolation }),
        };
      } finally {
        rmSync(transientRoot, { recursive: true, force: true });
      }
    },
  };
}
