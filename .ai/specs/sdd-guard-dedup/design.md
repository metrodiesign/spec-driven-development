# Design: Guard Engine Dedup (one implementation per policy)

> Status: approved 2026-07-11

## Architecture Overview

Two new engine files under `.ai/bin/`, three callers rewired, tamper rules
extended to defend the new files, zero verdict change per mode:

- **`.ai/bin/lib-guard.sh`** — sourced fragment: `GO` regex,
  `is_spec_tasks_path()`, checkbox patterns (`CB_ANY`, `CB_DONE`, `CB_TODO`).
  Pure definitions, POSIX bash, no side effects.
- **`.ai/bin/check-evidence.sh`** — single Evidence-policy engine. Emits
  failing task lines on stdout; exit 0 pass / 1 fail / 2 usage-or-engine
  error. It never prints user-facing messages — callers keep their existing
  strings verbatim (REQ-4.4 by construction).
- **`check-bypass.sh` tamper extension (REQ-2.4, ARC-F1)**: the `GUARD`
  filename alternation gains `lib-guard\.sh` explicitly (check-evidence.sh
  already matches the existing `check-[^[:space:]]*\.sh` alternative); the
  redirect rule's filename set gains both. The dedup must not mint a keystone
  the tamper rules don't defend.

Callers after the rewire (ARC-F8: task-gate.sh deliberately NOT a consumer):

| Caller | lib-guard.sh | Evidence delegation | Keeps |
|---|---|---|---|
| `.ai/bin/gate-task.sh` | sources via `$(dirname "$0")` | `check-evidence.sh --strict` | code-green stage + its Thai stderr message |
| `.githooks/pre-commit` | sources via `git rev-parse --show-toplevel` (it already requires git) | `check-evidence.sh --added-only <file>` | secret-scan call + its English stderr message + early-continue on empty added set |
| `check-destructive.sh` / `check-bypass.sh` | sources via `$(dirname "$0")` (ARC-F3 — no git dependency added) | — | every block rule + message |
| `.claude/hooks/task-gate.sh` | NOT a consumer — 4-line case + flip grep stay inline with a pointer comment to the fragment | — | everything |

## Sequence Diagrams

```mermaid
sequenceDiagram
    participant A as task-gate.sh (standalone adapter)
    participant G as gate-task.sh
    participant E as check-evidence.sh
    participant P as pre-commit (Tier 1)

    A->>G: GATE_FILE + GATE_NEW
    G->>G: source $(dirname $0)/lib-guard.sh (missing → exit 2, message names file)
    G->>G: code-green stage (unchanged)
    G->>E: --strict  (stdin = GATE_NEW)
    alt exit 1
        G->>G: print EXISTING Thai message + head -5 of engine stdout, exit 2
    else exit 2 / 126 / 127
        G->>G: print fail-closed message naming the engine path, exit 2
    else exit 0
        G->>G: exit 0
    end

    P->>P: added set empty → continue (engine not invoked — ARC-F7)
    P->>E: --added-only added.txt (stdin = staged content)
    Note over P,E: called as `if out=$(...); then ... else rc=$?; ...` — set -e safe, rc keeps the real code (ARC-F9)
    P->>P: exit 1 → EXISTING message; exit 2/126 → fail-closed message; block either way
```

## Data Models & Interfaces

`check-evidence.sh` — one awk core (lifted from gate-task.sh's per-task awk,
the implementation hardened by PR #24), two modes preserving each call site's
CURRENT strictness (REQ-1.3 as amended — parity is per-mode, ARC-F6):

```
usage: check-evidence.sh --strict            < content
       check-evidence.sh --added-only FILE   < content

--strict      every [x] task region in stdin needs a NON-TRIVIAL Evidence
              (inline value or block bullet) — today's gate-task.sh semantics
              verbatim, incl. the nontrivial() placeholder list and the
              empty-header bullet-collection rule.
--added-only  FILE lists the newly-added `- [x]` lines (exact text, one per
              line). Only regions whose opening line ∈ FILE are checked, and
              the check is PRESENCE-ONLY — today's pre-commit semantics.
              FILE empty → exit 0 (no newly-added tasks; ARC-F7).
              FILE missing/unreadable → exit 2 (caller bug; fail closed).

stdout: opening line of each failing task
exit:   0 pass · 1 evidence-fail · 2 usage/engine error
```

Boundary dialect (ARC-F2): the awk core's `[[:space:]]` checkbox boundaries
apply in both modes — on tab-form checkbox lines this is STRICTER than
pre-commit's old literal-space loop. Documented hardening (requirements edge
case): no artifact in this repo is tab-form; maintaining two boundary
dialects to preserve a bug-shaped lenience would defeat the dedup.

Caller call pattern (ARC-F9/F10 — identical shape in both callers):

```sh
ENGINE="$BIN/check-evidence.sh"
[ -x "$ENGINE" ] || { echo "<caller's fail-closed message: engine missing at $ENGINE>" >&2; exit "$BLOCK_CODE"; }
if EV_FAIL=$("$ENGINE" --strict <<<"$NEW"); then
  : # pass
else
  rc=$?
  case $rc in
    1) # policy fail → caller's EXISTING user-facing message + $EV_FAIL excerpt
       ;;
    *) # 2/126/127 → caller's fail-closed message naming $ENGINE
       ;;
  esac
  exit "$BLOCK_CODE"
fi
```

(Deliberately NOT `if ! EV_FAIL=$(...); then`: `!` negates the pipeline's exit
status before the `if` test runs, so `$?` inside that form's `then` block is
always 0, not the engine's real 1/2/126/127 — confirmed empirically, not just
reasoned. The unnegated form above is equally `set -euo pipefail`-safe: being
the condition of `if` — negated or not — is what exempts a command from
`errexit`, so `rc=$?` in the `else` branch correctly preserves the engine's
code.)

`lib-guard.sh` fragment content: as specified in requirements — `GO`,
`is_spec_tasks_path()`, `CB_*` — plus a header comment naming the python
consumers (`cost_lib.py`, `spec_trace.py`) that intentionally keep their own
dialects (REQ-3.2, ARC-F12: this spec unifies the three BASH surfaces;
the two python variants get pointer comments, not unification).

`check-bypass.sh` pattern edits (REQ-2.4):

- `GUARD` alternation: `gate-task\.sh` → `(gate-task|lib-guard|check-evidence)\.sh`
  (check-evidence also matches `check-*`; naming it explicitly costs nothing
  and survives a future rename of the check-prefix rule).
- Redirect-rule filename set: same addition.

## Technology Decisions

- **Engine emits data, callers emit messages**: message byte-identity by
  construction; REQ-4.4's new message-snapshot tests lock the caller strings
  so future edits show up in CI (ARC-F4 — no such tests existed before).
- **awk core from gate-task.sh**: the PR #24-hardened implementation; the
  pre-commit loop is re-expressed as the `--added-only` restriction. One
  consolidation direction, no semantic merge of strictness levels.
- **`$(dirname "$0")` resolution for .ai/bin siblings** (ARC-F3): keeps
  check-destructive/check-bypass git-free at load time — a guard that blocks
  every Bash command when git is absent would be a worse regression than the
  duplication it fixes. pre-commit alone keeps `git rev-parse` (it cannot run
  outside a repo by definition).
- **task-gate.sh left standalone** (ARC-F8): four duplicated lines do not buy
  a new sourced-dependency failure mode in a PreToolUse hot path.
- **Baseline-first test discipline** (REQ-4.5, ARC-F5): the pre-commit
  fixture suite is written and passing against the CURRENT implementation
  BEFORE the refactor commit — red/green over the refactor itself.

## Error Handling Strategy

| Failure | Behavior | REQ |
|---|---|---|
| lib-guard.sh missing/unreadable | consumer blocks; message names the file | 2.3 |
| check-evidence.sh missing/non-executable (126/127) | caller blocks with fail-closed message naming the path | 1.4 |
| `--added-only` FILE missing | exit 2 → caller blocks | 1.4 |
| `--added-only` FILE empty | exit 0 (and pre-commit's early-continue means the engine is rarely even called) | 1.4, ARC-F7 |
| engine exit 1 vs 2 conflated | impossible by the case-on-$? call pattern | 4.4, ARC-F9 |
| tamper attempt on new engine files | blocked by extended GUARD/redirect rules | 2.4 |

## Testing Strategy

Order matters (REQ-4.5): **step 1 lands the baseline suite against current
code; step 2 lands the refactor; both must be green with the SAME fixtures.**

New `.claude/hooks/tests/check-evidence.test.sh` + additions:

| Case | Asserts | REQ |
|---|---|---|
| baseline: pre-commit fixtures (flip+evidence / flip w/o / mixed / no-new-flip commit) against CURRENT pre-commit | recorded verdicts | 4.5 |
| same fixtures after refactor via both entry points | verdicts unchanged per mode | 1.3, 4.1 |
| `--strict` vs `--added-only` on `Evidence: TODO` + pre-existing bare [x] | strict blocks, added-only passes (levels preserved, not merged) | 1.1, 1.3 |
| `--added-only` with empty FILE | exit 0 | 1.4 |
| `--added-only` with missing FILE | exit 2, caller blocks | 1.4 |
| engine chmod -x | both callers block, message names path | 1.4 |
| lib-guard.sh moved away | destructive/bypass/gate consumers all block | 2.3 |
| tamper: `chmod -x .ai/bin/lib-guard.sh`, `mv .ai/bin/check-evidence.sh /tmp`, `echo x > .ai/bin/lib-guard.sh` via check-bypass stdin | all BLOCKED | 2.4 |
| message snapshot: capture gate-task Thai string + pre-commit English string | byte-equal to pre-refactor fixtures | 4.4 |
| grep Thai "แก้ต้องแก้คู่" (check-destructive) + "ก็อปตรงจาก check-destructive.sh" (check-bypass) | absent after refactor | 2.2, ARC-F11 |
| existing suites (gate-task, destructive, bypass, secrets, spec-edit) | pass UNMODIFIED | 4.1 |

PR description carries the call-site inventory (REQ-4.3):
`grep -rln 'lib-guard.sh\|check-evidence.sh' .ai/bin .githooks .claude/hooks`.

## Requirement Traceability

| Design element | REQ | Section |
|---|---|---|
| check-evidence.sh single awk core, two modes | REQ-1.1 | Data Models & Interfaces |
| gate-task.sh + pre-commit delegation | REQ-1.2 | Data Models & Interfaces |
| per-mode parity fixtures (baseline → refactor) | REQ-1.3 | Data Models & Interfaces |
| -x guard + exit-code case pattern + empty/missing FILE split | REQ-1.4 | Data Models & Interfaces |
| GO in lib-guard.sh consumed by both git guards | REQ-2.1 | Data Models & Interfaces |
| Thai "edit both" comments removed (tested by Thai-string grep) | REQ-2.2 | Data Models & Interfaces |
| fail-closed sourcing (dirname for siblings; rev-parse only in pre-commit) | REQ-2.3 | Data Models & Interfaces |
| GUARD + redirect pattern extension | REQ-2.4 | Data Models & Interfaces |
| matcher/CB reuse in gate-task + pre-commit; task-gate pointer comment | REQ-3.1 | Data Models & Interfaces |
| python pointer comments (no unification) | REQ-3.2 | Data Models & Interfaces |
| existing suites unmodified | REQ-4.1 | Testing Strategy |
| additive new cases only | REQ-4.2 | Testing Strategy |
| call-site inventory in PR body | REQ-4.3 | Testing Strategy |
| engine-data/caller-message split + message-snapshot tests | REQ-4.4 | Testing Strategy |
| baseline-first pre-commit fixtures | REQ-4.5 | Testing Strategy |
