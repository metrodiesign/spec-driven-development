// task-gate.js — OpenCode plugin (Tier 2 harness hook).
//
// Thin adapter ONLY: it watches for edits to a .claude/specs/<feature>/tasks.md
// and delegates the actual typecheck/test/Evidence decision to the single-source
// engine in .ai/bin/gate-task.sh. No gate logic lives here — keep typecheck/test/
// Evidence policy in .ai/bin/gate-task.sh so Claude, Codex, OpenCode and CI all
// enforce byte-for-byte the same rule.
//
// Runtime: OpenCode runs plugins under Bun and injects a `$` shell tag.
//
// Engine contract: .ai/bin/gate-task.sh inspects the content it is handed (arg $2 /
// $GATE_NEW), not the file on disk. file.edited gives us only a path, so this adapter
// reads the post-edit file and feeds its content as the flip text the engine checks.
//
// Block semantics: file.edited fires AFTER the write, so unlike tool.execute.before
// it may NOT support hard-blocking the edit. This hook is therefore best-effort: it
// surfaces a red gate loudly (console.error + throw) so the agent sees it must fix
// code/Evidence before marking [x]. The hard floor is the git pre-commit Evidence
// gate (.githooks/) + CI — a [x] without green code + Evidence is still caught at
// commit/push/PR even if this in-loop hook cannot veto the write itself.
//
// NOTE: confirm the file.edited payload shape (input/output keys) against
// opencode.ai/docs/plugins — the key that carries the edited file path may differ
// by OpenCode version, so we probe the most likely shapes before giving up.
export const TaskGate = async ({ $ }) => ({
  "file.edited": async (input, output) => {
    // CONFIRM AGAINST OPENCODE PLUGIN DOCS: key holding the edited file path.
    const file =
      input?.file ??
      input?.path ??
      input?.filepath ??
      output?.file ??
      output?.path ??
      "";
    if (!file) return;

    // Only care about a spec tasks.md edit; anything else -> allow silently.
    if (!/\.claude\/specs\/.*\/tasks\.md$/.test(file)) return;

    // Delegate to the single-source engine. The engine inspects the *content* it
    // is handed (arg $2 / $GATE_NEW), not the file on disk — file.edited gives us
    // only the path, so we read the post-edit file and pass its content as the
    // flip text. The engine then re-checks the [x] flip, runs typecheck + test,
    // and requires an Evidence: block. exit 2 = red gate.
    const r = await $`GATE_NEW="$(cat ${file})" ./.ai/bin/gate-task.sh ${file}`
      .nothrow()
      .quiet();
    if (r.exitCode === 2) {
      const reason =
        r.stderr.toString().trim() || `Task gate blocked: ${file}`;
      // Best-effort surface (file.edited may not hard-block the write); the git
      // pre-commit Evidence gate + CI remain the hard floor.
      console.error(reason);
      throw new Error(reason);
    }
  },
});
