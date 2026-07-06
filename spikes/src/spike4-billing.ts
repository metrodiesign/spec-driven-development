// SPIKE-4 (§15.4): subscription billing proof — with ALL auth env vars
// stripped, a query() turn must still succeed via the `/login` credential
// chain (INV-12). Quota movement in the official /usage UI is a HUMAN check:
// this script records the automatable part and SPIKE-4.md marks the manual
// remainder — never claimed automatically.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const results: boolean[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const STRIPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !STRIPPED.includes(k)) cleanEnv[k] = v;
}
check('auth env vars stripped for child', STRIPPED.every((k) => cleanEnv[k] === undefined));

// Credential storage is platform-specific: macOS Keychain ("Claude Code-
// credentials"), else ~/.claude/.credentials.json. We check EXISTENCE only,
// never the value (INV-12).
function credentialPresent(): boolean {
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return existsSync(join(homedir(), '.claude', '.credentials.json'));
    }
  }
  return existsSync(join(homedir(), '.claude', '.credentials.json'));
}
check('subscription credential present (existence only, never read)', credentialPresent());

// Run spike-3 (one tiny denied-tool turn) in the cleaned environment.
let childOk = false;
let tail = '';
try {
  const out = execFileSync(process.execPath, [join(import.meta.dirname, 'spike3-query.ts')], {
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 180_000,
  });
  tail = out.trim().split('\n').slice(-2).join(' | ');
  childOk = out.includes('SPIKE3 VERDICT: PASS');
} catch (err) {
  tail = String((err as { stdout?: string }).stdout ?? (err as Error).message).slice(-300);
}
check('query() succeeded with NO auth env vars (login chain used)', childOk, tail);

console.log(
  'MANUAL STEP REMAINING: open /usage in the CLI before+after and confirm the Max quota moved ' +
    'and no API bill appeared — record in docs/spikes/SPIKE-4.md.',
);
const verdict = results.every(Boolean) ? 'PASS' : 'FAIL';
console.log(`SPIKE4 VERDICT: ${verdict} (automated subset — quota movement is the manual step)`);
process.exit(verdict === 'PASS' ? 0 : 1);
