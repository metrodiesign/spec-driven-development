#!/usr/bin/env node
// `platform console` launcher (spec §8, REQ-12.1). Fail-closed startup gate
// per §13.1 (REQ-12.2/12.3): non-loopback bind without an auth provider refuses
// to start; --insecure is never a default and always warns loudly.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { buildApp } from '../src/app.ts';
import { decideStartup } from '../src/security.ts';
import { decideLiveRun, loadGoalContract } from '../src/loop-cli.ts';
import { createTermRuntime } from '../src/term-runtime.ts';

const HELP = `usage:
  platform console [--port <n>] [--host <h>] [--no-open] [--insecure]
  platform loop run --goal <path> [--live] [--task <id>]

  console:
    --port      port to listen on (default 9119)
    --host      bind host (default 127.0.0.1; non-loopback refuses without auth — see docs)
    --no-open   do not open the browser
    --insecure  disable the auth gate on non-loopback binds (NEVER use on untrusted networks)
  loop run:
    --goal      path to goal.yaml (frozen by raw-byte hash in core)
    --live      use the REAL model adapter — refused in CI / non-TTY, requires typed confirmation
    --task      run a single task id
`;

/** `platform loop run` — Phase-1 supervised loop entry. Live is structurally gated. */
async function runLoop(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest.slice(1), // drop the 'run' subcommand
    options: {
      goal: { type: 'string' },
      live: { type: 'boolean', default: false },
      task: { type: 'string' },
    },
  });
  if (values.goal === undefined) {
    process.stderr.write('platform loop run: --goal <path> is required\n');
    process.exit(1);
  }
  // Structural live guard FIRST — refuse before any work so CI can never spend quota.
  const decision = decideLiveRun({
    live: values.live as boolean,
    ciEnv: process.env['CI'] !== undefined && process.env['CI'] !== '',
    isTTY: process.stdin.isTTY === true,
  });
  if (decision.action === 'refuse') {
    process.stderr.write(`platform loop run: ${decision.reason}\n`);
    process.exit(2);
  }
  const contract = loadGoalContract(values.goal as string);
  if (decision.action === 'confirm') {
    // Live run requires an operator (task 11 wires the real adapter + budget cap).
    process.stdout.write(
      `goal ${contract.goal.id}: budget cap ${contract.budget.maxCostUnits} costUnits.\n${decision.prompt}\n`,
    );
    process.stdout.write('(live wiring lands in task 11 — this build refuses to spend quota)\n');
    process.exit(0);
  }
  process.stdout.write(`platform loop run (stub adapter): goal ${contract.goal.id} — CI-safe, no quota spend\n`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'loop') {
    if (rest[0] !== 'run') {
      process.stderr.write(HELP);
      process.exit(1);
    }
    await runLoop(rest);
    return;
  }
  if (command !== 'console') {
    process.stderr.write(HELP);
    process.exit(command === undefined || command === '--help' ? 0 : 1);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: 'string', default: '9119' },
      host: { type: 'string', default: '127.0.0.1' },
      'no-open': { type: 'boolean', default: false },
      insecure: { type: 'boolean', default: false },
    },
  });

  const port = Number(values.port);
  const host = values.host as string;

  const decision = decideStartup({
    host,
    insecure: values.insecure as boolean,
    hasAuthProvider: false, // Phase 0 ships none
  });
  if (decision.action === 'refuse') {
    process.stderr.write(`platform console: ${decision.message}\n`);
    process.exit(1);
  }
  if (decision.action === 'start_with_warning') {
    process.stderr.write(`\n*** ${decision.warning} ***\n\n`);
  }

  // F-Term (REQ-13) only when bound to loopback — the highest-risk surface stays
  // impossible to expose remotely in Phase 1 (INV-17).
  const dataDir = join(homedir(), '.platform');
  const termRuntime =
    host === '127.0.0.1' || host === '::1' || host === 'localhost'
      ? createTermRuntime({
          projectsRoot: homedir(),
          auditPath: join(dataDir, 'term-audit.jsonl'),
          ticketTtlS: 30,
        })
      : undefined;

  const app = buildApp({
    homeDir: homedir(),
    env: process.env,
    bindHost: host,
    port,
    dataDir,
    now: () => Date.now(),
    webDistDir: join(import.meta.dirname, '..', '..', 'web', 'dist'),
    ...(termRuntime ? { termManager: termRuntime.manager } : {}),
  });

  await app.listen({ host, port });
  if (termRuntime !== undefined) termRuntime.attachWs(app.server);
  const url = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  process.stdout.write(`platform console listening on ${url}\n`);
  if (values['no-open'] !== true && process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`platform console: ${(err as Error).message}\n`);
  process.exit(1);
});
