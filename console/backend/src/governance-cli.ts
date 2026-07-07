// `platform governance list|approve <id>` (REQ-9.3). A refused run has no server, so
// this appends GOVERNANCE_CHANGE to the durable log directly — the human at the TTY IS
// the approval (INV-15). Pure over its inputs (logPath/policyDir/now) so it is unit-
// testable with no process; bin/platform.ts wires it to argv + the real repo paths.

import { approveProposal, listPendingProposals, readGovernanceLog } from 'core';

export interface GovernanceCommandInput {
  argv: string[]; // subcommand + args, e.g. ['approve', 'gov-abc']
  logPath: string;
  policyDir: string;
  now(): number;
}

export interface GovernanceCommandResult {
  code: number;
  out: string;
  err: string;
}

const USAGE = 'usage: platform governance list | platform governance approve <id>';

export function runGovernanceCommand(input: GovernanceCommandInput): GovernanceCommandResult {
  const [sub, id] = input.argv;
  const clock = { now: input.now };

  if (sub === 'list') {
    const pending = listPendingProposals(readGovernanceLog(input.logPath));
    if (pending.length === 0) return { code: 0, out: 'no pending governance proposals\n', err: '' };
    const lines = pending.map((p) => {
      const scope = p.taskId !== undefined ? ` task=${p.taskId}` : '';
      return `${p.id}  ${p.kind}  ${p.beforeHash ?? 'null'} -> ${p.afterHash}${scope}  (${p.rationale})`;
    });
    return { code: 0, out: `${lines.join('\n')}\n`, err: '' };
  }

  if (sub === 'approve') {
    if (id === undefined) return { code: 1, out: '', err: `${USAGE}\n` };
    const res = approveProposal({ logPath: input.logPath, id, clock, decidedBy: 'human' });
    if (!res.ok) return { code: 1, out: '', err: `no such pending proposal: ${id}\n` };
    const tail =
      res.change.kind === 'flaky_quarantine' && res.change.taskId !== undefined
        ? ` — quarantine of task ${res.change.taskId} takes effect when the run next loads it`
        : '';
    return { code: 0, out: `approved ${res.change.id} (${res.change.kind})${tail}\n`, err: '' };
  }

  return { code: 1, out: '', err: `${USAGE}\n` };
}
