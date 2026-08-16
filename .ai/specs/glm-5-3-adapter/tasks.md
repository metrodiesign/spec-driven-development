# Implementation Tasks: GLM-5.3 OpenAI-compatible adapter

> Status: approved 2026-08-16

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Adapter module pair + unit tests — `adapters/src/openai-compatible.ts` (adapter core: manifest `glm`/`zai`/1M window, `send()` with durable replay + error passthrough/classify, pure `buildGlmRequestBody` + `parseGlmHttpBody` + `resolveGlmEndpointConfig`) and `adapters/src/openai-compatible-live.ts` (fetch-only wiring, factory-time credential resolution, `ZAI_BASE_URL` override, call-control forwarding), exported from `adapters/src/index.ts`; hermetic unit tests in `openai-compatible.test.ts` covering the full design Testing-Strategy matrix. Done = new tests green, no CI path imports the live module, existing adapter tests untouched.
     Satisfies: REQ-1 (all criteria), REQ-2 (all criteria), REQ-3 (all criteria), REQ-4 (all criteria). Verify: `pnpm -C adapters test && pnpm -C adapters typecheck && pnpm vendor-check`.
     Evidence:
       - test: `pnpm -C adapters test` -> 72 passed / 0 failed (20 new tests; pre-existing files untouched)
       - test: `pnpm -C adapters typecheck` -> clean
       - test: `pnpm vendor-check` -> OK: core/ and aal/ are vendor-name-free (INV-7)
       - test: `grep -rn "from './openai-compatible-live" adapters/src/*.test.ts` -> no matches (live module imported only by the index.ts re-export, same precedent as createLiveCodexAdapter)
       - viewports: n/a — logic-only
       - deviations: one additive field vs the design interface — GlmTransportResult carries `rawBody` so rawTranscriptRef can persist the response body (design step 8 said "putEvidence(raw body text)" but the sketched type lacked the field); no behavior change, pure addition.
- [x] 2. Conformance gate in CI — `adapters/src/openai-compatible-conformance.test.ts`: compliant fake transport passes P1–P8 via `runConformanceSuite`, prose-only saboteur fails exactly P2, regressed re-run marks the registered adapter `stale` through the registry gate.
     Satisfies: REQ-5 (all criteria). Depends on: 1. Verify: `pnpm -C adapters test`.
     Evidence:
       - test: `pnpm -C adapters test` -> 75 passed / 0 failed (+3 conformance tests: P1–P8 all pass with p7 susceptibility 0, prose-only fails exactly P2, regressed record → stale + not eligible)
       - viewports: n/a — logic-only
       - deviations: none
- [ ] 3. Conformance CLI + routing policy — `console/backend/bin/platform.ts` `runConformance()`: add `'zai'` to the lineage allowlist + `createLiveGlmAdapter` construction branch (per-run replay dir, `PR_GATE_GLM_MODEL` env passthrough); add `tokenBuckets["glm"]` (capacity 4, refillPerSec 0.5) to `.ai/policies/routing.json`. Note: REQ-6 CLI wiring is review-verified (no test harness for `platform.ts` — recorded ceiling since v1.7); REQ-7 policy is guard-tested via aal routing-config tests + governance preflight on the next live run.
     Satisfies: REQ-6 (all criteria), REQ-7 (all criteria). Depends on: 1. Verify: `pnpm -C console/backend typecheck && pnpm -C aal test && pnpm vendor-check`.
- [ ] 4. LIVE conformance run (manual, conditional) — run `platform conformance --live --lineage zai` (TTY, confirmation phrase) with `ZAI_API_KEY` in the environment; record per-probe results + the persisted `.ai/calibration/conformance-glm-<stamp>.json` path here. IF no key/quota is available, leave this task open (phase-3 LIVE pattern) and note it in the handoff — CI readiness (tasks 1–2) is this round's delivered evidence.
     Satisfies: REQ-8 (all criteria). Depends on: 2, 3. Verify: `platform conformance --live --lineage zai` (real-model P1–P8 record).

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

Coupled feature (all tasks build on task 1's module) — run all in one session.
Task 4 is operator-manual; it runs after 1–3 land.
