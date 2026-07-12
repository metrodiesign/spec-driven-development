> Canonical source for ALL agents. Machine-checked companion to `.ai/shared/LESSONS.md`
> (sdd-lessons-to-guard-tests). `scripts/lessons-coverage-check.sh` verifies: every slug
> in LESSONS.md has exactly one row here and vice versa; every `mechanized` row's
> artifact file exists AND still contains that row's slug string.
>
> classification:
> - `mechanized` — an executable check exists today; third column = its artifact
>   (`file::case` convention, human-readable, not a hard path syntax).
> - `mechanizable` — a check is possible but not yet built; third column names the
>   follow-up work item. Legal, not an error — a visible backlog.
> - `advisory` — one-line reason no executable surface exists for this lesson.

| slug | classification | enforcement / reason |
|---|---|---|
| pure-logic-first | advisory | architecture/coding-style principle — no repo-checkable failure pattern |
| spec-analyze-before-design | advisory | process-ordering recommendation, already the skill's own step order |
| vuln-dev-vs-prod-split | advisory | judgment call classifying audit findings — no generic mechanizable rule across stacks |
| rtk-proxy-raw-logs | advisory | operational technique for reading a human's own terminal, not repo state |
| cost-from-ledger-only | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::cost-from-ledger-only — asserts cost-summary.py + inject-cost.py import cost_lib |
| headless-pane-buffer-not-stuck | advisory | interpreting terminal/pane state correctly — human judgment call |
| read-output-before-refire | advisory | agent's own behavioral discipline, not a repo artifact |
| tasks-checkbox-vs-filesystem | mechanized | scripts/spec-state.sh::reconcile — wired into spec-implement SKILL.md step 0 |
| git-diff-stat-misses-untracked | advisory | reporting-discipline reminder for retro/handoff authors |
| assembly-task-section-gaps | advisory | task-decomposition cross-check principle, applied per-feature by a human/agent |
| multi-session-cost-discovery | advisory | a measured cost fact informing a heuristic, not a failure pattern to guard against |
| hook-block-kills-compound-command | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::hook-block-kills-compound-command — every guard/floor script tracked at git mode 100755 |
| guard-needs-adversarial-test | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::guard-needs-adversarial-test — every .ai/bin check-*.sh + gate-task.sh referenced by some *.test.sh |
| guard-flatstring-escape-fail-open | mechanized | .claude/hooks/tests/destructive-guard.test.sh::escape-idiom-wrappers — sh -c / bash -c / eval rm -rf cases |
| guard-read-vs-write | mechanized | .claude/hooks/tests/hook-bypass-guard.test.sh::read-vs-write-hookspath — read cases allow, write cases block |
| multiagent-partition-by-file-owner | advisory | multi-agent orchestration design principle, applied when designing a workflow |
| verdict-null-not-rejected | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::verdict-null-not-rejected — structural grep on review-fanout.js + node -e partition replica (REQ-4.1) |
| gate-external-wire-protocol | advisory | debugging-methodology reminder (root-cause the wire protocol before loosening a verdict) |
| replay-cache-never-committed | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::replay-cache-never-committed — gate-task.sh's cache path is derived from git-dir |
| monitor-pane-anchor-after-marker | advisory | Monitor-tool usage technique, not repo state |
| squash-merge-title-unreliable | advisory | git/GitHub verification discipline for a human reading merge history |
| bash-tool-no-tty-iterm-pane | advisory | operational technique for live-command verification |
| openai-strict-schema-requirements | advisory | vendor API knowledge note for a future adapter, no current code to check against |
| vendor-scan-includes-comments | mechanized | scripts/check-core-vendor-free.sh::scans-comments — scans "including tests and comments" per its own header |
| ci-green-not-pipeline-connected | advisory | integration-vs-unit testing philosophy reminder |
| post-merge-review-still-finds-bugs | advisory | institutionalized as a SKILL-level gate (merge-pr SKILL.md step 1.5, sdd-premerge-review-standard) by deliberate design choice — expensive + human-priced, so CI/automated enforcement is explicitly not the mechanism; no executable check to point at |
| check-review-against-spec-first | advisory | review-triage discipline for a human/agent reading bot comments |
| teammate-resume-after-transient-error | advisory | operational technique for SendMessage/resume after infra errors |
| skill-output-path-explicit-scratchpad | advisory | the named artifact (session-report skill) is a third-party plugin skill, not source in this repo — no file here to check against |
| destructive-guard-branch-protection-workaround | advisory | operational workaround technique (gh api) for an accepted, tested over-block |
| branch-delete-ancestry-squash-issue | mechanized | .claude/hooks/tests/lesson-tripwires.test.sh::branch-delete-ancestry-squash-issue — sync-branch SKILL.md checks MERGED state before any -D fallback |
| workflow-script-eslint-ignore | mechanized | eslint.config.mjs::workflows-ignore — ignores: [..., '.claude/workflows/**'] |
| lesson-reintro-check-before-build | advisory | meta process discipline; REQ-3's retro classification step is the standing institutional answer, not a per-lesson executable check |
| shared-iterator-boundary-altitude | mechanized | console/backend/src/spec-to-goal.e2e.test.ts — "spec-trace gate ... must NOT fake coverage" + "Evidence boundary: mid-line ... lowercase evidence: header still cuts" (ทั้งคู่แดงถ้า Evidence rule ถูก fork per-consumer, หลุด case-insensitivity, หรือกลับเป็น substring cut) |
| supersede-old-guarantees-explicitly | advisory | ต้อง reasoning ข้าม spec รุ่นเก่า/archive ว่า guarantee ไหนถูกกลับด้าน — ไม่มี machine-checkable surface ทั่วไป |
| guard-mirrors-action-condition | advisory | per-guard design judgment; เคส stage2 มี test คู่ negative แล้ว (loop-run.test.ts "guard mirrors the dispatch condition") แต่ตัว pattern ใช้กับ guard ใหม่ทุกตัวที่ยังไม่เกิด |
| wiring-test-nondefault-value | advisory | test-authoring principle — เลือกค่า assert ต่อ test ใหม่เป็น judgment, lint ทั่วไปแยก default-collision ไม่ได้ |
| slice-tool-verify-not-just-missing-marker | mechanizable | not yet built — flagged in retrospectives/2026-07/12/15.25_phase5-stage3-impl.md Next Steps; fix = spec-slice.sh's design-table row matcher should also accept bare N.M ids (not just REQ-N) when checking a task's Satisfies REQs, and warn loudly on zero matches instead of silent drop |
| test-not-real-repo-incidental-state | advisory | test-authoring judgment call (what counts as "incidental" repo state vs. a real invariant) — no generic lint distinguishes them |
| autobg-notification-not-manual-wait | advisory | harness tool-usage guidance for the assistant itself, not a repo-checkable code pattern |
