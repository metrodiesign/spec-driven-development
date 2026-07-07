// Provider data policy (REQ-11.5/11.8, spec §10). Before a bundle is sent to an
// adapter, every context piece is checked against the routed provider's allowed
// path globs; a pathless piece is permitted only when its kind is one of the
// platform-generated kinds the policy enumerates (feedback, contract, guidance,
// patchPlan). A violation escalates `data_policy_violation` and NOTHING is sent.
// This is the pure Ring-0 decision; Ring 1 (aal/source) wires it before send.

import type { ContextPiece } from '../types.ts';

export interface ProviderDataPolicy {
  /** Glob allow-list for `ContextPiece.path` (`*` matches within a segment, `**` across `/`). */
  allowPaths: string[];
  /** Platform-generated kinds that may travel WITHOUT a path (REQ-11.8). */
  pathlessKinds: string[];
}

export type DataPolicyViolation =
  | { pieceId: string; reason: 'path_out_of_policy'; path: string }
  | { pieceId: string; reason: 'pathless_kind_not_allowed'; kind: string };

export type DataPolicyResult = { ok: true } | { ok: false; violation: DataPolicyViolation };

/** Glob -> anchored RegExp. `**` matches across `/`; `*` matches within a segment. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function pathAllowed(path: string, allowPaths: string[]): boolean {
  return allowPaths.some((g) => globToRegExp(g).test(path));
}

/**
 * All-or-nothing: the first violating piece wins (the send is refused, so there is
 * no partial-bundle leak). A pathed piece must match an allow glob; a pathless
 * piece must be an enumerated platform kind.
 */
export function checkDataPolicy(
  pieces: ContextPiece[],
  policy: ProviderDataPolicy,
): DataPolicyResult {
  for (const p of pieces) {
    if (p.path === undefined) {
      if (!policy.pathlessKinds.includes(p.kind)) {
        return {
          ok: false,
          violation: { pieceId: p.id, reason: 'pathless_kind_not_allowed', kind: p.kind },
        };
      }
    } else if (!pathAllowed(p.path, policy.allowPaths)) {
      return {
        ok: false,
        violation: { pieceId: p.id, reason: 'path_out_of_policy', path: p.path },
      };
    }
  }
  return { ok: true };
}
