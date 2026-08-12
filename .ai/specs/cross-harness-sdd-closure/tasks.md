# Implementation Tasks: Cross-Harness SDD Closure

> Status: approved 2026-08-12

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass; decompose into internal steps during execution.

- [x] 1. Credential closure — remove discovered plaintext credentials from bounded persistent
     configuration, verify GitHub PAT and Gemini key rejection with status-only provider probes,
     and prove no credential-bearing file enters the repository.
     Satisfies: REQ-1 (all criteria).
     Verify: sanitized local-config rescan, provider probes with invalid-key controls, and
     `.ai/bin/check-secrets.sh --all` all pass.
     Evidence:
       - test: bounded literal-assignment scans of `~/.zshrc` and `~/.config/opencode/opencode.jsonc` -> 0 and 0; known secret-shape scans -> 0 and 0
       - test: `.ai/bin/check-secrets.sh --all` plus temporary-index working-tree secret scan -> exit 0
       - test: status-only provider probes -> GitHub revoked/control 401/401; Gemini replacement/control 200/400
       - test: operator confirmation 2026-08-12 -> exposed Gemini key deleted and replacement key created; no value, suffix or fingerprint retained
       - viewports: n/a — credential lifecycle and local policy checks
       - deviations: original Gemini value was unavailable after deletion, so operator-confirmed deletion replaces a direct rejection probe; active replacement `200` is expected per amended design

- [x] 2. Protected integration branches — reconcile GitHub ruleset
     `protected-main-develop` to desired state for `main` and `develop`, then read back branch,
     pull-request, squash-only, linear-history and exact required-check fields without storing auth.
     Satisfies: REQ-2 (all criteria).
     Verify: authenticated read-only GitHub API response matches design contract for ruleset and both
     protected branches.
     Evidence:
       - test: `env -u GITHUB_TOKEN -u GH_TOKEN gh api repos/metrodiesign/spec-driven-development/rulesets/20737973 --jq '{id,name,enforcement,branches:.conditions.ref_name.include,rule_types:[.rules[].type],pull_request:[.rules[]|select(.type=="pull_request")|.parameters],required_checks:[.rules[]|select(.type=="required_status_checks")|.parameters]}'` -> active ruleset 20737973 covers main/develop; squash-only, zero approvals, review resolution, linear history and both exact strict checks observed
       - test: `for branch in main develop; do printf '%s ' "$branch"; env -u GITHUB_TOKEN -u GH_TOKEN gh api "repos/metrodiesign/spec-driven-development/rules/branches/$branch" --jq '[.[].type]'; done` -> both branches report deletion, non-fast-forward, linear-history, pull-request and required-status-check rules
       - viewports: n/a — remote repository control
       - deviations: none; desired state already matched, so idempotent reconcile performed no mutation

- [x] 3. Pi pre-execution enforcement and capability fallback — add project-local Pi extension that
     delegates Bash guards and reconstructed task edits to shared engines, freezes vetted events,
     fails closed, and update matrix/adapter instructions for unsupported subagent and MCP routing.
     Satisfies: REQ-4 (all criteria), REQ-6.2, REQ-6.5.
     Verify: exact committed extension passes block/allow, edit reconstruction, path escape,
     later-handler mutation and capability-exception cases in cross-harness conformance.
     Evidence:
       - test: `bash .claude/hooks/tests/cross-harness-conformance.test.sh` -> `shell-adapters pass=11 fail=0`, `node-conformance pass=24 fail=0`; exact committed `.ts` import covers Bash allow/block/fail-closed, pre-write task gate, same-original edit reconstruction, new-completion detection, path/symlink escape, event freeze and unsupported-capability routing
       - test: `bash .claude/hooks/tests/destructive-guard.test.sh && bash .claude/hooks/tests/hook-bypass-guard.test.sh && bash .claude/hooks/tests/gate-task.test.sh` -> destructive `pass=172 fail=0 skip=12`, bypass `pass=122 fail=0`, task gate `pass=42 fail=0`
       - viewports: n/a — project extension and Markdown capability contract
       - deviations: Pi has no fresh-context subagents or MCP/browser host; adapter requires stop-and-route. Dynamic or obfuscated Bash task paths remain backed by Tier 1 git + CI.

- [x] 4. Diff-aware CI Evidence gate — add line-selected strict mode to canonical Evidence parser,
     implement PR merge-base and push-before scope script, wire one thin CI step, and cover duplicate,
     moved, placeholder, unrelated-edit and unresolved-range cases.
     Satisfies: REQ-5 (all criteria).
     Verify: `check-evidence.test.sh` and `ci-evidence-scope.test.sh` pass with production event shapes.
     Evidence:
       - test: `bash .claude/hooks/tests/check-evidence.test.sh` -> `pass=31 fail=0`; line-selected strict mode covers physical-line identity, inline/multiline Evidence, placeholders and invalid selections while preserving existing modes
       - test: `bash .claude/hooks/tests/ci-evidence-scope.test.sh` -> `pass=11 fail=0`; PR merge-base and push-before ranges cover duplicate/moved tasks, unrelated edits, diagnostics, unsafe path names and fail-closed base errors
       - test: `bash .claude/hooks/tests/gate-task.test.sh` -> `pass=42 fail=0`
       - viewports: n/a — shell policy engine and CI workflow
       - deviations: none

- [x] 5. Adapter and MCP drift cleanup — replace stale stack-profile paths in Codex, OpenCode and Pi
     adapters, align optional guidance with Claude, pin both executable chrome-devtools MCP configs to
     the same exact maintained version, and remove version duplication from prose.
     Satisfies: REQ-6.1, REQ-6.2, REQ-6.3, REQ-6.4.
     Verify: repository search finds no `stack/nextjs.md` or MCP floating tag; extracted Codex and
     OpenCode pins are exact and equal.
     Evidence:
       - test: `bash .claude/hooks/tests/cross-harness-conformance.test.sh` -> `shell-adapters pass=11 fail=0`, `node-conformance pass=24 fail=0`; fixture extracts equal exact `1.7.0` pins and checks all four adapter stack contracts
       - test: `python3 -c 'import pathlib,tomllib; tomllib.loads(pathlib.Path(".codex/config.toml").read_text())'` plus JSON parse of `opencode.json` -> both executable configs parse; OpenCode reports `chrome-devtools-mcp@1.7.0`
       - test: `rg 'chrome-devtools-mcp@(latest|[xX*^~])|stack/nextjs\.md' .codex opencode.json .ai/agents .ai/README.md` -> no runtime/config/adapter matches
       - viewports: n/a — adapter documentation and executable config
       - deviations: none

- [x] 6. Cross-harness conformance and closure audit — add deterministic credential-free fixture for
     Claude, Codex, OpenCode and Pi behavioral wiring plus optional version/discovery live probe; run
     full guard, spec-trace, typecheck, lint and tests, then re-read remote ruleset and credential state.
     Satisfies: REQ-3 (all criteria), REQ-4.7, REQ-6.4, REQ-6.5. Depends on: 1, 2, 3, 4, 5.
     Verify: default conformance and full CI-equivalent gate pass; live probe reports all four installed
     harnesses without model calls; completion audit proves every REQ with current-state evidence.
     Evidence:
       - test: `bash .claude/hooks/tests/cross-harness-conformance.test.sh` -> shell adapters 11/11 and Node conformance 24/24 passed
       - test: `bash .claude/hooks/tests/cross-harness-conformance.test.sh --live` -> Claude 2.1.228, Codex 0.147.0, OpenCode 1.18.15 and Pi 0.74.0 discovered; exact Pi extension loaded with `tool_call`
       - test: `pnpm typecheck && pnpm lint && pnpm test` -> typecheck/lint passed; workspace tests 1,367 passed, 10 skipped, 0 failed
       - test: every `.claude/hooks/tests/*.test.sh` plus `scripts/spec-trace.sh cross-harness-sdd-closure` -> guard regressions passed; 37/37 criteria covered and EARS lint passed
       - test: vendor/golden checks, configured high-severity dependency audit, working-tree secret scan and `git diff --check` -> passed; audit reported 1 low and 4 moderate
       - test: authenticated ruleset readback -> active ID 20737973 still covers `main`/`develop` with squash-only PRs and both exact strict checks
       - viewports: n/a — harness adapters, policy engines and CI workflow
       - deviations: Pi fresh-context subagents and MCP/browser remain explicit routed exceptions; existing low/moderate audit findings stay below configured high-severity failure threshold

## Suggested execution batches

Tasks 3–6 share adapter contracts and guard fixtures. Run all tasks in one session:
`/spec-implement all`. Tasks 1 and 2 are external-state checks but remain in same closure audit so task 6
cannot pass on stale provider or GitHub state.
