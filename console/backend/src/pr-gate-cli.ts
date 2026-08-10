import { parseArgs } from 'node:util';

import type { RepositoryId } from 'core';

import type { PrGateManager, PrGateProjection } from './pr-gate/manager.ts';

export interface PrGateCommandResult {
  code: number;
  out: string;
  err: string;
}

const USAGE = 'usage: platform pr-gate run --repo <owner/name> --pr <number>';

function exitCode(result: PrGateProjection): number {
  if (result.systemDecision === 'PASS' || result.systemDecision === 'PASS_WITH_WARNINGS') return 0;
  if (result.systemDecision === 'HUMAN_REVIEW_REQUIRED') return 2;
  if (result.systemDecision === 'FAIL') return 3;
  return 4;
}

export async function runPrGateCommand(input: { argv: string[]; manager: PrGateManager }): Promise<PrGateCommandResult> {
  const [subcommand, ...rest] = input.argv;
  if (subcommand !== 'run') return { code: 1, out: '', err: `${USAGE}\n` };
  try {
    const { values } = parseArgs({
      args: rest,
      options: { repo: { type: 'string' }, pr: { type: 'string' } },
      strict: true,
    });
    const pullRequest = Number(values.pr);
    if (values.repo === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(values.repo) || !Number.isInteger(pullRequest) || pullRequest <= 0) {
      return { code: 1, out: '', err: `${USAGE}\n` };
    }
    const result = await input.manager.run({ repository: values.repo as RepositoryId, pullRequest });
    return { code: exitCode(result), out: `${JSON.stringify(result)}\n`, err: '' };
  } catch {
    return { code: 1, out: '', err: `${USAGE}\n` };
  }
}
