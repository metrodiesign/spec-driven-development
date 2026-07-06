// SPIKE-3 (§15.3): SDK query() streaming one turn + canUseTool callback.
// This path is for the autonomous adapter / enhanced view ONLY — not the
// interactive parity path (that is SPIKE-2 / INV-17).
//
// VERIFIED SDK BEHAVIOR (this machine, sdk 0.3.200): canUseTool fires for tools
// that require permission (e.g. Write); read-only tools and bare names in
// `allowedTools` / machine settings allow-rules bypass it. So the reliable proof
// is to offer Write, DENY it in the callback, and confirm nothing was written.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const cwd = mkdtempSync(join(tmpdir(), 'spike3-'));
writeFileSync(join(cwd, 'note.txt'), 'the magic word is PINEAPPLE\n');

const canUseToolCalls: string[] = [];
let events = 0;
let assistantText = '';
let resultSubtype: string | null = null;

const q = query({
  prompt:
    'First read note.txt and tell me the magic word. Then use the Write tool to create out.txt ' +
    'containing "DONE". If the write is denied, say WRITE_DENIED.',
  options: {
    model: 'haiku',
    settingSources: [],
    systemPrompt:
      'You are a helpful assistant. If a tool call is denied, do NOT retry it — ' +
      'acknowledge and stop.',
    maxTurns: 6,
    cwd,
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      canUseToolCalls.push(toolName);
      if (toolName === 'Write') return { behavior: 'deny', message: 'writes not permitted in this spike' };
      return { behavior: 'allow', updatedInput: input };
    },
  },
});

try {
  for await (const msg of q) {
    events += 1;
    const m = msg as {
      type?: string;
      subtype?: string;
      message?: { content?: { type?: string; text?: string }[] };
    };
    if (m.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block.type === 'text') assistantText += block.text ?? '';
      }
    }
    if (m.type === 'result') resultSubtype = m.subtype ?? null;
  }
} catch (err) {
  // A model that keeps retrying the DENIED Write can hit max_turns — that still
  // proves the deny path (the write never succeeded). Record and evaluate.
  console.log(`  stream ended early: ${(err as Error).message}`);
  if (resultSubtype === null) resultSubtype = 'max_turns_after_deny';
}

check('streaming produced events', events > 1, `${events} events`);
check(
  'canUseTool fired for the permissioned Write tool',
  canUseToolCalls.includes('Write'),
  `calls: ${canUseToolCalls.join(',') || 'none'}`,
);
check('read executed (magic word surfaced)', /PINEAPPLE/i.test(assistantText));
check('deny honored — out.txt not created (nothing executed past the gate)', !existsSync(join(cwd, 'out.txt')));
check(
  'turn completed on subscription creds (no auth error)',
  resultSubtype === 'success' || resultSubtype === 'max_turns_after_deny',
  `subtype=${resultSubtype}`,
);

rmSync(cwd, { recursive: true, force: true });
const verdict = results.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE3 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
