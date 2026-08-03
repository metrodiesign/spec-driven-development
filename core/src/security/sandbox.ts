// Egress default-deny + filesystem containment for RUN_COMMAND (INV-14, REQ-2;
// REQ-1.2/1.3 enforced at the command layer too). Deterministic mechanism only:
// on darwin the command runs under a profile that child processes INHERIT —
// network is always denied, file writes are allowed only inside core-derived
// disposable roots (plus /dev/null), and test/golden is denied even there.
// There is deliberately no network-grant field at this boundary: Phase 0 can
// authorize only pre-provisioned offline dependency inputs under network:none.
// On hosts with no enforcing implementation the executor must FAIL CLOSED and
// refuse to run (REQ-2.3) — never run unsandboxed.
// Ceiling (documented): reads outside the worktree remain possible (exfil is
// covered by the network deny — mitigated, not solved). Temp-dir writes are
// denied — extend the allowlist per-policy when a real toolchain needs TMPDIR;
// never blanket-allow /tmp.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface SandboxCommand {
  shellCmd: string;
  workspaceRoot: string;
  writableRoots: readonly string[];
  /** Core-created, per-command scratch roots outside the artifact workspace. */
  transientWritableRoots?: readonly string[];
  protectedRoots: readonly string[];
  /**
   * Present ONLY for a policy-approved offline package install (exact frozen
   * lockfile, content-hashed sources, lifecycle scripts disabled). Demotes the
   * listed approved-source roots from kill-on-write to plain denial: the
   * installer probes writes there and handles EPERM, but dies mid-install on
   * SIGKILL. The roots stay write-DENIED either way, and nothing about network
   * policy changes — no transport, unix-domain socket, or egress is granted.
   */
  offlineInstall?: { gracefulDenyRoots: readonly string[] };
}

export interface SandboxViolationObservation {
  source: 'enforcement_owned_direct' | 'backend_owned';
  /**
   * `unknown` = an enforcement-owned direct-child kill whose denied operation
   * class (filesystem vs network) the profile cannot disambiguate — both deny
   * rules terminate with the same uncatchable signal.
   */
  operation: 'filesystem' | 'network' | 'unknown';
}

export type SandboxWrap =
  | {
      kind: 'available';
      /** Content hash of the backend-owned network policy bytes. */
      networkPolicyHash?: string;
      /**
       * Wrap one core-derived command. This API cannot grant network access.
       */
      wrap(command: SandboxCommand): { cmd: string; args: string[] };
      /**
       * Enforcement-owned attribution channel for the direct command result
       * (REQ-2.5). The kernel-reported wait status is parent-owned state, not
       * child-controlled OUTPUT, so REQ-2.22 permits it: when the enforcing
       * profile's only kill source is its deny rules, a direct-child SIGKILL is
       * attributed as a denial. A child that self-delivers SIGKILL merely forges
       * its own conservative rejection (documented fail-closed residual).
       * Child-controlled stdout/stderr is never interpreted as a violation.
       */
      observeDirectResult?(
        result: Readonly<{ exitCode: number; signal: NodeJS.Signals | null }>,
      ): SandboxViolationObservation | null;
    }
  | { kind: 'unavailable'; reason: string };

function containedRoot(workspaceRoot: string, relPath: string): string {
  const root = realpathSync(workspaceRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`sandbox root escapes workspace: ${relPath}`);
  }
  return target;
}

function encodeSbplString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`sandbox path contains a control character and is not representable: ${value}`);
  }
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

const PHASE0_NETWORK_POLICY = '(deny network* (with send-signal SIGKILL))';

/** SBPL: later rules win, so protected denies trump every writable root. */
function profileFor(command: SandboxCommand): string {
  const writableRoots = command.writableRoots.map((root) =>
    containedRoot(command.workspaceRoot, root),
  );
  const transientWritableRoots = (command.transientWritableRoots ?? []).map((root) =>
    realpathSync(root),
  );
  const protectedRoots = command.protectedRoots.map((root) =>
    containedRoot(command.workspaceRoot, root),
  );
  const gracefulDenyRoots = (command.offlineInstall?.gracefulDenyRoots ?? []).map((root) => {
    const resolved = containedRoot(command.workspaceRoot, root);
    // Emitted last, so a graceful root that contained a protected root would
    // silently downgrade that root's kill-on-write. Refuse instead.
    for (const guarded of protectedRoots) {
      if (guarded === resolved || guarded.startsWith(`${resolved}${sep}`)) {
        throw new Error(`offline-install graceful root would weaken a protected root: ${root}`);
      }
    }
    return resolved;
  });
  return [
    '(version 1)',
    '(allow default)',
    // Phase 0 has no transport grant. The SIGKILL deny is both effect
    // enforcement and, via the parent-owned wait status of the DIRECT child,
    // an enforcement-owned denial observation (REQ-2.5; see observeDirectResult).
    PHASE0_NETWORK_POLICY,
    '(deny file-write* (with send-signal SIGKILL))',
    // Node connects stdout/stderr through character-device-backed descriptors
    // on macOS. Permit data on those inherited evidence channels only; regular
    // files remain covered by the SIGKILL denial (including existing files).
    '(allow file-write-data (vnode-type CHARACTER-DEVICE))',
    '(allow file-write* (literal "/dev/null"))',
    ...writableRoots.map((root) => `(allow file-write* (subpath "${encodeSbplString(root)}"))`),
    ...transientWritableRoots.map(
      (root) => `(allow file-write* (subpath "${encodeSbplString(root)}"))`,
    ),
    ...protectedRoots.map(
      (root) =>
        `(deny file-write* (subpath "${encodeSbplString(root)}") (with send-signal SIGKILL))`,
    ),
    // Approved-source roots during an offline install: still write-DENIED, but
    // without the kill so the installer's handled EPERM staging probes survive.
    ...gracefulDenyRoots.map(
      (root) => `(deny file-write* (subpath "${encodeSbplString(root)}"))`,
    ),
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
    networkPolicyHash: createHash('sha256').update(PHASE0_NETWORK_POLICY).digest('hex'),
    wrap: (command) => ({
      cmd: '/usr/bin/sandbox-exec',
      args: ['-p', profileFor(command), '/bin/sh', '-c', command.shellCmd],
    }),
    // Core-initiated kills (timeout, cancellation, output limit) are classified
    // by the runner BEFORE this channel is consulted, so what reaches here is a
    // SIGKILL core did not send: this profile's deny rules, a self-kill, or an
    // external/OOM kill. All three are rejected conservatively — the last two
    // are fail-closed false positives, never a false success. The denied
    // operation class is not recoverable from a wait status, hence 'unknown',
    // and only the DIRECT child is observed (REQ-2.23/2.37 `direct_only`): a
    // descendant's denial that its parent swallows stays `observedViolation:
    // null` (REQ-2.40).
    observeDirectResult: ({ signal }) =>
      signal === 'SIGKILL'
        ? { source: 'enforcement_owned_direct', operation: 'unknown' }
        : null,
  };
}
