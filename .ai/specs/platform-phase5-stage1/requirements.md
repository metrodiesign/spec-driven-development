# Requirements: platform-phase5-stage1 — Spec-to-Goal Generator
> Status: approved 2026-07-11, amended 2026-07-11 (Notes correction: continuation lines are joined by parse_requirements, not ignored — no criteria changed)

## Overview

One-way, human-gated tooling ที่แปลง approved SDD spec (`requirements.md` + `Verify:`
lines จาก `tasks.md`) เป็น `goal.draft.yaml` สำหรับ autonomous loop — Stage 1 ของ
Phase 5 (SDD Integration) ตาม `unified-platform-spec.md` v1.4 §14. ตัด toil การแปลง
spec เป็น Goal Contract ด้วยมือ โดยคง human gate เต็มรูป: generator เขียนไฟล์ draft
เดียวแล้วจบ — ไม่ freeze, ไม่ start run (INV-3/INV-16). เป็น tooling ล้วนใต้ `scripts/`
— ไม่แตะ runtime code (core/aal/adapters/console) ใดๆ.

ข้อเท็จจริงจากโค้ดที่ requirements นี้อิง: `freezeContract`
(`core/src/contract/contract.ts:59`) รับ `verification` เป็น optional string — สตริง
`"TODO"` ผ่าน freeze ได้; กลไกเดียวที่ทำให้ draft รันไม่ได้เชิงโครงสร้างคือ
`acceptance_criteria` ที่เป็น array ว่าง (throw `acceptance_criteria must be a
non-empty array`) — precedent เดียวกับ issue intake (`console/backend/src/issues.ts`).

## REQ-1: Source Resolution & Preconditions

**User Story:** As the platform operator, I want the generator to accept only an
approved feature spec, so that the Goal Contract pipeline never starts from an
unreviewed or wrong-shaped source.

**Acceptance Criteria (EARS):**
- 1.1  WHEN invoked with a feature slug THE SYSTEM SHALL read
       `.ai/specs/<feature>/requirements.md` and `.ai/specs/<feature>/tasks.md`
       as its only inputs                                                    (event-driven)
- 1.2  WHERE a `--specs-dir <path>` flag is provided THE SYSTEM SHALL resolve
       the feature folder under that directory instead of `.ai/specs/`       (optional)
- 1.3  IF `requirements.md` is missing THEN THE SYSTEM SHALL refuse with a
       non-zero exit code and a message naming the missing file              (error handling)
- 1.4  IF the `requirements.md` header line does not begin with
       `> Status: approved` (the amended form `> Status: approved <date>,
       amended <date>` also passes) THEN THE SYSTEM SHALL refuse with a
       non-zero exit code — with NO bypass flag                              (error handling)
- 1.5  IF `requirements.md` contains no `## REQ-` heading (including
       bugfix-form specs that use F-/B- IDs) THEN THE SYSTEM SHALL refuse
       with a message stating that only REQ-form feature specs are supported (error handling)
- 1.6  WHERE `tasks.md` is absent THE SYSTEM SHALL still generate the draft
       with every verification unresolved and print a warning to stderr      (optional)
- 1.7  IF `requirements.md` contains a duplicate criterion ID THEN THE
       SYSTEM SHALL refuse, naming the duplicated ID                         (error handling)
- 1.8  IF any `## REQ-` heading has no criterion line under it THEN THE
       SYSTEM SHALL refuse, naming the empty REQ                             (error handling)

## REQ-2: Acceptance-Criteria Mapping

**User Story:** As the platform operator, I want each EARS criterion mapped to a
Goal Contract acceptance criterion with its verification command prefilled where
provable, so that I only hand-fill what the spec genuinely cannot answer.

**Acceptance Criteria (EARS):**
- 2.1  THE SYSTEM SHALL emit exactly one acceptance criterion per EARS
       criterion `N.M`, with id `AC-N.M`                                     (ubiquitous)
- 2.2  THE SYSTEM SHALL set each acceptance criterion's `description` to the
       criterion's EARS text verbatim                                        (ubiquitous)
- 2.3  THE SYSTEM SHALL interpret `Satisfies:` references with the same
       semantics as `scripts/spec_trace.py` (dash ranges `17.1-17.4`, single
       ids `N.M`/`REQ-N.M`, and whole-REQ `REQ-N` expanding to all its
       criteria)                                                             (ubiquitous)
- 2.4  WHEN exactly one task's `Satisfies:` covers criterion `N.M` AND that
       task line carries a `Verify:` command THE SYSTEM SHALL set that
       command as the criterion's `verification`                             (event-driven)
- 2.5  IF zero tasks or more than one task cover criterion `N.M`, or the
       single covering task has no `Verify:` command, THEN THE SYSTEM SHALL
       mark that criterion's verification as unresolved                      (error handling)
- 2.6  THE SYSTEM SHALL emit every acceptance criterion WITHOUT a `golden`
       key (the golden designation is a human decision at freeze time —
       unified-platform-spec §6.5)                                           (ubiquitous)

## REQ-3: Draft Document Shape

**User Story:** As the platform operator, I want the draft to carry provenance and
an explicit fill-me checklist, so that a reviewer can see where it came from and
exactly what remains to be decided by a human.

**Acceptance Criteria (EARS):**
- 3.1  THE SYSTEM SHALL set `goal.id` to `<FEATURE-SLUG-UPPERCASED>-001`
       (e.g. feature `user-auth` -> `USER-AUTH-001`)                         (ubiquitous)
- 3.2  THE SYSTEM SHALL set `goal.title` to the feature name from the
       requirements H1 heading                                               (ubiquitous)
- 3.3  THE SYSTEM SHALL emit `scope` and `constraints.forbidden` as explicit
       TODO placeholders for the human to fill                               (ubiquitous)
- 3.4  THE SYSTEM SHALL emit the same six-key budget scaffold as the issue
       intake draft (`console/backend/src/issues.ts` `goalDraftYaml`)        (ubiquitous)
- 3.5  THE SYSTEM SHALL emit a provenance comment header containing the
       source spec path, the repo HEAD commit hash, the sha256 of the
       `requirements.md` bytes it read, and the generation timestamp
       (sha256 is the anchor Stage 3 drift detection compares against;
       the commit hash is for the human reader)                              (ubiquitous)
- 3.6  THE SYSTEM SHALL emit a `# HUMAN:` banner listing every remaining
       human decision: review ACs, fill unresolved verifications, set
       `risk`, decide `golden` flags, set `approval_policy`                  (ubiquitous)
- 3.7  THE SYSTEM SHALL produce output that parses as valid YAML             (ubiquitous)

## REQ-4: Human Gate & Output Safety

**User Story:** As the platform operator, I want a generated draft to be
structurally un-runnable until a human resolves every open item, so that no
autonomous run can ever start from generator output alone.

**Acceptance Criteria (EARS):**
- 4.1  THE SYSTEM SHALL write its output to
       `.ai/specs/<feature>/goal.draft.yaml` and never to `.ai/goal.yaml`
       (which would flip the Console's loop-managed banner)                  (ubiquitous)
- 4.2  IF the output file already exists and `--force` is not given THEN THE
       SYSTEM SHALL refuse with a non-zero exit code and leave the existing
       file byte-identical                                                   (error handling)
- 4.3  WHERE `--force` is given THE SYSTEM SHALL overwrite the existing
       output file                                                           (optional)
- 4.4  WHILE at least one criterion's verification is unresolved THE SYSTEM
       SHALL emit a draft whose active `acceptance_criteria` key is an empty
       array — so that `freezeContract` rejects the file as-is — with the
       full generated criteria list preserved in the draft for the human to
       activate (exact YAML shape is a design decision)                      (state-driven)
- 4.5  WHEN every criterion's verification is resolved THE SYSTEM SHALL emit
       the criteria as the active `acceptance_criteria` array, shaped so the
       draft passes `freezeContract` unchanged                               (event-driven)
- 4.6  THE SYSTEM SHALL perform no action other than writing the single
       output file and printing to stdout/stderr — it SHALL NOT invoke
       `freezeContract`, start a run, or call any platform CLI              (ubiquitous)

## REQ-5: CLI Behavior

**User Story:** As the platform operator, I want the generator runnable the same
way as the existing spec tooling, so that it fits the muscle memory and CI
conventions already in place.

**Acceptance Criteria (EARS):**
- 5.1  THE SYSTEM SHALL be invocable as `scripts/spec-to-goal.sh <feature>
       [--force] [--specs-dir <path>]` — a thin wrapper over a Python
       implementation, following the `scripts/spec-trace.sh` /
       `scripts/spec_trace.py` convention                                    (ubiquitous)
- 5.2  WHEN generation succeeds THE SYSTEM SHALL exit 0 and print a summary
       line stating the AC count and how many verifications are resolved
       vs unresolved                                                         (event-driven)
- 5.3  IF any precondition or safety check fails THEN THE SYSTEM SHALL exit
       non-zero with a single-line reason on stderr                          (error handling)

## Edge Cases & Open Questions

### Analyze findings log (anchor: 3806c93, requirements.md ยัง uncommitted ณ ตอน audit)

Audit 2026-07-11 — ทุก finding มี decision แล้ว:

- **A1** (REQ-1.4) amended header (`approved <date>, amended <date>`) ต้องผ่าน gate
  — **APPLIED**: 1.4 เปลี่ยนเป็น "begins with `> Status: approved`"
- **A2** (REQ-3.5) provenance anchor — **APPLIED**: HEAD commit + sha256 ของ
  requirements.md bytes (sha256 = ตัวที่ Stage 3 drift check ใช้จริง)
- **G1/G2** duplicate criterion ID / REQ heading ว่าง — **APPLIED**: refuse ทั้งคู่
  (criteria ใหม่ 1.7, 1.8)
- **A3** (REQ-5.1) specs-dir override — **APPLIED**: named flag `--specs-dir <path>`
- Self-answered (logged, ไม่แก้ criteria):
  - task checkbox `[x]`/`[ ]` นับเท่ากันตอน map `Satisfies:` — coverage semantics
    ไม่ใช่ progress tracking
  - รันนอก git repo → provenance commit = `unknown` + warn, ไม่ refuse (sha256 ยัง
    ครบ — drift check ไม่เสีย)
  - เขียน output แบบ atomic (temp + rename) กัน partial file ค้างชน 4.2 — design note
  - ค่า budget scaffold pin เป็น literal ใน design.md — ไม่ import จาก runtime code
  - `Verify:` text ที่ไม่ใช่ executable command copy verbatim — human review จับ

### Notes

- `goal.objective`: requirements.md Overview เป็น prose ยาว — draft จะใส่ TODO
  ให้คนเขียน objective หนึ่งประโยคเอง (ไม่ auto-summarize — generator ต้อง
  deterministic)
- `Verify:` command ที่มี YAML special characters (`:`  `#` quotes) — design ต้อง
  quote ให้ round-trip ผ่าน YAML parser ได้ (covered by 3.7)
- Criterion ที่ EARS text ยาวหลายบรรทัด: `spec_trace.py` `parse_requirements()`
  join บรรทัด continuation ที่ indent เข้าเป็น text เดียว — generator ใช้พฤติกรรม
  เดียวกัน (import ฟังก์ชันเดิม) ดังนั้น description ใน AC = full joined text
- Archived specs ใช้เป็น input ได้ผ่าน specs-dir override (1.2) — จำเป็นสำหรับ
  e2e test กับ `platform-phase4`
- ไม่รองรับ: bugfix specs (F-/B-) — refuse ชัดตาม 1.5; multi-goal splitting
  (feature ใหญ่ = contract เดียว AC หลายตัว จนกว่า Stage 4 Task Graph)
