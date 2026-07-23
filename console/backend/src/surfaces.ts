// Console governance surfaces — pure logic (spec §8 "Console additions";
// REQ-12/13/14/15). The two-step consent token, the hook/MCP/frontmatter
// validators, the exact JSON-diff preview, and the retention-prune preview live
// here (unit-tested); app.ts wires them to routes through the shared writeSafe.
// Data-loss prevention (consent gate, optimistic concurrency) is a hard
// requirement — never simplified away.

import { sha256 } from './govern.ts';

const MAX_LCS_CELLS = 1_000_000;

/**
 * Two-step consent token (REQ-13.1, AZ-12): sha256 of the target file's baseHash
 * concatenated with the proposed content, so a MOVED base OR changed content
 * invalidates the token. Step 2 must echo this exact value.
 */
export function confirmToken(baseHash: string | null, content: string): string {
  return sha256(`${baseHash ?? ''}\n${content}`);
}

/**
 * Exact line-level diff preview (REQ-13.1/13.2): the lines that leave and the lines
 * that arrive. Deterministic, so the previewed diff IS the applied diff.
 */
export function jsonDiffPreview(before: string, after: string): { removed: string[]; added: string[] } {
  const b = before.split('\n');
  const a = after.split('\n');
  if (before === after) return { removed: [], added: [] };
  // Hook content is request-controlled. Bound the quadratic LCS matrix; a full
  // replacement remains exact and conservative when a minimal diff is too costly.
  const columns = a.length + 1;
  const cells = (b.length + 1) * columns;
  if (cells > MAX_LCS_CELLS) return { removed: b, added: a };
  const lcs = new Uint32Array(cells);

  for (let i = b.length - 1; i >= 0; i -= 1) {
    for (let j = a.length - 1; j >= 0; j -= 1) {
      const cell = i * columns + j;
      const below = cell + columns;
      lcs[cell] = b[i] === a[j] ? lcs[below + 1]! + 1 : Math.max(lcs[below]!, lcs[cell + 1]!);
    }
  }

  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < b.length && j < a.length) {
    if (b[i] === a[j]) {
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * columns + j]! >= lcs[i * columns + j + 1]!) {
      removed.push(b[i]!);
      i += 1;
    } else {
      added.push(a[j]!);
      j += 1;
    }
  }
  removed.push(...b.slice(i));
  added.push(...a.slice(j));
  return { removed, added };
}

/** Hook events the builder accepts (REQ-13.1). Unknown event names are refused. */
export const HOOK_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'Notification', 'UserPromptSubmit',
  'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact',
]);
// Claude Code's hook handler type. The builder validates SHAPE, not vendor behavior;
// widen this set if the CLI grows handler types. ponytail: one real type today.
const HANDLER_TYPES = new Set(['command']);

/** Validate a settings.json `hooks` block (REQ-13.1). Returns an error string or null. */
export function validateHookConfig(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return `invalid JSON: ${(e as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null) return 'settings must be a JSON object';
  const hooks = (parsed as Record<string, unknown>)['hooks'];
  if (hooks === undefined) return null; // no hooks block = nothing to install, still valid
  if (typeof hooks !== 'object' || hooks === null) return 'hooks must be an object keyed by event';
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!HOOK_EVENTS.has(event)) return `unknown hook event: ${event}`;
    if (!Array.isArray(groups)) return `hooks.${event} must be an array`;
    for (const g of groups) {
      if (typeof g !== 'object' || g === null) return `hooks.${event} entries must be objects`;
      const list = (g as Record<string, unknown>)['hooks'];
      if (!Array.isArray(list)) return `hooks.${event}[].hooks must be an array`;
      for (const h of list) {
        if (typeof h !== 'object' || h === null) return `hooks.${event}[].hooks entries must be objects`;
        const type = (h as Record<string, unknown>)['type'];
        if (typeof type !== 'string' || !HANDLER_TYPES.has(type)) return `unsupported handler type: ${String(type)}`;
        if (type === 'command' && typeof (h as Record<string, unknown>)['command'] !== 'string') {
          return 'a command handler requires a string "command"';
        }
      }
    }
  }
  return null;
}

/** Validate an MCP config (REQ-12.4). A stdio entry needs `command`; an http entry needs `url`. */
export function validateMcpConfig(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return `invalid JSON: ${(e as Error).message}`;
  }
  if (typeof parsed !== 'object' || parsed === null) return 'mcp config must be a JSON object';
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === undefined) return null;
  if (typeof servers !== 'object' || servers === null) return 'mcpServers must be an object';
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) return `server ${name} must be an object`;
    const e = entry as Record<string, unknown>;
    if (typeof e['command'] !== 'string' && typeof e['url'] !== 'string') {
      return `server ${name} must have a stdio "command" or an http "url"`;
    }
  }
  return null;
}

export interface SubagentFrontmatter {
  name: string;
  description: string;
  tools: string;
  body: string;
}

/**
 * Parse + validate a subagent `.md` (REQ-14.1): the YAML frontmatter must carry
 * name/description/tools; the markdown body is returned verbatim.
 */
export function validateSubagentFrontmatter(
  content: string,
): { ok: true; parsed: SubagentFrontmatter } | { ok: false; error: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (m === null) return { ok: false, error: 'missing YAML frontmatter (--- … ---)' };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1] as string] = (kv[2] ?? '').trim();
  }
  for (const req of ['name', 'description', 'tools'] as const) {
    if (fields[req] === undefined || fields[req] === '') return { ok: false, error: `frontmatter missing "${req}"` };
  }
  return {
    ok: true,
    parsed: {
      name: fields['name'] as string,
      description: fields['description'] as string,
      tools: fields['tools'] as string,
      body: m[2] ?? '',
    },
  };
}

/** Retention prune preview (REQ-15.3): which transcript files a prune WOULD delete. */
export function retentionPreview(
  files: { path: string; mtimeMs: number }[],
  cleanupPeriodDays: number,
  nowMs: number,
): string[] {
  const cutoff = nowMs - cleanupPeriodDays * 24 * 60 * 60 * 1000;
  return files.filter((f) => f.mtimeMs < cutoff).map((f) => f.path).sort();
}
