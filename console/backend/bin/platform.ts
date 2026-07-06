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

const HELP = `usage: platform console [--port <n>] [--host <h>] [--no-open] [--insecure]

  --port      port to listen on (default 9119)
  --host      bind host (default 127.0.0.1; non-loopback refuses without auth — see docs)
  --no-open   do not open the browser
  --insecure  disable the auth gate on non-loopback binds (NEVER use on untrusted networks)
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
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

  const app = buildApp({
    homeDir: homedir(),
    env: process.env,
    bindHost: host,
    port,
    dataDir: join(homedir(), '.platform'),
    now: () => Date.now(),
    webDistDir: join(import.meta.dirname, '..', '..', 'web', 'dist'),
  });

  await app.listen({ host, port });
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
