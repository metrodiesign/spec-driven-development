// Egress default-deny + filesystem containment for RUN_COMMAND (INV-14, REQ-2;
// REQ-1.2/1.3 enforced at the command layer too). Deterministic mechanism only:
// on darwin the command runs under a profile that child processes INHERIT —
// network denied, file writes allowed ONLY inside the task worktree (plus
// /dev/null), and test/golden denied even there. Escape writes would be
// invisible to worktreeHash/rollback/golden-manifest, so they are made
// impossible at run time, not merely detected later. On hosts with no
// enforcing implementation the executor must FAIL CLOSED and refuse to run
// (REQ-2.3) — never run unsandboxed.
// Ceiling (documented): reads outside the worktree remain possible (exfil is
// covered by the network deny — mitigated, not solved). Temp-dir writes are
// denied — extend the allowlist per-policy when a real toolchain needs TMPDIR;
// never blanket-allow /tmp.

import { realpathSync } from 'node:fs';
import { join } from 'node:path';

export type SandboxWrap =
  | {
      kind: 'available';
      /**
       * `allowNetwork` (default false) drops the egress deny for a single governed
       * command — used ONLY by a policy-approved package install (REQ-11.2). The
       * registry pin is enforced at the LOCKFILE (`--frozen-lockfile` +
       * `--ignore-scripts` resolves every package from URLs already committed and
       * blocks install-time code), NOT at this socket grant: the SBPL grant is
       * transport only. Residual = a maliciously COMMITTED lockfile — contained by
       * the ≥L2 risk floor on any lockfile/manifest diff (never auto-merged);
       * mitigated, not solved (§16, REQ-11.4).
       */
      wrap(shellCmd: string, worktreeDir: string, allowNetwork?: boolean): { cmd: string; args: string[] };
    }
  | { kind: 'unavailable'; reason: string };

/** SBPL: later rules win, so the golden deny is last to trump the worktree allow. */
function profileFor(worktreeDir: string, allowNetwork: boolean): string {
  const root = realpathSync(worktreeDir);
  if (root.includes('"')) {
    throw new Error(`worktree path not representable in a sandbox profile: ${root}`);
  }
  return [
    '(version 1)',
    '(allow default)',
    // Egress default-deny (INV-14). A governed package_install lifts ONLY this line
    // for its single command; file-write containment below is never relaxed.
    ...(allowNetwork ? [] : ['(deny network*)']),
    '(deny file-write*)',
    `(allow file-write* (subpath "${root}") (literal "/dev/null"))`,
    `(deny file-write* (subpath "${join(root, 'test', 'golden')}"))`,
  ].join(' ');
}

export function denyNetworkSandbox(platform: NodeJS.Platform): SandboxWrap {
  if (platform !== 'darwin') {
    return {
      kind: 'unavailable',
      reason: `no enforcing deny-network sandbox implemented for ${platform} (fail-closed; see docs/DEVIATIONS.md D-003)`,
    };
  }
  return {
    kind: 'available',
    wrap: (shellCmd: string, worktreeDir: string, allowNetwork = false) => ({
      cmd: '/usr/bin/sandbox-exec',
      args: ['-p', profileFor(worktreeDir, allowNetwork), '/bin/sh', '-c', shellCmd],
    }),
  };
}
