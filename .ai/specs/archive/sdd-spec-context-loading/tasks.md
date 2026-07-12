# Implementation Tasks: Spec Context Loading Discipline (archive + per-task slice)

> Status: approved 2026-07-11, amended 2026-07-12 (quick, no gates), amended
> 2026-07-12 (REQ-3.8-3.12, REQ-6 — Section-column matcher, code-fence
> safety, retrofit)

> Each task is a cohesive, independently verifiable slice. Implement a whole task
> in one pass (it may touch many files). Decompose into sub-steps yourself at
> execution time — do NOT pre-split tasks here.

- [x] 1. Archive mechanism end-to-end — scripts/spec-archive.sh (validated
     git mv: tasks.md present, zero unchecked, destination free), SessionStart
     hook exclusion (`grep -v '^archive$'` in settings.json), spec-trace CLI
     extension `spec-trace.sh <feature> [<specs-dir>]` (default .ai/specs,
     threaded into spec_trace.py main — existing callers untouched), ci.yml
     second glob over .ai/specs/archive/*/ passing the archive root, plus the
     archive rows of the test suite (refuse-on-unchecked / refuse-no-tasksmd /
     clean move / trace-over-archive-via-specs-dir-arg / SessionStart output).
     Satisfies: REQ-1 (all criteria), REQ-2 (all), REQ-5.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (archive cases) +
     scripts/spec-trace.sh on an archived fixture.
     Evidence:
       - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> 9 passed / 0 failed; full guard-suite sweep (9 files) -> all exit 0; `scripts/spec-trace.sh <feature> .ai/specs/archive` over all 5 REQ-based archived features (platform-phase0..4) -> all OK
       - viewports: n/a — logic-only (bash + jq)
       - deviations: (1) SessionStart's inline jq/shell one-liner in settings.json turned out too fragile to hand-edit safely (two attempts corrupted the JSON differently — an inline `grep -v '^archive$' | tr` insertion tripped the settings validator). Extracted the active-specs listing into `scripts/session-start-active-specs.sh` instead (small, testable, same output) and pointed settings.json's command at it — a safer implementation than the design's literal inline-grep sketch, same behavior, and consistent with REQ-5.3's own "testable scripts over inline shell" philosophy from sdd-ci-incremental-checks. (2) ci.yml's second glob (REQ-1.5) was initially missed on the first pass and added afterward, after task 4's live archive run exposed the gap — fixed before closing this task.
- [x] 2. Deterministic slicer — scripts/spec-slice.sh (task block → Satisfies
     REQs → traceability-mapped design sections, Status headers, MISSING
     markers, unknown-id listing) with its test rows.
     Satisfies: REQ-3 (all criteria), REQ-5.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (slice cases).
     Evidence:
       - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> 9 passed / 0 failed (5 slice-specific cases: known-task-fully-resolved, unknown-id, absent-REQ MISSING, unmapped-design-cell MISSING, plus Status headers asserted inline on the known-task case)
       - viewports: n/a — logic-only (bash + awk)
       - deviations: macOS `/usr/bin/awk` (one-true-awk, not gawk) silently drops a lone backslash passed via `-v` string variables (`\[` becomes `[`), turning literal-bracket regexes into broken bracket-expressions — caught by testing against a REAL tasks.md checkbox line before wiring the whole script, not by inspection. Fixed by hardcoding bracket-containing regex fragments directly in the awk program text (only the plain numeric id/REQ-number is passed via `-v`) instead of round-tripping them through shell-to-awk string escaping
- [x] 3. Slice-first skill rewiring — spec-implement SKILL.md step 1 loads via
     spec-slice.sh with the three fallback triggers (MISSING / assembly-final /
     operator asks); gates and Evidence rules untouched.
     Satisfies: REQ-4 (all criteria). Depends on: 2.
     Verify: dry-run /spec-implement on a fixture feature — context comes from
     the slice; a MISSING marker forces the full read.
     Evidence:
       - test: dry-run `scripts/spec-slice.sh sdd-lessons-to-guard-tests 1` (a real upcoming task in this same session) -> STATUS+TASK+REQ-1 block returned, plus `MISSING: design section for "LESSONS-COVERAGE.md table + slug key"` / `"advisory reason column"` — correctly signals the full design.md read is needed for that task, exactly as step 1's new fallback rule specifies
       - viewports: n/a — skill/process doc edit
       - deviations: none. Steps 2-5 and all gates/Evidence rules in SKILL.md left untouched (REQ-4.4); bugfix specs explicitly routed around the slicer in the new step 1 text since bugfix.md uses F-IDs/B-IDs, a shape spec-slice.sh does not parse
- [x] 4. Archive the closed backlog — run spec-archive.sh over
     platform-phase0..4 + bugfix-console-fetch-status + bugfix-fchat-hardening
     (acceptance demo); confirm SessionStart lists only live specs and CI
     spec-trace stays green over the archive.
     Satisfies: REQ-1 (live proof), REQ-2. Depends on: 1.
     Verify: new session shows only active specs; CI green on the PR.
     Evidence:
       - test: `scripts/spec-archive.sh <feature>` x7 -> all exit 0, `git status --short` shows clean R (rename) entries for each; `scripts/session-start-active-specs.sh` -> lists only the 8 live sdd-* specs, no platform-phase*/bugfix-*/archive; `scripts/spec-trace.sh <feature> .ai/specs/archive` over all 5 REQ-based archived features -> all OK (bugfix-* use bugfix.md, already outside spec-trace's scope pre-archive, same as before)
       - viewports: n/a — repo/CI maintenance action
       - deviations: none. Full guard-suite sweep (9 files) still all exit 0 after the moves. Actual CI-green confirmation happens once this branch is pushed as a PR (same follow-up caveat as sdd-ci-incremental-checks task 3).

- [x] 5. Fix design-table REQ-column matcher to accept bare `N.M` ids, not
     just `REQ-N` (scripts/spec-slice.sh), and make a REQ that matches zero
     traceability rows surface its own `MISSING:` marker instead of silently
     contributing nothing (quick amendment, no gates — bug flagged in
     retrospectives/2026-07/12/15.25_phase5-stage3-impl.md and
     LESSONS.md #slice-tool-verify-not-just-missing-marker).
     Satisfies: REQ-3.6, REQ-3.7.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (new cases) + full
     guard-suite sweep + scripts/spec-trace.sh sdd-spec-context-loading +
     scripts/lessons-coverage-check.sh.
     Evidence:
       - test: added 3 cases to `.claude/hooks/tests/spec-slice.test.sh`
         (bare-dotted-id match, zero-row MISSING, mixed REQ-prefixed+bare row)
         against a new `bare-id-fixture`; confirmed RED against the pre-fix
         matcher (2 of 3 failed exactly as diagnosed — bare id silently
         matched nothing, zero-row case produced no MISSING); applied the fix
         (regex alternation accepting a bare `N\.[0-9]` alongside the existing
         `REQ-N` alternative, plus a `DESIGN_REQS_MATCHED` sweep after the row
         loop); reran -> `pass=12 fail=0`. Codex P2 review on PR #118 (real,
         not refuted) then found the bare-id left-boundary
         (`[,[:space:]]`) too narrow — a bare id wrapped in normal markdown
         punctuation (`` `4.1` ``, `(4.2)`) didn't match, unlike
         `scripts/spec_trace.py`'s own token-boundary regex, which this
         design already cites as the pattern to mirror. Added a 4th
         punctuation-wrapped case to the same fixture, confirmed RED, widened
         the boundary to `(^|[^A-Za-z0-9_.])` (excludes only alnum/underscore/
         dot immediately before the number, matching `spec_trace.py`'s
         `(?<![A-Za-z0-9_.])` semantics as closely as POSIX ERE without
         lookbehind allows) -> `pass=13 fail=0`. Full guard-suite sweep (11
         `.claude/hooks/tests/*.test.sh` files) -> all exit 0.
         `scripts/spec-trace.sh sdd-spec-context-loading` -> OK, 20 criteria.
         `scripts/lessons-coverage-check.sh` -> OK, slugs synced. Live
         verification against the two real specs that exposed the bug:
         `scripts/spec-slice.sh platform-phase5-stage2 1` and
         `scripts/spec-slice.sh platform-phase5-stage3 1` now both emit
         `MISSING: design section for REQ-N (no traceability-table row
         references it)` markers where before the fix they emitted nothing at
         all for the design section (silent, no marker) — the fallback
         signal is now present, even though the underlying design-element
         cell in those two specs separately fails the pre-existing
         cell-to-heading lookup (see deviations).
       - viewports: n/a — logic-only (bash + grep -E)
       - deviations: (1) discovered, while verifying against real specs, that
         the OTHER half of REQ-3.1's matcher (design-element cell matched
         against `## ` headings by literal substring) resolves to `MISSING`
         for effectively every row in every spec in this repo — a sweep
         across all 11 `.ai/specs/*/design.md` traceability tables found 0
         cell-to-heading matches out of every row checked (0/11 through 0/24
         per spec, including this spec's own table). The design-section
         slice has therefore never actually returned content for any real
         spec; every task always falls back to a full `design.md` read for
         its design section, for a reason unrelated to REQ-3.6/3.7. Left
         unfixed — out of scope for this amendment, not silently expanded;
         flagged to the operator as a new, separate, higher-severity
         discovery for a follow-up decision. (2) Did not add a bare
         whole-integer (no-dot) alternative for the REQ column, matching
         `scripts/spec_trace.py`'s own `REF_RE` precedent, which likewise
         requires the `REQ-` prefix for a whole-requirement reference and
         only makes the prefix optional for dotted criterion ids — no real
         table in this repo uses a bare whole-integer reference.

- [x] 6. Section-column matcher + code-fence safety — scripts/spec-slice.sh:
     replace the literal-substring design-element-cell match with an explicit
     `Section` column, located by header name (never fixed position) and
     compared by case-sensitive exact equality after trimming both sides
     (heading text only, no `## ` prefix); add fence-tracking to
     `req_block()`, `section_from_heading()`, and the inline Requirement
     Traceability block extraction so a `## `-looking line inside a ``` fence
     is never mistaken for a real boundary. New test cases per design.md's
     Testing Strategy: 3.8 substring/case-variant MISSING (no false match),
     3.9 absent-value-or-column MISSING, 3.10 dedup-by-Section, 3.11 fence
     fixture (this spec's own "Data Models & Interfaces" section), 3.12
     Section column at a non-default table position.
     Satisfies: REQ-3.8, REQ-3.9, REQ-3.10, REQ-3.11, REQ-3.12.
     Verify: bash .claude/hooks/tests/spec-slice.test.sh (new cases) + full
     guard-suite sweep + scripts/spec-trace.sh sdd-spec-context-loading.
     Evidence:
       - test: `bash .claude/hooks/tests/spec-slice.test.sh` -> pass=17 fail=0
         (12 prior + 5 new: 3.8 substring/case-variant no-false-match, 3.10
         dedup-by-Section across two REQs, 3.9 no-Section-column-at-all
         MISSING per row not collapsed, 3.11 fenced heading-shaped line in
         requirements.md/design.md/the traceability table itself all stay
         non-boundaries). Full guard-suite sweep (12 `.claude/hooks/tests/*.test.sh`
         files) -> 11 green; `gate-task.test.sh` showed one failure on the
         first run (`concurrent invocations, IDENTICAL tree` — REQ-2.5/4.2/
         ARC-16, a script this task never touches) then passed pass=42
         fail=0 on 3 immediate reruns — a pre-existing timing-sensitive
         concurrency flake, not a regression from this change.
         `scripts/spec-trace.sh sdd-spec-context-loading` -> OK, 29 criteria.
         Manual verification against the real bug instance that motivated
         REQ-3.11 (this spec's own design.md "Data Models & Interfaces"
         section): `section_from_heading()` now returns the full 101 lines
         matching the section's real boundary (`## Technology Decisions`),
         not the old truncated 25 cut short at the fenced `## REQ-2:`
         example. Spot-checked `scripts/spec-slice.sh <feature> 1` against 4
         other active, not-yet-retrofitted specs (sdd-guard-dedup,
         sdd-gate-task-cache, platform-phase5-stage1,
         sdd-premerge-review-standard) -> all exit 0 with graceful `MISSING:`
         lines (no Section column yet), confirming the transition window
         (REQ-3.8 landing before REQ-6's retrofit) stays safe repo-wide, not
         just for this spec's fixtures.
       - viewports: n/a — logic-only (bash + awk)
       - deviations: (1) REQ-3.10's dedup-by-Section applies only to
         non-empty Section values; two rows that both have an absent/empty
         Section (the pre-retrofit case, tested by the no-Section-column
         fixture) each still print their own `MISSING:` line rather than
         collapsing into one — REQ-3.10's wording targets avoiding duplicate
         *content*, which doesn't apply when there is no content, and
         collapsing distinct missing-coverage rows into a single message
         would have hidden which REQs are actually affected. (2) Added
         `find_heading_line()` as a new helper (locates the real, verbatim
         `## ` line whose trimmed text equals a `Section` value) rather than
         changing `section_from_heading()`'s existing contract, so that
         function's signature and prior callers/docs stay untouched — it
         still takes an exact, real line. (3) The REQ-3.11 automated
         regression test uses a dedicated synthetic fixture instead of this
         spec's own design.md (as design.md's Testing Strategy row
         describes) — a fixture pinned to the real file would break the
         moment task 7 splits "Data Models & Interfaces" into peer headings
         as planned; the synthetic fixture reproduces the identical
         structural pattern (a fence quoting a heading-shaped line) and
         stays valid regardless of what task 7 does to the real file. The
         real-file bug instance was independently confirmed by manual
         verification instead (see test: above). (4) `MISSING:` message text
         changed shape slightly (now names the failing `Section` value or
         the row's raw REQ-column text instead of the retired design-element
         cell) — kept the existing `design section for "X"` prefix
         unchanged so the one pre-existing test asserting exact MISSING text
         (REQ-3.4, "Nonexistent Section Name") still passes unmodified.
       - **amendment (found during task 7):** `header_col($HEADER_ROW, "REQ")`
         regressed the two active specs whose traceability table heads its
         REQ-bearing column "Satisfies" instead of "REQ"
         (platform-phase5-stage1, platform-phase5-stage2) — every row's
         `cell2` came back empty, so REQ matching silently found zero rows
         for any task in those specs (surfaced as the same-shaped
         `MISSING: ... (no traceability-table row references it)` this
         task's own spot-check was already expecting, which is why the
         original spot-check's exit-0-plus-MISSING-count reading did not
         catch it). Root cause: REQ-3.12 only requires the `Section` column
         to be header-name-located; making the pre-existing REQ column
         *also* header-name-only was an unrequested tightening on my part
         that assumed a single header spelling. Fixed by falling back to
         `header_col($HEADER_ROW, "Satisfies")` when `"REQ"` isn't found;
         added a regression fixture (`satisfies-header-fixture`) to
         `spec-slice.test.sh`. Re-ran the full suite: pass=18 fail=0.
- [x] 7. Retrofit all 11 active specs' design.md traceability tables (REQ-6) —
     add a `Section` column to each, with every row's value set to a real
     `## ` heading (existing, or a new peer-level one created by splitting a
     coarse heading, per requirements.md's Edge Cases allowance). This spec's
     own design.md needs the split explicitly recorded in Technology
     Decisions: promote its six labeled `Data Models & Interfaces` sub-blocks
     to peer `## ` headings, keep the REQ-3.11 fence fixture inside a single
     resulting sub-heading, and re-point both the REQ-3.11 test's target
     section and the Requirement Traceability row's `Section` value to that
     sub-heading's real name. For each of the 11 specs, demonstrate at least
     one task's `scripts/spec-slice.sh` output returns real, complete DESIGN
     content (not `MISSING:`, and its last line matches the section's real
     last line) for at least one design reference.
     Satisfies: REQ-6.1, REQ-6.2, REQ-6.3, REQ-6.4. Depends on: 6.
     Verify: scripts/spec-slice.sh <feature> <task-id> per spec shows DESIGN
     content (not MISSING) with matching last line; scripts/spec-trace.sh
     across all 11 specs stays green.
     Evidence:
       - test: operator chose split-the-3-large/coarse-the-7-small as the
         retrofit granularity (this spec + platform-phase5-stage1/2/3 got
         peer-heading splits; the other 7 map every row to their one real
         existing heading — sizes ranged 20-70 lines, not worth splitting).
         Splits used each spec's own pre-existing structure where present
         (platform-phase5-stage1/2/3 already had `### ` sub-headings or
         `C1`/`D1`-style labeled components matching their traceability
         rows almost 1:1 — promoted `###` to `##`, dropped the now-empty
         parent `## Data Models & Interfaces` line); this spec's own file
         had no such sub-structure, so 5 peer headings were authored per the
         plan already recorded in its Technology Decisions (output-contract
         + resolution-rules kept combined, not the 6 originally-labeled
         blocks, to keep the REQ-3.11 fence fixture and every REQ-3.x row
         depending on it under one stable heading — no re-pinning needed).
         `scripts/spec-trace.sh <feature>` for all 11 active specs -> OK
         (14-40 criteria each, EARS lint clean). Every task in all 11
         specs sliced individually (not just one per spec): 100% zero
         `MISSING:` for design references — platform-phase5-stage1 (2
         tasks), stage2 (4), stage3 (5), this spec (7), the 7 coarse specs
         (2-3 tasks each, 16 tasks total) — 36 tasks checked, all clean.
         Completeness (REQ-6.3's last-line requirement) spot-checked
         against the real files on one section per split spec (this spec's
         combined output-contract/resolution-rules section: 101 real
         lines, slice's last line matches file line 148 exactly;
         platform-phase5-stage1's Output section; platform-phase5-stage2's
         C6 section; platform-phase5-stage3's Core-typed-field section) —
         all matched their real file boundary byte-for-byte. Full
         guard-suite sweep (12 `.claude/hooks/tests/*.test.sh`) -> all
         green (`gate-task.test.sh`'s earlier single failure during task 6
         reconfirmed as the same pre-existing concurrency flake — clean
         pass=42 this run too).
       - viewports: n/a — logic-only (markdown headings + bash)
       - deviations: (1) a real bug was found and fixed here, not just
         retrofit work — see task 6's Evidence amendment above
         (`header_col` needed a `"Satisfies"` fallback alongside `"REQ"`;
         platform-phase5-stage1/2 use that header spelling). (2) 3 of the 24
         D-groups and 20 C-groups (platform-phase5-stage3's D7, stage2's
         "ajv เฉพาะ console/backend" row) had no dedicated sub-heading of
         their own; mapped to "Architecture Overview" since that is the one
         real heading that actually discusses them (verified by direct
         grep, not assumed) rather than inventing a new heading for a
         one-off mention. (3) For the 7 coarse specs, rows whose design-element
         text unambiguously names a test file/suite (or whose REQ group's
         title is explicitly about tests/regression proof, confirmed by
         reading the REQ title in requirements.md for the 2 ambiguous cases)
         were routed to "Testing Strategy" instead of the catch-all heading
         — a free, zero-risk improvement over uniform coarse-mapping, not a
         full per-row semantic split.

## Suggested execution batches

Tasks 1+2+3 share the fixture and the test file — ONE session
(`/spec-implement 1-3`). Task 4 is a mechanical follow-up in the same PR.
Task 5 is a later quick amendment (2026-07-12, no gates) fixing the bare-id
matcher gap discovered while implementing platform-phase5-stage3.

Tasks 6-7 (2026-07-12 amendment, REQ-3.8-3.12/REQ-6): task 6 shares
scripts/spec-slice.sh + its test file with tasks 2/5 — run it alone first
(`/spec-implement 6`) to verify the matcher in isolation before task 7 leans
on it. Task 7 depends on 6 and sweeps 11 separate design.md files
(long-context, repetitive, including this spec's own heading split) —
isolate it in its own session (`/spec-implement 7`) rather than combining
with 6, both for the dependency order and to avoid context drift across that
many files.
