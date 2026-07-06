// Egress default-deny for RUN_COMMAND (INV-14, REQ-2). Deterministic mechanism
// only: on darwin the command is wrapped in a deny-network profile that child
// processes inherit; on hosts with no enforcing implementation the executor must
// FAIL CLOSED and refuse to run (REQ-2.3) — never run unsandboxed.

export type SandboxWrap =
  | { kind: 'available'; wrap(shellCmd: string): { cmd: string; args: string[] } }
  | { kind: 'unavailable'; reason: string };

export function denyNetworkSandbox(_platform: NodeJS.Platform): SandboxWrap {
  throw new Error('NotImplemented: denyNetworkSandbox');
}
