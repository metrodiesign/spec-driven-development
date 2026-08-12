#!/usr/bin/env bash
# Deterministic cross-harness contract fixture. No model calls or credentials.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EXTENSION="$REPO_ROOT/.pi/extensions/sdd-enforcement.ts"
MODE="${1:-}"
case "$MODE" in
  ""|--live) ;;
  *) echo "usage: cross-harness-conformance.test.sh [--live]" >&2; exit 2 ;;
esac

shell_pass=0
shell_fail=0
check_shell_adapter() { # $1=harness, $2=behavior, $3=adapter, $4=payload, $5=expected exit
  local harness="$1" behavior="$2" adapter="$3" payload="$4" expected="$5" output rc
  if output=$(printf '%s' "$payload" | env \
    SDD_TYPECHECK_CMD=: SDD_TEST_CMD=: SDD_GATE_NO_CACHE=1 \
    "$adapter" 2>&1); then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq "$expected" ]; then
    shell_pass=$((shell_pass + 1))
  else
    shell_fail=$((shell_fail + 1))
    echo "FAIL harness=$harness behavior=$behavior exit=$rc expected=$expected :: $output"
  fi
}

BENIGN='{"tool_input":{"command":"git status"}}'
DESTRUCTIVE='{"tool_input":{"command":"git reset --hard"}}'
BYPASS='{"tool_input":{"command":"git commit --no-verify -m x"}}'
TASK_RED=$(jq -cn --arg content $'- [x] 1. Demo\n     Evidence: TODO\n' \
  '{tool_name:"Write",tool_input:{file_path:".ai/specs/sample/tasks.md",content:$content}}')
TASK_GREEN=$(jq -cn --arg content $'- [x] 1. Demo\n     Evidence: suite passed\n' \
  '{tool_name:"Write",tool_input:{file_path:".ai/specs/sample/tasks.md",content:$content}}')

check_shell_adapter Claude destructive-allow "$REPO_ROOT/.claude/hooks/destructive-guard.sh" "$BENIGN" 0
check_shell_adapter Claude destructive-block "$REPO_ROOT/.claude/hooks/destructive-guard.sh" "$DESTRUCTIVE" 2
check_shell_adapter Claude bypass-allow "$REPO_ROOT/.claude/hooks/hook-bypass-guard.sh" "$BENIGN" 0
check_shell_adapter Claude bypass-block "$REPO_ROOT/.claude/hooks/hook-bypass-guard.sh" "$BYPASS" 2
check_shell_adapter Claude task-gate-allow "$REPO_ROOT/.claude/hooks/task-gate.sh" "$TASK_GREEN" 0
check_shell_adapter Claude task-gate-block "$REPO_ROOT/.claude/hooks/task-gate.sh" "$TASK_RED" 2

check_shell_adapter Codex guard-allow "$REPO_ROOT/.codex/hooks/guard.sh" "$BENIGN" 0
check_shell_adapter Codex destructive-block "$REPO_ROOT/.codex/hooks/guard.sh" "$DESTRUCTIVE" 2
check_shell_adapter Codex bypass-block "$REPO_ROOT/.codex/hooks/guard.sh" "$BYPASS" 2
check_shell_adapter Codex task-gate-allow "$REPO_ROOT/.codex/hooks/task-gate.sh" "$TASK_GREEN" 0
check_shell_adapter Codex task-gate-block "$REPO_ROOT/.codex/hooks/task-gate.sh" "$TASK_RED" 2

echo "shell-adapters pass=$shell_pass fail=$shell_fail"
[ "$shell_fail" -eq 0 ] || exit 1

EXTENSION="$EXTENSION" REPO_ROOT="$REPO_ROOT" node --no-warnings --experimental-strip-types --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const extensionUrl = pathToFileURL(process.env.EXTENSION).href;
const repoRoot = process.env.REPO_ROOT;
const extension = await import(`${extensionUrl}?fixture=${Date.now()}`);
const openCodeGuard = await import(`${pathToFileURL(path.join(repoRoot, ".opencode/plugins/ai-guard.js")).href}?fixture=${Date.now()}`);
const openCodeGate = await import(`${pathToFileURL(path.join(repoRoot, ".opencode/plugins/task-gate.js")).href}?fixture=${Date.now()}`);
assert.equal(typeof extension.default, "function");
assert.equal(typeof extension.createToolCallHandler, "function");
assert.equal(typeof openCodeGuard.AiGuard, "function");
assert.equal(typeof openCodeGate.TaskGate, "function");

function requireBehavior(harness, behavior, condition) {
  assert.ok(condition, `${harness}: missing ${behavior}`);
}

let registered;
extension.default({
  on(event, handler) {
    assert.equal(event, "tool_call");
    registered = handler;
  },
});
assert.equal(typeof registered, "function");

const fixture = mkdtempSync(path.join(tmpdir(), "sdd-pi-extension-"));
const outside = mkdtempSync(path.join(tmpdir(), "sdd-pi-outside-"));
const tasks = path.join(fixture, ".ai/specs/sample/tasks.md");
mkdirSync(path.dirname(tasks), { recursive: true });
const ctx = { cwd: fixture };
let passed = 0;

function runner(statuses = {}) {
  const calls = [];
  const runEngine = (name, args, env = {}) => {
    calls.push({ name, args, env });
    const value = statuses[name];
    if (value instanceof Error) return { status: null, error: value };
    return { status: value ?? 0 };
  };
  return { calls, runEngine };
}

try {
  {
    const event = { toolName: "bash", input: { command: "git status" } };
    assert.equal(await registered(event, { cwd: repoRoot }), undefined);
    assert.equal(Object.isFrozen(event.input), true);
    passed += 1;
  }

  {
    const result = await registered(
      { toolName: "bash", input: { command: "git reset --hard" } },
      { cwd: repoRoot },
    );
    assert.equal(result.block, true);
    assert.match(result.reason, /check-destructive\.sh/);
    passed += 1;
  }

  {
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const event = { toolName: "bash", input: { command: "git status" } };
    assert.equal(await handler(event, ctx), undefined);
    assert.deepEqual(mock.calls.map((call) => call.name), ["check-destructive.sh", "check-bypass.sh"]);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.input), true);
    assert.throws(() => { event.input.command = "changed after guard"; }, TypeError);
    assert.equal(event.input.command, "git status");
    passed += 1;
  }

  {
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    for (const command of [
      "printf x>.ai/specs/sample/tasks.md",
      "(printf x >.claude/specs/sample/tasks.md)",
    ]) {
      const result = await handler({ toolName: "bash", input: { command } }, ctx);
      assert.equal(result.block, true);
      assert.match(result.reason, /use Pi read, write or edit tools/);
    }
    passed += 1;
  }

  {
    const mock = runner({ "check-destructive.sh": 2 });
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({ toolName: "bash", input: { command: "blocked command" } }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /check-destructive\.sh/);
    assert.equal(mock.calls.length, 1);
    passed += 1;
  }

  {
    const mock = runner({ "check-bypass.sh": new Error("spawn failed") });
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({ toolName: "bash", input: { command: "git status" } }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /execution error/);
    passed += 1;
  }

  {
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "bash",
      input: { command: "grep -n demo .ai/specs/sample/tasks.md" },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /use Pi read, write or edit tools/);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [ ] 1. Demo\n");
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const event = { toolName: "write", input: { path: tasks, content: "- [ ] 1. Still open\n" } };
    assert.equal(await handler(event, ctx), undefined);
    assert.equal(mock.calls.length, 0);
    assert.equal(Object.isFrozen(event.input), true);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [x] 1. Old\n     Evidence: passed\n- [ ] 2. New\n");
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const proposed = "- [ ] 1. Old\n- [x] 2. New\n     Evidence: passed\n";
    assert.equal(await handler({ toolName: "write", input: { path: tasks, content: proposed } }, ctx), undefined);
    assert.equal(mock.calls.some((call) => call.name === "gate-task.sh"), true);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [ ] 1. Demo\n     Evidence: TODO\n");
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const proposed = "- [x] 1. Demo\n     Evidence: test passed\n";
    const event = { toolName: "write", input: { path: tasks, content: proposed } };
    assert.equal(await handler(event, ctx), undefined);
    const gate = mock.calls.find((call) => call.name === "gate-task.sh");
    assert.equal(gate.args[1], proposed);
    assert.equal(gate.env.SDD_GATE_NO_CACHE, "1");
    assert.equal(Object.isFrozen(event), true);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [ ] 1. Demo\n");
    const mock = runner({ "gate-task.sh": 2 });
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "write",
      input: { path: tasks, content: "- [x] 1. Demo\n" },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /gate-task\.sh/);
    passed += 1;
  }

  {
    const original = "- [ ] 1. Demo\r\n     Evidence: TODO\r\n";
    writeFileSync(tasks, original);
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const event = {
      toolName: "edit",
      input: {
        path: tasks,
        edits: [
          { oldText: "- [ ] 1. Demo", newText: "- [x] 1. Demo" },
          { oldText: "Evidence: TODO", newText: "Evidence: test passed" },
        ],
      },
    };
    assert.equal(await handler(event, ctx), undefined);
    const gate = mock.calls.find((call) => call.name === "gate-task.sh");
    assert.match(gate.args[1], /- \[x\] 1\. Demo\n     Evidence: test passed/);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [ ] 1. Demo\nTODO\nTODO\n");
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "edit",
      input: { path: tasks, edits: [{ oldText: "TODO", newText: "done" }] },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /unique/);
    assert.equal(mock.calls.length, 0);
    passed += 1;
  }

  {
    writeFileSync(tasks, "- [ ] 1. Demo\n");
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "edit",
      input: {
        path: tasks,
        edits: [
          { oldText: "- [ ] 1. Demo", newText: "- [x] 1. Demo" },
          { oldText: "1. Demo", newText: "1. Changed" },
        ],
      },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /overlap/);
    passed += 1;
  }

  {
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "write",
      input: { path: "../outside.txt", content: "x" },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /outside repository root/);
    passed += 1;
  }

  {
    symlinkSync(outside, path.join(fixture, "linked-outside"));
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "write",
      input: { path: "linked-outside/file.txt", content: "x" },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /outside repository root/);
    passed += 1;
  }

  {
    symlinkSync(path.join(outside, "not-created"), path.join(fixture, "dangling-outside"));
    const mock = runner();
    const handler = extension.createToolCallHandler({ repoRoot: fixture, runEngine: mock.runEngine });
    const result = await handler({
      toolName: "write",
      input: { path: "dangling-outside", content: "x" },
    }, ctx);
    assert.equal(result.block, true);
    assert.match(result.reason, /ENOENT|realpath/);
    passed += 1;
  }

  {
    const matrix = readFileSync(path.join(repoRoot, ".ai/README.md"), "utf8");
    const adapter = readFileSync(path.join(repoRoot, ".ai/agents/pi/AGENT.md"), "utf8");
    assert.match(matrix, /Subagents \(fresh-context personas\).*\| unsupported; route to another harness/);
    assert.match(matrix, /MCP browser-verify.*\| unsupported; route to another harness/);
    for (const capability of ["fresh-context subagent", "MCP/browser"]) {
      assert.match(adapter, new RegExp(`stop the Pi path[\\s\\S]{0,160}${capability}`));
      assert.match(adapter, new RegExp(`${capability}[\\s\\S]{0,180}hand off to Claude Code, Codex or OpenCode`));
    }
    passed += 1;
  }

  {
    const calls = [];
    const shell = (strings, ...values) => {
      const [engine, command] = values;
      requireBehavior("OpenCode", "canonical guard engine path", strings.join("{}").includes("./.ai/bin/{}.sh"));
      requireBehavior("OpenCode", "guard engine name", ["check-destructive", "check-bypass"].includes(engine));
      calls.push(engine);
      const result = spawnSync(path.join(repoRoot, ".ai/bin", `${engine}.sh`), [command], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return {
        nothrow() { return this; },
        quiet() {
          return { exitCode: result.status, stderr: Buffer.from(result.stderr ?? "") };
        },
      };
    };
    const hooks = await openCodeGuard.AiGuard({ $: shell });
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "git status" } });
    assert.deepEqual(calls, ["check-destructive", "check-bypass"]);
    passed += 1;
  }

  {
    const shell = (strings, ...values) => {
      const [engine, command] = values;
      const result = spawnSync(path.join(repoRoot, ".ai/bin", `${engine}.sh`), [command], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return {
        nothrow() { return this; },
        quiet() {
          return { exitCode: result.status, stderr: Buffer.from(result.stderr ?? "") };
        },
      };
    };
    const hooks = await openCodeGuard.AiGuard({ $: shell });
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "git reset --hard" } }),
      /Blocked/,
    );
    passed += 1;
  }

  {
    const shell = (strings, ...values) => {
      requireBehavior("OpenCode", "canonical task-gate engine path", strings.join("{}").includes("./.ai/bin/gate-task.sh"));
      const file = values.at(-1);
      const result = spawnSync(path.join(repoRoot, ".ai/bin/gate-task.sh"), [file, readFileSync(file, "utf8")], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SDD_TYPECHECK_CMD: ":",
          SDD_TEST_CMD: ":",
          SDD_GATE_NO_CACHE: "1",
        },
      });
      return {
        nothrow() { return this; },
        quiet() {
          return { exitCode: result.status, stderr: Buffer.from(result.stderr ?? "") };
        },
      };
    };
    const hooks = await openCodeGate.TaskGate({ $: shell });
    writeFileSync(tasks, "- [x] 1. Demo\n     Evidence: suite passed\n");
    await hooks["file.edited"]({ file: tasks }, {});
    writeFileSync(tasks, "- [x] 1. Demo\n     Evidence: TODO\n");
    const originalError = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => hooks["file.edited"]({ file: tasks }, {}), /Task gate|Evidence/);
    } finally {
      console.error = originalError;
    }
    passed += 2;
  }

  {
    const codexConfig = readFileSync(path.join(repoRoot, ".codex/config.toml"), "utf8");
    const openCodeConfig = JSON.parse(readFileSync(path.join(repoRoot, "opencode.json"), "utf8"));
    const codexPin = codexConfig.match(/chrome-devtools-mcp@([^"\]]+)/)?.[1];
    const openCodeToken = openCodeConfig.mcp["chrome-devtools"].command.find((token) =>
      token.startsWith("chrome-devtools-mcp@"),
    );
    const openCodePin = openCodeToken?.split("@").at(-1);
    assert.equal(codexPin, "1.7.0");
    assert.equal(openCodePin, codexPin);
    assert.doesNotMatch(codexPin, /latest|[xX*^~]/);

    for (const harness of ["claude", "codex", "opencode", "pi"]) {
      const adapter = readFileSync(path.join(repoRoot, `.ai/agents/${harness}/AGENT.md`), "utf8");
      assert.match(adapter, /13\. `\.\.\/\.\.\/shared\/stack\/` — optional stack-specific profiles/);
      assert.doesNotMatch(adapter, /stack\/nextjs\.md|chrome-devtools-mcp@/);
    }
    passed += 1;
  }

  {
    const phases = [
      "spec-new",
      "spec-requirements",
      "spec-analyze",
      "spec-design",
      "spec-tasks",
      "spec-quick",
      "spec-implement",
      "spec-bugfix",
      "spec-pbt",
      "spec-retro",
      "spec-sync-github",
    ];
    for (const phase of phases) {
      requireBehavior("Claude", `${phase} skill`, existsSync(path.join(repoRoot, `.claude/skills/${phase}/SKILL.md`)));
      requireBehavior("Codex", `${phase} skill`, existsSync(path.join(repoRoot, `.agents/skills/${phase}/SKILL.md`)));
      requireBehavior("OpenCode", `${phase} command`, existsSync(path.join(repoRoot, `.opencode/commands/${phase}.md`)));
      requireBehavior("Pi", `${phase} skill`, existsSync(path.join(repoRoot, `.agents/skills/${phase}/SKILL.md`)));
    }

    const claudeFrontDoor = readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8");
    const neutralFrontDoor = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    requireBehavior("Claude", "adapter discovery", claudeFrontDoor.includes(".ai/agents/claude/AGENT.md"));
    for (const harness of ["codex", "opencode", "pi"]) {
      requireBehavior(harness, "adapter discovery", neutralFrontDoor.includes(`.ai/agents/${harness}/AGENT.md`));
    }

    const roles = ["spec-architect", "bug-investigator", "pbt-runner"];
    for (const role of roles) {
      requireBehavior("Claude", `${role} subagent`, existsSync(path.join(repoRoot, `.claude/agents/${role}.md`)));
      requireBehavior("Codex", `${role} subagent`, existsSync(path.join(repoRoot, `.codex/agents/${role}.toml`)));
      requireBehavior("OpenCode", `${role} subagent`, existsSync(path.join(repoRoot, `.opencode/agents/${role}.md`)));
    }

    const claudeSettings = JSON.parse(readFileSync(path.join(repoRoot, ".claude/settings.json"), "utf8"));
    const claudeCommands = JSON.stringify(claudeSettings.hooks);
    requireBehavior("Claude", "destructive guard wiring", claudeCommands.includes("destructive-guard.sh"));
    requireBehavior("Claude", "bypass guard wiring", claudeCommands.includes("hook-bypass-guard.sh"));
    requireBehavior("Claude", "task gate wiring", claudeCommands.includes("task-gate.sh"));
    const codexConfig = readFileSync(path.join(repoRoot, ".codex/config.toml"), "utf8");
    requireBehavior("Codex", "guard wiring", codexConfig.includes('command = ".codex/hooks/guard.sh"'));
    requireBehavior("Codex", "task gate wiring", codexConfig.includes('command = ".codex/hooks/task-gate.sh"'));
    passed += 1;
  }

  assert.equal(readFileSync(tasks, "utf8").length > 0, true);
  console.log(`node-conformance pass=${passed} fail=0`);
} finally {
  const prefix = `${tmpdir()}${path.sep}sdd-pi-`;
  for (const target of [fixture, outside]) {
    if (!target.startsWith(prefix)) throw new Error(`refuse cleanup outside fixture prefix: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
}
NODE

if [ "$MODE" = "--live" ]; then
  live_fail=0
  while IFS='|' read -r harness command adapter; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "live harness=$harness version=unavailable adapter=$adapter discovery=missing"
      live_fail=1
      continue
    fi
    if version=$("$command" --version 2>&1); then
      version="${version%%$'\n'*}"
    else
      version="version-error"
      live_fail=1
    fi
    if [ -r "$REPO_ROOT/$adapter" ]; then
      discovery=present
    else
      discovery=missing
      live_fail=1
    fi
    echo "live harness=$harness version=$version adapter=$adapter discovery=$discovery"
  done <<'HARNESSES'
Claude|claude|.ai/agents/claude/AGENT.md
Codex|codex|.ai/agents/codex/AGENT.md
OpenCode|opencode|.ai/agents/opencode/AGENT.md
Pi|pi|.ai/agents/pi/AGENT.md
HARNESSES

  if command -v pi >/dev/null 2>&1; then
    PI_REAL=$(node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v pi)")
    PI_INDEX="$(dirname "$PI_REAL")/index.js"
    if PI_INDEX="$PI_INDEX" REPO_ROOT="$REPO_ROOT" EXTENSION="$EXTENSION" node --input-type=module <<'NODE'; then
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const agentDir = mkdtempSync(path.join(tmpdir(), "sdd-pi-live-"));
try {
  const { discoverAndLoadExtensions } = await import(pathToFileURL(process.env.PI_INDEX).href);
  const result = await discoverAndLoadExtensions([], process.env.REPO_ROOT, agentDir);
  const target = result.extensions.find((item) => path.resolve(item.path) === path.resolve(process.env.EXTENSION));
  assert.ok(target, "Pi: project extension not discovered from repository root");
  assert.equal(target.handlers.has("tool_call"), true, "Pi: tool_call handler not registered");
  assert.equal(result.errors.some((item) => path.resolve(item.path) === path.resolve(process.env.EXTENSION)), false);
  console.log(`live harness=Pi loader=project-root extension=${path.relative(process.env.REPO_ROOT, target.path)} handler=tool_call`);
} finally {
  const prefix = path.join(tmpdir(), "sdd-pi-live-");
  if (!agentDir.startsWith(prefix)) throw new Error(`refuse cleanup outside live-probe prefix: ${agentDir}`);
  rmSync(agentDir, { recursive: true, force: true });
}
NODE
      :
    else
      echo "live harness=Pi loader=failed" >&2
      live_fail=1
    fi
  fi
  [ "$live_fail" -eq 0 ] || exit 1
fi
