---
name: merge-pr
description: Merge a reviewed, CI-green PR (squash, this repo's convention) and run the sync-branch cleanup in one shot. Use when the user says "merge PR #N", "merge เข้า develop", or wants merge+cleanup together instead of merging via GitHub UI and telling Claude afterward.
argument-hint: <pr-number>
---

# Merge PR + sync

Combines merging a PR with the [sync-branch](../sync-branch/SKILL.md) post-merge
cleanup — composition, not duplication: this skill only does the merge; step 3 hands
off to sync-branch's existing steps for everything after.

## Steps

1. **Verify CI is green** (CLAUDE.md CI Gate rules: ห้าม merge ข้าม failing check):
   ```sh
   env -u GH_TOKEN gh pr checks <n>
   env -u GH_TOKEN gh pr view <n> --json reviewDecision,mergeable
   ```
   Stop and report if any required check is failing/pending, `mergeable` is not
   `MERGEABLE`, or there's an unresolved `CHANGES_REQUESTED` review — do not merge.

2. **Merge (squash) + delete the remote branch in one call:**
   ```sh
   env -u GH_TOKEN gh pr merge <n> --squash --delete-branch
   ```
   `--delete-branch` deletes the remote branch via the GitHub API as part of the merge
   call — this is **not** `git push`, so `destructive-guard.sh` never sees it regardless
   of the current local branch.

3. **Hand off to sync-branch**: run `.claude/skills/sync-branch/SKILL.md` steps 1-5 for
   this same PR number. Its own checks degrade to safe no-ops here — step 1's merge
   check trivially passes (just merged in step 2 above), step 4's remote-branch check
   trivially finds it already gone (`--delete-branch` already removed it).

4. **Report**: merge sha, base branch synced sha, local branch deleted (y/n).

## Guardrails

- Never merge with a failing or pending required check, or an unresolved
  changes-requested review — that CI/review state is the actual safety gate here, not
  anything git-side.
- This performs a real merge to `develop`/`main` — only run for a PR number the user
  explicitly named; invoking this skill by name is the authorization for that merge.
