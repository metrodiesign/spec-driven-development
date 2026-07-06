// Egress default-deny for RUN_COMMAND (INV-14, REQ-2). Deterministic mechanism
// only: on darwin the command runs under a deny-network profile that child
// processes INHERIT; on hosts with no enforcing implementation the executor must
// FAIL CLOSED and refuse to run (REQ-2.3) — never run unsandboxed.
// Ceiling (documented): the profile denies network*, not filesystem writes —
// fs integrity is the golden manifest's and recovery's job, not the sandbox's.

export type SandboxWrap =
  | { kind: 'available'; wrap(shellCmd: string): { cmd: string; args: string[] } }
  | { kind: 'unavailable'; reason: string };

const DENY_NETWORK_PROFILE = '(version 1) (allow default) (deny network*)';

export function denyNetworkSandbox(platform: NodeJS.Platform): SandboxWrap {
  if (platform !== 'darwin') {
    return {
      kind: 'unavailable',
      reason: `no enforcing deny-network sandbox implemented for ${platform} (fail-closed; see docs/DEVIATIONS.md D-003)`,
    };
  }
  return {
    kind: 'available',
    wrap: (shellCmd: string) => ({
      cmd: '/usr/bin/sandbox-exec',
      args: ['-p', DENY_NETWORK_PROFILE, '/bin/sh', '-c', shellCmd],
    }),
  };
}
