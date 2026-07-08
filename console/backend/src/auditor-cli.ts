// `platform auditor run` (REQ-14.7) — a separate process, its own EventLog
// handle. Pure over its inputs (dbPath/repoDir/... + now) so it is unit-
// testable with no real process; bin/platform.ts wires it to argv + real paths.

import { parseArgs } from 'node:util';

import { runOobAudit } from 'core';

export interface AuditorCommandInput {
  argv: string[]; // subcommand + args, e.g. ['run', '--db', path]
  dbPath: string;
  repoDir: string;
  gateConfigRelPath: string;
  defaultRate: number;
  evidenceDir: string;
  now(): number;
}

export interface AuditorCommandResult {
  code: number;
  out: string;
  err: string;
}

const USAGE = 'usage: platform auditor run [--db <path>] [--repo <dir>] [--rate <pct>]';

export async function runAuditorCommand(input: AuditorCommandInput): Promise<AuditorCommandResult> {
  const [sub, ...rest] = input.argv;
  if (sub !== 'run') {
    return { code: 1, out: '', err: `${USAGE}\n` };
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      rate: { type: 'string' },
    },
  });

  const rate = values.rate !== undefined ? Number(values.rate) : input.defaultRate;
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return { code: 1, out: '', err: `platform auditor run: --rate must be a number in [0,100], got ${String(values.rate)}\n` };
  }

  const verdicts = await runOobAudit({
    dbPath: values.db ?? input.dbPath,
    repoDir: values.repo ?? input.repoDir,
    gateConfigRelPath: input.gateConfigRelPath,
    sampleRate: rate,
    evidenceDir: input.evidenceDir,
    clock: { now: input.now },
  });

  if (verdicts.length === 0) {
    return { code: 0, out: 'oob auditor: no eligible targets this cycle\n', err: '' };
  }
  const lines = verdicts.map(
    (v) =>
      `${v.taskId}  ${v.verdict}  mergeCommit=${v.mergeCommit.slice(0, 12)}  original=${v.originalRef}  rerun=${v.rerunRef}`,
  );
  const nonRepro = verdicts.filter((v) => v.verdict === 'non_repro').length;
  return {
    code: nonRepro > 0 ? 2 : 0,
    out: `${lines.join('\n')}\n`,
    err: '',
  };
}
