// Approval package generator (spec §10.3, REQ-9). Over the diff budget => NO
// package, task escalated `split_required`. Attestations are generated from the
// task's risk class (Phase 1: from the goal contract's approval_policy, default
// L2). STUB in task 6 (RED) — implemented same task.

export type RiskClass = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

export interface ApprovalPackage {
  id: string;
  taskId: string;
  runId: string;
  goalExcerpt: string;
  acIds: string[];
  diffRef: string;
  evidence: { gateReports: string[]; worktreeHash: string };
  assumptions: string[];
  unresolvedRisks: string[];
  attestations: string[];
  riskClass: RiskClass;
  createdAt: number;
  /** Read-only provenance passthrough from the frozen contract (phase5-stage3 REQ-6). Absent -> not rendered. */
  provenance?: { specPath: string; requirementsCommit: string; requirementsSha256?: string; generatedAt: string };
}

export interface ApprovalInput {
  id: string;
  taskId: string;
  runId: string;
  goalExcerpt: string;
  acIds: string[];
  diffRef: string;
  diffLineCount: number;
  maxDiffBudget: number;
  gateReports: string[];
  worktreeHash: string;
  assumptions: string[];
  unresolvedRisks: string[];
  riskClass: RiskClass;
  createdAt: number;
  /** Read-only provenance passthrough from the frozen contract (phase5-stage3 REQ-6). Absent -> not rendered. */
  provenance?: { specPath: string; requirementsCommit: string; requirementsSha256?: string; generatedAt: string };
}

export type ApprovalResult =
  | { kind: 'package'; package: ApprovalPackage }
  | { kind: 'escalate'; reason: 'split_required'; detail: string };

const BASE_ATTESTATIONS = ['I reviewed the diff', 'Tests cover the change'];
const RISK_EXTRA: Record<RiskClass, string[]> = {
  L0: [],
  L1: [],
  L2: [],
  L3: ['I verified the security/permission impact', 'I confirmed no secret or credential change'],
  L4: [
    'I verified the security/permission impact',
    'I confirmed no secret or credential change',
    'I confirmed this is recoverable OR has an explicit rollback + backup',
  ],
};

/** Attestation checklist generated from the risk class (higher risk = more to attest). */
export function attestationsFor(risk: RiskClass): string[] {
  return [...BASE_ATTESTATIONS, ...RISK_EXTRA[risk]];
}

export function buildApprovalPackage(input: ApprovalInput): ApprovalResult {
  // Over the diff budget: the system splits the task instead of building a package
  // (§10.3 — "เกิน diff budget = ระบบสั่งแตก task ไม่สร้าง package").
  if (input.diffLineCount > input.maxDiffBudget) {
    return {
      kind: 'escalate',
      reason: 'split_required',
      detail: `diff ${input.diffLineCount} lines exceeds budget ${input.maxDiffBudget}`,
    };
  }
  return {
    kind: 'package',
    package: {
      id: input.id,
      taskId: input.taskId,
      runId: input.runId,
      goalExcerpt: input.goalExcerpt,
      acIds: input.acIds,
      diffRef: input.diffRef,
      evidence: { gateReports: input.gateReports, worktreeHash: input.worktreeHash },
      assumptions: input.assumptions,
      unresolvedRisks: input.unresolvedRisks,
      attestations: attestationsFor(input.riskClass),
      riskClass: input.riskClass,
      createdAt: input.createdAt,
      // Enumerated field-by-field above -> an interface-only change would drop this
      // silently, so the copy is explicit (A6). Conditional spread, not a plain key,
      // because exactOptionalPropertyTypes rejects an explicit `provenance: undefined`.
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    },
  };
}
