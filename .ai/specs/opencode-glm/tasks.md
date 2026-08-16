# Implementation Tasks: opencode-glm — GLM-5.3 through the OpenCode CLI

> Status: approved 2026-08-16 (4 tasks — spec-trace 26/26 green)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Adapter factory + credential sandbox + unit tests — in `adapters/src/reasoning-cli-live.ts`: `createLiveOpenCodeGlmAdapter` (spawn `opencode run --pure --format json --model opencode-go/glm-5.3` via the existing `runChild`/`parseOpenCode`/`buildOpenCodeReviewArgv`, id `opencode-glm`, lineage `zai`, context 1M, factory-time auth fail-fast), `resolveOpenCodeAuthStore`, `buildOpenCodeGlmEnv`, per-invocation 0600 auth-copy destroyed in `finally`; export from `adapters/src/index.ts`; unit tests in `adapters/src/opencode-glm.test.ts` covering argv shape, manifest, model override, store resolution, env assembly (no real-HOME leakage), fail-fast, copy lifecycle. Done = new tests green, existing tests untouched, no `opencode` spawn in any test.
     Satisfies: REQ-1 (all criteria), REQ-2 (all criteria), REQ-3 (all criteria). Verify: `pnpm -C adapters test && pnpm -C adapters typecheck && pnpm vendor-check`.
     Evidence:
       - test: `pnpm -C adapters test` -> 59 passed / 0 failed (9 new; pre-existing tests untouched)
       - typecheck: `pnpm -C adapters typecheck` -> clean
       - test: `pnpm vendor-check` -> OK: core/ and aal/ are vendor-name-free (INV-7)
       - viewports: n/a — logic-only
       - deviations: (1) `copyFileSync`'s third arg is a 0–7 copy mask, not a mode — the 0600 is applied by an explicit `chmodSync` after the verbatim copy (first run failed with "mode is out of range"; fixed, test proves `-rw-------` inside the sandbox). (2) macOS `ls -l` appends an xattr marker (`@`) to the mode column — the mode assertion is a prefix match. Both are implementation notes, no requirement change.
- [x] 2. Conformance gate in CI — `adapters/src/opencode-glm-conformance.test.ts`: compliant fake `ReasoningCliExec` (probe-directive aware) passes P1–P8 via `runConformanceSuite`, prose-only saboteur fails exactly P2, regressed re-run marks the registered adapter `stale` through the registry gate.
     Satisfies: REQ-4 (all criteria). Depends on: 1. Verify: `pnpm -C adapters test`.
     Evidence:
       - test: `pnpm -C adapters test` -> 62 passed / 0 failed (+3 conformance: P1–P8 all pass with p7 susceptibility 0, prose-only fails exactly P2, regressed record → stale + not eligible)
       - typecheck: `pnpm -C adapters typecheck` -> clean
       - viewports: n/a — logic-only
       - deviations: none
- [x] 3. Conformance CLI + policies — `console/backend/bin/platform.ts` `runConformance()`: add `'opencode-glm'` to the lineage allowlist + construction branch (`PR_GATE_OPENCODE_GLM_MODEL` passthrough); add `tokenBuckets["opencode-glm"]` to `.ai/policies/routing.json` and the per-adapter `opencode-glm` entry + processor note to `.ai/policies/provider-data-policy.json`. CLI wiring review-verified (no platform.ts harness — ceiling since v1.7); policy edits guard-tested via aal.
     Satisfies: REQ-5 (all criteria), REQ-6 (all criteria). Depends on: 1. Verify: `pnpm -C console/backend typecheck && pnpm -C aal test && pnpm vendor-check`.
     Evidence:
       - typecheck: `pnpm -C console/backend typecheck` -> clean (CLI branch + createLiveOpenCodeGlmAdapter import)
       - test: `pnpm -C aal test` -> 192 passed / 0 failed (routing-config + data-policy guard tests green with both policy edits)
       - test: `node -e JSON.parse(...)` on both policy files -> valid JSON
       - test: `pnpm vendor-check` -> OK (INV-7); `scripts/spec-trace.sh opencode-glm` -> 26/26 covered, EARS lint clean
       - viewports: n/a — logic-only
       - deviations: none — REQ-5 CLI wiring review-verified as the task notes (no platform.ts harness exists, ceiling recorded since v1.7); both POLICY_FILES hash changes take effect as a governance approval prompt on the next live run, by construction.
- [ ] 4. LIVE conformance run (the point of this spec) — run `node console/backend/bin/platform.ts conformance --live --lineage opencode-glm --force-quota-override` (TTY, confirmation phrase) using the machine's existing OpenCode Go credential; record per-probe results + the persisted `.ai/calibration/conformance-opencode-glm-<stamp>.json` path here. IF the gateway/quota is unavailable, record the failure shape and leave the task open with REQ-4 CI evidence as this round's deliverable.
     Satisfies: REQ-7 (all criteria). Depends on: 2, 3. Verify: live P1–P8 record against the real gateway.

## Suggested execution batches

> DEFAULT for a COUPLED feature (tasks share primitives/data/lib): run ALL tasks in
> ONE session — `scripts/pane-loop.sh <feature> all-in-one` (or `/spec-implement all`).
> Separate sessions do NOT share cache, so each one re-pays the cold cache-write to
> re-acquire shared context — measured ~30-40% more expensive for coupled work.
> Split into separate sessions/panes ONLY for accuracy: a genuinely INDEPENDENT task
> (no shared state), or to isolate a CORE domain (e.g. pricing logic) from long-context
> drift — a conscious accuracy trade, not a cost win.
> `Batch:` tags still group small same-type tasks for finer control; feed with `+`
> (`scripts/pane-loop.sh <feature> 3+4`).

Coupled feature — run tasks 1–3 in one session. Task 4 is operator-manual on a
TTY (the existing OpenCode Go credential authenticates it); it runs
immediately after 1–3 land, and this time no recharge is expected to be
needed — the credential already works on this machine.
