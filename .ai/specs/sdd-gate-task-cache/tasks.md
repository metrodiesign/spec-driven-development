# Implementation Tasks: SDD Gate-Task Cache (tree-hash skip)

> Status: approved 2026-07-11

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [ ] 1. Cache stage in gate-task.sh end-to-end — compute_key (temp-index
     write-tree minus spec dirs + config/toolchain salt), validated cache
     read, SKIP_SUITE flag flow, atomic dedup append, all disable guards
     (SDD_GATE_NO_CACHE / .gitmodules / empty KEY / post-write contract in
     header), audit log line; Evidence stage untouched and unconditional.
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-3 (all), REQ-4 (all).
     Verify: bash .claude/hooks/tests/gate-task.test.sh (existing cases stay
     green) + manual warm-cache flip shows the hit line.
- [ ] 2. Adversarial cache test matrix — extend gate-task.test.sh with the
     isolated git-init fixture (GIT_CEILING_DIRECTORIES) and every case in
     design §Testing Strategy (green-writes / red-writes-nothing / hit on
     second flip / invalidation: edit, delete, untracked, cmd change, salt
     change / .gitmodules disable / no-cache env / corrupt cache / hit still
     needs Evidence / append-fail continues to Evidence / cap+dedup /
     parallel integrity / determinism).
     Satisfies: REQ-5 (all criteria). Depends on: 1.
     Verify: bash .claude/hooks/tests/gate-task.test.sh — all cases pass;
     mutating the cache logic (e.g. drop the 40-hex filter) fails its case.

## Suggested execution batches

Coupled pair (task 2 tests task 1's code): run both in ONE session —
`/spec-implement all` on this feature.
