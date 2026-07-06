# DEVIATIONS

Deviations from `unified-platform-spec.md`, per its §0.2/§0.6. Each entry: what, why, scope,
how to reverse.

## D-001 — `node:sqlite` (release-candidate builtin) as event-log storage

- **What:** Ring 0 event log uses Node's builtin `node:sqlite` (`DatabaseSync`), which is
  Stability 1.2 (release candidate) and still emits an ExperimentalWarning (suppressed
  deliberately).
- **Why:** zero install/native-build burden, atomic CAS via SQLite transactions as §6.2 requires;
  the alternative (`better-sqlite3`) adds a native-build dependency for the same API surface.
- **Risk accepted:** RC API may shift between Node minors. Mitigation: Node minor pinned via
  `engines`/`.nvmrc`; storage accessed through one thin interface so `better-sqlite3` can swap in
  without touching callers.
- **Reverse:** replace the storage module's import; interface unchanged.

## D-002 — Gate policy file is JSON in Phase 0 (`gate-ladder.json`, spec names `gate-ladder.yaml`)

- **What:** `.ai/policies/gate-ladder.json` instead of the YAML file named inside the §11.1 goal
  contract template.
- **Why:** keeps `core/` truly zero-dependency (`JSON.parse` builtin); the YAML reference lives in
  the Phase-1 goal-contract template, and a reviewed `yaml` dependency is justified once, in
  Phase 1, together with `goal.yaml`.
- **Scope:** Phase 0 only. The file's raw bytes are hashed into every GateReport either way
  (INV-10 unaffected).
- **Reverse:** Phase 1 adds the `yaml` dep and migrates the file; hash-into-evidence logic is
  format-agnostic.

## D-003 — Fault-injection CI job pinned to a macOS runner

- **What:** the `core` fault-injection suite (Phase 0 DoD) runs on a macOS runner in CI, not the
  default Linux runner.
- **Why:** DoD#3 (egress default-deny) asserts real blocked-at-connect behavior, and the Phase 0
  egress mechanism is darwin `sandbox-exec` (children inherit the sandbox). On Linux the executor
  fail-closes with `sandbox_unavailable` — a different (weaker) assertion.
- **Future work:** Linux egress impl via `unshare -n`, after which the suite runs on both.
- **Reverse:** add the Linux impl; unpin the runner.
