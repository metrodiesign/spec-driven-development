# Requirements: platform-phase5-stage3 — Provenance + Drift Detection
> Status: approved 2026-07-12, amended 2026-07-12 (3.5/5.2: removed-marker →
> negative EARS criterion, same A5/A7 decisions — spec-trace EARS lint requires
> every criterion line to be a real requirement)

## Overview

Stage 3 ของ Phase 5 (SDD Integration) ตาม `unified-platform-spec.md` v1.5 §14 (บรรทัด 569):
goal.yaml ที่ generate จากสเปคต้อง carry provenance แบบ structured (ไม่ใช่ comment
อย่างเดียว), core ต้อง validate + type มัน, มี drift check ตรวจจับการแก้
`requirements.md` หลัง generate (advisory ก่อน, block เมื่อพิสูจน์), และ Console แสดง
provenance ใน approval package แบบ read-only. Stage 1 (generator, PR #102) + Stage 2
(schema + typed contract, PR #110) ปิดแล้ว — stage นี้ต่อยอดของที่มีโดยไม่แตะ
พฤติกรรม freeze เดิมของ contract ที่ไม่มี provenance.

การตัดสินใจจาก clarifying/plan phase (2026-07-12, user เลือกแล้ว):
**drift anchor = sha256 ของเนื้อไฟล์** ไม่ใช่ git commit — repo ใช้ squash merge ทำให้
commit ที่ stamp ตอนอยู่ feature branch เป็น unreachable หลัง merge (`git show` fail
ใน CI ตลอดไป = เตือน false ทุก run); sha256 เทียบ content ตรงได้เสมอ git-free ·
`requirements_commit` คง stamp ไว้เป็น metadata ให้คนอ่าน ไม่ใช้ตรวจ · schema เพิ่ม
optional `requirements_sha256` (supersede stage-2 REQ-1.6 ที่ระบุ 3 field เป๊ะ) ·
drift check สแกนเฉพาะ `goal.yaml` ที่ promote แล้ว — ข้าม `goal.draft.yaml`
(pre-human, regenerate ได้ตามใจ = churn คาดหวัง) และข้าม `archive/` (ยังไม่มีของจริง) ·
advisory = exit 0 เสมอ ตาม precedent `.ai/bin/check-spec-edit.sh`; `--strict` พลิกเป็น
exit 1 ตาม precedent `check-evidence.sh --strict`.

Supersession ที่ประกาศใน stage นี้ (ตาม lesson #supersede-old-guarantees-explicitly):
- **Stage-1 REQ-3.5** (provenance เป็น comment header 4 บรรทัด) — superseded:
  เนื้อหาเดิมครบทุกค่า ย้ายเป็น structured `provenance:` block ที่ schema/freeze
  ตรวจได้; comment `# source:`/`# requirements_sha256:`/`# head_commit:`/
  `# generated_at:` ถูกแทนที่ (banner DO-NOT-RUN + `# HUMAN:` คงเดิม). e2e test
  ที่ assert comment เดิม (`console/backend/src/spec-to-goal.e2e.test.ts`) อัปเดตตาม.
- **Stage-2 REQ-1.6** (provenance = 3 field เป๊ะ "ไม่ต้อง bump") — superseded:
  เพิ่ม optional `requirements_sha256` เป็น field ที่ 4 (governance + embedded +
  parity/shape test ขยับพร้อมกันใน slice เดียว).

ข้อเท็จจริงจากโค้ดที่ requirements นี้อิง: schema provenance ปัจจุบัน
(`.ai/schemas/goal.schema.json:127-136` + embedded `console/backend/src/goal-schema.ts:139-148`)
= object, `additionalProperties: false`, required `spec_path`/`requirements_commit`/
`generated_at` ทุกตัว string · generator emit provenance เป็น comment เท่านั้น
(`scripts/spec_to_goal.py` `emit()`; sha256 คำนวณจาก raw bytes บรรทัด ~191 —
ห้าม newline translation; `head_commit` จาก `git rev-parse HEAD` best-effort,
fallback `"unknown"` + warn) · scalar ทุกตัวใน draft ผ่าน `json.dumps` (JSON string
= valid YAML flow scalar, stage-1 REQ-3.7 precedent) · core ไม่รู้จัก provenance เลย
(grep = 0 hit) — รอดผ่าน `raw` passthrough ใน `freezeContract` เท่านั้น ·
edge validation เดียว = `validateGoalShape` (ajv) ใน `loadGoalContract`
(`console/backend/src/loop-cli.ts:21-29`), freeze เป็น final semantic gate แยก ·
CI verify job มี Python 3.12 + spec-trace loop แล้ว (`.github/workflows/ci.yml:59-139`) ·
Python tooling ของ repo = stdlib-only ไม่มี PyYAML · Console:
`ApprovalPackage` (`core/src/human/approval.ts:8-21`) → `buildApprovalPackage`
(`console/backend/src/loop-run.ts:766-781` task, `:853-861` deploy) → web มี type
ซ้ำของตัวเอง `LoopApprovalPackage` (`console/web/src/logic/loop.ts:12-22`, จงใจไม่
import core) + render `console/web/src/Loop.tsx` `ApprovalCard` (~262-304) ·
ยังไม่มี goal.yaml/goal.draft.yaml จริงบนดิสก์สักไฟล์ — schema bump ไม่พังอะไร.

## REQ-1: Provenance Schema — `requirements_sha256`

**User Story:** As the platform operator, I want the provenance schema to carry the
content hash of the requirements the goal was generated from, so that drift can be
verified against file content directly without depending on git history that squash
merges destroy.

**Acceptance Criteria (EARS):**
- 1.1  THE SYSTEM SHALL extend the `provenance` object in
       `.ai/schemas/goal.schema.json` with an optional `requirements_sha256`
       property of type string; `spec_path`, `requirements_commit`,
       `generated_at` remain required strings, all four fields carry
       `minLength: 1` (parity with `deploy` fields + core's non-empty
       check — A4), and `additionalProperties` remains `false`                (ubiquitous)
- 1.2  THE SYSTEM SHALL update the embedded `GOAL_SCHEMA` copy in
       `console/backend/src/goal-schema.ts` in the same change so the
       deep-equal parity test stays green                                     (ubiquitous)
- 1.3  WHEN a goal file carries `provenance` with all four fields
       THE SYSTEM SHALL accept it at edge validation (`validateGoalShape`)    (event-driven)
- 1.4  WHEN a goal file carries `provenance` with only the three
       previously-required fields THE SYSTEM SHALL still accept it
       (backward compatible — `requirements_sha256` is optional)              (event-driven)
- 1.5  IF `provenance` carries any key outside the four defined fields
       THEN THE SYSTEM SHALL reject it at edge validation with the failing
       instance path                                                          (error handling)

## REQ-2: Generator Stamps Structured Provenance

**User Story:** As the platform operator, I want `spec_to_goal.py` to emit provenance
as a real YAML field instead of comments, so that the schema, the core contract, the
drift checker, and the Console can all read the same machine-checkable record.

**Acceptance Criteria (EARS):**
- 2.1  THE SYSTEM SHALL emit a top-level `provenance:` entry in the generated
       draft as a single-line YAML flow mapping whose keys and string values
       are all JSON-quoted (the `{...}` remainder parses with `json.loads`),
       carrying exactly: `spec_path` (repo-root-relative path of the source
       `requirements.md` when it lies inside the repo, else the path as
       given — human-facing metadata only, the drift checker never resolves
       it; see A1), `requirements_commit` (repo HEAD hash or `"unknown"`),
       `requirements_sha256` (sha256 hex of the exact `requirements.md`
       bytes read), `generated_at` (UTC ISO-8601)                             (ubiquitous)
- 2.2  THE SYSTEM SHALL no longer emit the four provenance comment lines
       (`# source:`, `# requirements_sha256:`, `# head_commit:`,
       `# generated_at:`) — supersedes Stage-1 REQ-3.5's comment form; the
       `# spec-to-goal draft — DO NOT run as-is` banner and the `# HUMAN:`
       banner remain                                                          (ubiquitous)
- 2.3  THE SYSTEM SHALL extend the `# HUMAN:` banner with an instruction to
       not hand-edit or reflow the `provenance:` line when promoting the
       draft                                                                  (ubiquitous)
- 2.4  WHEN the generated draft is validated with `validateGoalShape`
       THE SYSTEM SHALL produce no provenance-related shape errors (the
       draft may still fail freeze on `risk: "TODO"` etc. per the existing
       human gate — unchanged)                                                (event-driven)
- 2.5  IF `git rev-parse HEAD` fails THEN THE SYSTEM SHALL stamp
       `requirements_commit` as `"unknown"` and warn on stderr without
       refusing generation (existing Stage-1 behavior, retained)              (error handling)
- 2.6  THE SYSTEM SHALL keep computing `requirements_sha256` from the raw
       bytes buffer it read (no `read_text().encode()` round-trip — CRLF/BOM
       newline translation must not skew the anchor)                          (ubiquitous)

## REQ-3: Core Typed Provenance + Freeze Validation

**User Story:** As the platform operator, I want `freezeContract` to validate and
surface provenance as a typed field, so that a malformed provenance block cannot
enter a frozen contract and downstream consumers (Console) read it without touching
`raw`.

**Acceptance Criteria (EARS):**
- 3.1  THE SYSTEM SHALL add
       `provenance?: { specPath: string; requirementsCommit: string;
       requirementsSha256?: string; generatedAt: string }` to `TaskContract`
       (camelCase, same convention as `deploy`)                               (ubiquitous)
- 3.2  WHEN the parsed goal carries a valid `provenance` object
       THE SYSTEM SHALL surface it on the frozen contract's typed field
       (in addition to the unchanged `raw` passthrough)                       (event-driven)
- 3.3  WHILE `provenance` is absent from the goal file THE SYSTEM SHALL
       freeze exactly as today — the typed field stays `undefined` and no
       new validation runs (all existing fixtures freeze unchanged)           (state-driven)
- 3.4  IF `provenance` is present but is not an object, or any of
       `spec_path` / `requirements_commit` / `generated_at` is missing or
       is not a non-empty string, or `requirements_sha256` is present but
       is not a non-empty string THEN THE SYSTEM SHALL reject the contract
       with a named error (`ContractInvalidError` convention)                 (error handling)
- 3.5  THE SYSTEM SHALL NOT reject unknown provenance keys at
       `freezeContract` — unknown-key rejection stays at the ajv edge per
       stage-2 D1; freeze keeps raw passthrough for every block and
       provenance is not special (A5; pinned by test so a stricter check
       is never reintroduced at the wrong layer)                              (ubiquitous)

## REQ-4: Drift Checker Script

**User Story:** As the platform operator, I want a script that compares the current
`requirements.md` content hash against the hash stamped in a promoted `goal.yaml`,
so that editing the spec after generation surfaces as a warning instead of silent
drift.

**Acceptance Criteria (EARS):**
- 4.1  THE SYSTEM SHALL provide `scripts/spec_goal_drift.py` (Python
       stdlib-only) with a thin `scripts/spec-goal-drift.sh` wrapper
       (`exec python3`, same convention as `spec-trace.sh` /
       `spec-to-goal.sh`), invoked as
       `spec-goal-drift.sh <feature> [--specs-dir DIR] [--strict]`            (ubiquitous)
- 4.2  THE SYSTEM SHALL read `<specs-dir>/<feature>/goal.yaml`, extract the
       line matching `^provenance:` at column 0 (comment lines starting
       with `#` never match), parse its `{...}` remainder with `json.loads`,
       and compare `requirements_sha256` against the sha256 of the current
       `<specs-dir>/<feature>/requirements.md` raw bytes — the same
       directory it read `goal.yaml` from; the recorded `spec_path` is
       never used for resolution (A1)                                         (ubiquitous)
- 4.3  WHEN the hashes match THE SYSTEM SHALL print nothing and exit 0       (event-driven)
- 4.4  WHEN the hashes differ THE SYSTEM SHALL print a one-line warning to
       stdout naming the feature, both hash prefixes, and `generated_at`,
       and advise regenerate-or-re-review                                     (event-driven)
- 4.5  IF `goal.yaml` has no parseable column-0 `provenance:` line, or
       provenance lacks `requirements_sha256`, or
       `<specs-dir>/<feature>/requirements.md` does not exist THEN
       THE SYSTEM SHALL print a one-line mode-specific warning to stdout
       (three distinct messages)                                              (error handling)
- 4.6  WHILE running in default (advisory) mode THE SYSTEM SHALL exit 0 for
       every outcome in 4.4-4.5 — it informs, it never blocks (precedent
       `check-spec-edit.sh`)                                                  (state-driven)
- 4.7  WHILE running with `--strict` THE SYSTEM SHALL exit 1 for every
       non-clean outcome in 4.4-4.5 (missing provenance must fail too,
       otherwise block mode is bypassed by deleting the block)                (state-driven)
- 4.8  IF the feature directory exists but has no `goal.yaml` (draft not
       yet promoted — a normal state) THEN THE SYSTEM SHALL print
       `not applicable (no promoted goal.yaml)` and exit 0 in both modes     (error handling)
- 4.9  IF the feature directory does not exist or arguments are invalid
       THEN THE SYSTEM SHALL print usage/error to stderr and exit 2 in
       both modes (precedent `check-evidence.sh`)                             (error handling)

## REQ-5: CI Advisory Wiring

**User Story:** As the platform operator, I want CI to run the drift check on every
promoted goal.yaml, so that drift surfaces in the PR log now, and flipping to
blocking later is a one-line change.

**Acceptance Criteria (EARS):**
- 5.1  THE SYSTEM SHALL add a step to the `verify` job in
       `.github/workflows/ci.yml` after the spec-trace step that loops
       `.ai/specs/*/` (one level — drafts never match the `goal.yaml`
       filename check and `archive/<feature>/` is out of reach of this
       glob by construction; A7) and invokes
       `scripts/spec-goal-drift.sh <feature>` for each directory
       containing a `goal.yaml`                                               (ubiquitous)
- 5.2  WHERE a `goal.draft.yaml` or an archived spec's goal file exists
       THE SYSTEM SHALL NOT include it in the CI drift loop — drafts never
       match the `goal.yaml` filename check and `archive/<feature>/` lies
       outside the one-level glob by construction (A7; revisit when an
       archived goal.yaml actually exists — see Edge Cases)                   (optional)
- 5.3  WHILE zero `goal.yaml` files exist THE SYSTEM SHALL pass the step
       silently (empty loop, exit 0 — no special casing)                      (state-driven)
- 5.4  THE SYSTEM SHALL run the step WITHOUT `--strict` (advisory phase);
       the escalation path to blocking is documented as adding `--strict`
       to this single invocation                                              (ubiquitous)

## REQ-6: Console Read-Only Provenance Display

**User Story:** As the human approver, I want the approval package to show where the
goal contract came from (spec path, commit, generated time), so that I can judge
whether I am approving work against the spec version I think I am.

**Acceptance Criteria (EARS):**
- 6.1  THE SYSTEM SHALL add an optional `provenance` field (same camelCase
       shape as `TaskContract.provenance`) to `ApprovalPackage` and
       `ApprovalInput` in `core/src/human/approval.ts`, and add the
       explicit `provenance: input.provenance` copy in the
       `buildApprovalPackage` constructor (the function enumerates fields
       one by one — an interface-only change would drop it silently; A6)      (ubiquitous)
- 6.2  WHEN `loop-run.ts` builds an approval package (both the task-approval
       and deploy-approval sites) THE SYSTEM SHALL pass
       `opts.contract.provenance`                                             (event-driven)
- 6.3  WHEN a package carries provenance THE SYSTEM SHALL render it
       read-only in the web `ApprovalCard` (`console/web/src/Loop.tsx`),
       adding exactly ONE i18n label key (heading) to BOTH `en` and `th`
       dicts in `console/web/src/logic/i18n.ts` (`th` is typed
       `Record<keyof typeof en, string>` — missing = typecheck error);
       the provenance VALUES (path/hash/timestamp) render verbatim, never
       through `t()` (audit data; A10), mirroring the field on the
       web-side `LoopApprovalPackage` type (`console/web/src/logic/loop.ts`
       — type is intentionally duplicated, not imported)                      (event-driven)
- 6.4  WHILE a package has no provenance THE SYSTEM SHALL render the card
       exactly as today (absent-tolerant — no placeholder row)                (state-driven)
- 6.5  THE SYSTEM SHALL NOT add any write/edit path for provenance in the
       Console — display only                                                 (ubiquitous)

## REQ-7: Constitution Amendment v1.6

**User Story:** As the platform operator, I want `unified-platform-spec.md` to record
what Stage 3 shipped and the sha256 supersession, so that the constitution stays the
single source of truth for the contract shape.

**Acceptance Criteria (EARS):**
- 7.1  THE SYSTEM SHALL add `provenance` (four-field shape, optional) to the
       §11.1 goal.yaml example/template                                       (ubiquitous)
- 7.2  THE SYSTEM SHALL annotate §14 Stage 3 with the sha256-anchor
       supersession (3-field → +`requirements_sha256`; commit = metadata
       for humans, sha = the drift anchor)                                    (ubiquitous)
- 7.3  THE SYSTEM SHALL add a §17 changelog entry `v1.6` recording Stage 3
       delivery, the two supersessions (Stage-1 REQ-3.5 comment form,
       Stage-2 REQ-1.6 three-field shape), and the advisory-first CI stance   (ubiquitous)
- 7.4  THE SYSTEM SHALL update the stale title banner (line 3, still
       `v1.4`) to the current version as part of this amendment              (ubiquitous)

## Edge Cases & Open Questions

- **Dirty tree at generation**: `requirements_commit` may name a commit that never
  contained the hashed bytes (generator reads the working tree). Accepted — commit is
  human-facing metadata only; `requirements_sha256` is the authoritative anchor
  (stage-1 REQ-3.5 already framed it this way).
- **Human reflows the provenance line during promotion**: checker reports "no
  parseable provenance" (advisory; fails in strict mode) — fails safe, never silently
  passes. Mitigated by the `# HUMAN:` banner instruction (2.3). Upgrade path if
  hand-authored goals ever appear: PyYAML — out of scope now (stdlib-only).
- **CRLF/BOM**: both generator and checker hash raw bytes without newline
  translation (2.6, 4.2) — the anchor is byte-exact by construction.
- **`goal.draft.yaml` deliberately unscanned**: drift against a draft is expected
  churn pre-promotion; the human reviews the whole file at promotion anyway.
- **`archive/` unscanned**: no archived goal.yaml exists; an archived spec's
  requirements freeze alongside it. Revisit when one exists.
- **sha format not validated** (no `^[0-9a-f]{64}$` pattern): a malformed stamp
  simply never matches → surfaces as drift warning — fail-safe without extra rules.
- **loadGoalContract order unchanged**: ajv shape errors still surface before freeze;
  freeze remains the final semantic gate (stage-2 D-decision retained).
- **Anchor covers `requirements.md` only — NOT `tasks.md`** (known limitation, A8):
  `acceptance_criteria[].verification` values are derived from `tasks.md`; editing
  `tasks.md` after generation leaves the goal stale with no drift warning. Matches
  §14's wording ("เทียบ requirements.md ปัจจุบัน") deliberately; a `tasks_sha256`
  field is a possible future extension, out of scope here.

### Findings log — /spec-analyze round 1 (2026-07-12, anchor: HEAD `48da337`, file pre-commit)

Audit: spec-architect fresh-context + code verification. ทุกข้อ user ตัดสิน 2026-07-12
("ตามแนะนำทั้งหมด").

- **A1** spec_path absolute → CI drift check vacuous — **APPLIED**: checker hashes
  `<specs-dir>/<feature>/requirements.md` directly, never resolves `spec_path`;
  generator stamps repo-root-relative (metadata only). REQ-2.1/4.2 amended.
- **A2** "repo root" undefined in checker — **RESOLVED by A1**: repo-root concept
  removed from checker entirely.
- **A3** `# HUMAN:` banner contains literal `provenance:` → naive grep hits comment
  first — **APPLIED**: REQ-4.2 pins match to `^provenance:` at column 0.
- **A4** schema allowed empty strings while core requires non-empty — **APPLIED**:
  `minLength: 1` on all four provenance fields (REQ-1.1).
- **A5** core unknown-key reject asymmetric with freeze's raw-passthrough design —
  **APPLIED**: REQ-3.5 inverted to SHALL-NOT (unknown keys rejected at ajv edge
  only, stage-2 D1; pinned by test).
- **A6** "passed through unchanged" misleading (buildApprovalPackage enumerates
  fields) — **APPLIED**: REQ-6.1 now names the explicit `provenance: input.provenance`
  copy.
- **A7** "skip archive" vacuous (glob one level deep) + "skip draft" redundant —
  **APPLIED**: REQ-5.2 restated as by-construction SHALL-NOT (optional); archive
  scanning revisited when an archived goal.yaml exists.
- **A8** anchor blind to `tasks.md` edits — **DOCUMENTED** as known limitation
  (bullet above); `tasks_sha256` deferred.
- **A9** stderr contradicted both cited stdout precedents — **APPLIED**: warnings go
  to stdout (REQ-4.4/4.5).
- **A10** "an i18n label" underspecified — **APPLIED**: REQ-6.3 pins ONE heading key
  in both `en`+`th`, values verbatim (never `t()`).
- **A11** exit 2 conflated normal draft-only state with bad args — **APPLIED**:
  split into REQ-4.8 (no goal.yaml → exit 0 "not applicable") and REQ-4.9
  (bad args/missing dir → exit 2).
