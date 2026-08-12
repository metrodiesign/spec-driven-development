import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = realpathSync(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const DONE_LINE = /^[\t ]*-[\t ]+\[[xX]\]/;
const TASKS_IN_BASH = /\.(?:ai|claude)\/specs\/[^\/\s"';&|<>]+\/tasks\.md/;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pathEntryExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function nearestExistingParent(candidate) {
  let current = candidate;
  while (!pathEntryExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("no existing parent");
    current = parent;
  }
  return current;
}

function resolveInRepo(repoRoot, cwd, rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("missing tool path");
  }

  const normalizedInput = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const lexical = path.resolve(cwd, normalizedInput);
  const existing = nearestExistingParent(lexical);
  const realExisting = realpathSync(existing);
  if (!inside(repoRoot, realExisting)) throw new Error("path resolves outside repository root");

  const resolved = pathEntryExists(lexical)
    ? realpathSync(lexical)
    : path.join(realExisting, path.relative(existing, lexical));
  if (!inside(repoRoot, resolved)) throw new Error("path resolves outside repository root");
  return resolved;
}

function repoRelative(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function isSpecTasksPath(relativePath) {
  return /^(?:\.ai|\.claude)\/specs\/[^/]+\/tasks\.md$/.test(relativePath);
}

function normalizeLf(value) {
  return value.replace(/\r\n?/g, "\n");
}

function hasNewDone(before, proposed) {
  const remaining = new Map();
  for (const line of normalizeLf(before).split("\n").filter((item) => DONE_LINE.test(item))) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  for (const line of normalizeLf(proposed).split("\n").filter((item) => DONE_LINE.test(item))) {
    const count = remaining.get(line) ?? 0;
    if (count === 0) return true;
    remaining.set(line, count - 1);
  }
  return false;
}

function reconstructEdit(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error("edit requires at least one replacement");
  }

  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const base = normalizeLf(bom ? original.slice(1) : original);
  const matches = edits.map((edit) => {
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error("invalid edit replacement");
    }
    const oldText = normalizeLf(edit.oldText);
    if (oldText.length === 0) throw new Error("oldText must not be empty");
    const index = base.indexOf(oldText);
    if (index < 0) throw new Error("oldText requires exact match");
    if (base.indexOf(oldText, index + oldText.length) >= 0) {
      throw new Error("oldText must be unique");
    }
    return {
      index,
      end: index + oldText.length,
      newText: normalizeLf(edit.newText),
    };
  });

  const ordered = [...matches].sort((a, b) => a.index - b.index);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].index < ordered[index - 1].end) {
      throw new Error("edit replacements overlap");
    }
  }

  let result = base;
  for (const match of [...matches].sort((a, b) => b.index - a.index)) {
    result = result.slice(0, match.index) + match.newText + result.slice(match.end);
  }
  return bom + result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function freezeCall(event) {
  deepFreeze(event.input);
  Object.freeze(event);
}

function defaultRunEngine(repoRoot, name, args, extraEnv = {}) {
  const result = spawnSync(path.join(repoRoot, ".ai", "bin", name), args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { status: result.status, error: result.error };
}

function blocked(engine, result) {
  const status = Number.isInteger(result?.status) ? `exit ${result.status}` : "execution error";
  return { block: true, reason: `Blocked by .ai/bin/${engine} (${status})` };
}

export function createToolCallHandler(options = {}) {
  const repoRoot = realpathSync(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const runEngine = options.runEngine ?? ((name, args, env) => defaultRunEngine(repoRoot, name, args, env));
  const readFile = options.readFile ?? ((file) => readFileSync(file, "utf8"));

  return async function handleToolCall(event, ctx) {
    if (event?.toolName === "bash") {
      const command = event.input?.command;
      if (typeof command !== "string" || command.length === 0) {
        return { block: true, reason: "Blocked Pi bash call with missing command" };
      }
      for (const engine of ["check-destructive.sh", "check-bypass.sh"]) {
        const result = runEngine(engine, [command]);
        if (result?.error || result?.status !== 0) return blocked(engine, result);
      }
      if (TASKS_IN_BASH.test(command)) {
        return {
          block: true,
          reason: "Blocked shell access to spec tasks.md; use Pi read, write or edit tools",
        };
      }
      freezeCall(event);
      return undefined;
    }

    if (event?.toolName !== "write" && event?.toolName !== "edit") return undefined;

    let absolutePath;
    try {
      absolutePath = resolveInRepo(repoRoot, ctx.cwd, event.input?.path);
    } catch (error) {
      return { block: true, reason: `Blocked Pi ${event.toolName}: ${error.message}` };
    }

    const relativePath = repoRelative(repoRoot, absolutePath);
    if (!isSpecTasksPath(relativePath)) {
      freezeCall(event);
      return undefined;
    }

    let before = "";
    let proposed;
    try {
      if (existsSync(absolutePath)) before = readFile(absolutePath);
      proposed = event.toolName === "write"
        ? event.input?.content
        : reconstructEdit(before, event.input?.edits);
      if (typeof proposed !== "string") throw new Error("missing proposed content");
    } catch (error) {
      return { block: true, reason: `Blocked Pi ${event.toolName}: ${error.message}; use write` };
    }

    if (hasNewDone(before, proposed)) {
      const result = runEngine(
        "gate-task.sh",
        [relativePath, proposed],
        { SDD_GATE_NO_CACHE: "1" },
      );
      if (result?.error || result?.status !== 0) return blocked("gate-task.sh", result);
    }

    freezeCall(event);
    return undefined;
  };
}

export default function sddEnforcement(pi) {
  pi.on("tool_call", createToolCallHandler());
}
