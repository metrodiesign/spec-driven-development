// SPIKE-1 (§15.1): SDK session observability — listSessions + getSessionMessages
// against real local data. PASS = both APIs return real session data.

import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const sessions = await listSessions({ limit: 25 });
check('listSessions returns sessions', sessions.length > 0, `${sessions.length} sessions`);

const s = sessions[0];
check(
  'session has metadata',
  Boolean(s?.sessionId && s?.lastModified),
  `id=${s?.sessionId?.slice(0, 8)}… cwd=${s?.cwd ?? '?'}`,
);

if (s?.sessionId !== undefined) {
  const msgs = await getSessionMessages(s.sessionId, {
    limit: 50,
    ...(s.cwd !== undefined ? { dir: s.cwd } : {}),
  });
  check(
    'getSessionMessages returns messages',
    msgs.length > 0,
    `${msgs.length} msgs, first type=${(msgs[0] as { type?: string } | undefined)?.type}`,
  );
} else {
  check('getSessionMessages returns messages', false, 'no session to read');
}

const verdict = results.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE1 VERDICT: ${verdict}`);
process.exit(verdict === 'PASS' ? 0 : 1);
