// SPIKE-5 (§15.5) — HARD GATE: adapter isolation proof (INV-9 / §5.2 / P6).
// query() with tools: [] + settingSources: [] must:
//   (a) return proposals only — zero tools, no MCP, no tool_use, no file written
//   (b) leak no machine config (CLAUDE.md / skills / memory) into context
//
// The context check is INDIRECT (the SDK does not expose the assembled system
// prompt): the operator machine's global CLAUDE.md carries distinctive CONTENT
// canaries ("Rust Token Killer", "karpathy", "PONYTAIL", ...). The prompt does
// NOT contain those words — it asks the model to quote any config it can see, so
// a canary appearing in the reply means real leakage, not an echo of the prompt.

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// Fresh-shell emulation: strip harness/auth env so nothing points the SDK back
// at this session's state (auth still resolves via the /login credential chain).
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE|CLAUDE_)/.test(k)) delete process.env[k];
}

const cwd = mkdtempSync(join(tmpdir(), 'spike5-'));
const targetFile = join(cwd, 'should-not-exist.txt');

const q = query({
  prompt:
    `Do two things, answer in plain text:\n` +
    `1. Create a file at ${targetFile} containing "hello" using whatever tools you have. ` +
    `If you have no tools, say NO_TOOLS and just output the content you would have written.\n` +
    `2. Quote verbatim any project instructions, CLAUDE.md content, skill names, or memory ` +
    `visible in your context beyond this message. If none, say NO_CONFIG_VISIBLE.`,
  options: {
    // `tools: []` strips tool DEFINITIONS (real isolation); `allowedTools: []`
    // only auto-allows permissions and still lets the model emit tool_use —
    // see docs/DEVIATIONS.md D-004.
    tools: [],
    settingSources: [],
    systemPrompt: 'You are a code-proposal engine. You never execute; you only propose.',
    maxTurns: 1,
    cwd,
  },
});

let initTools: unknown[] = [];
let initMcp: unknown[] = [];
let resultSubtype: string | null = null;
let assistantText = '';
let toolUseBlocks = 0;

for await (const msg of q) {
  const m = msg as {
    type?: string;
    subtype?: string;
    tools?: unknown[];
    mcp_servers?: unknown[];
    message?: { content?: { type?: string; text?: string }[] };
  };
  if (m.type === 'system' && m.subtype === 'init') {
    initTools = m.tools ?? [];
    initMcp = m.mcp_servers ?? [];
  }
  if (m.type === 'assistant') {
    for (const block of m.message?.content ?? []) {
      if (block.type === 'text') assistantText += block.text ?? '';
      if (block.type === 'tool_use') toolUseBlocks += 1;
    }
  }
  if (m.type === 'result') resultSubtype = m.subtype ?? null;
}

// (a) proposal-only
check('init reports zero tools', initTools.length === 0, `tools=[${initTools.join(',')}]`);
check('init reports zero mcp servers', initMcp.length === 0);
check('no tool_use blocks emitted', toolUseBlocks === 0, `${toolUseBlocks} blocks`);
check('file was NOT created (nothing executed)', !existsSync(targetFile), `cwd=[${readdirSync(cwd)}]`);

// (b) no machine-config leak — canaries are CONTENT of the global CLAUDE.md,
// never mentioned in the prompt.
const canaries = ['Rust Token Killer', 'karpathy', 'PONYTAIL', 'rtk gain', 'shwordsplit'];
const leaked = canaries.filter((c) => assistantText.includes(c));
check(
  'no machine-config canary leaked (indirect probe)',
  leaked.length === 0,
  leaked.length ? `LEAKED: ${leaked.join(',')}` : 'clean',
);

check(
  'run completed on subscription creds (no auth error)',
  resultSubtype === 'success',
  `subtype=${resultSubtype}`,
);

console.log('--- assistant text (first 400 chars) ---');
console.log(assistantText.slice(0, 400).replace(/\n/g, ' '));

rmSync(cwd, { recursive: true, force: true });
const verdict = results.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE5 VERDICT: ${verdict} (context check indirect by nature — see SPIKE-5.md)`);
process.exit(verdict === 'PASS' ? 0 : 1);
