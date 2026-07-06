// Gate ladder (spec §6.4, REQ-8/9). Core runs every command itself and captures
// output straight from the child process into the evidence store — reports are
// core-produced, never agent-reported. T2/T3 report not_enabled explicitly.

import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { Clock, GateReport, GateTier } from '../types.ts';

export interface GateRunner {
  run(tier: GateTier): Promise<GateReport>;
}

export interface GateRunnerOptions {
  worktreeDir: string;
  /** Path to the ladder policy file; its raw bytes are hashed into every report. */
  configPath: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  clock: Clock;
}

export function createGateRunner(_opts: GateRunnerOptions): GateRunner {
  throw new Error('NotImplemented: createGateRunner');
}
