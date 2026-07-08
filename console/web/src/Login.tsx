// Login view (REQ-19): Basic-only for now (task 10 — OIDC arrives in task 11).
// Password only, no username: there is exactly one operator (INV-15). On
// success a full reload re-runs App's auth probe under the new session cookie.

import { useState } from 'react';

import { interpretLoginResponse } from './logic/auth.ts';

export function Login(): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const outcome = interpretLoginResponse(res.status, await res.json());
      if (outcome.ok) {
        window.location.reload();
        return;
      }
      setError(outcome.error);
    } catch {
      setError('network error — try again');
    } finally {
      setPending(false);
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: '4rem auto', padding: '1rem', fontFamily: 'system-ui' }}>
      <h1>Platform Console</h1>
      <form onSubmit={(e) => void submit(e)} aria-label="Login">
        <p>
          <label>
            Password{' '}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              style={{ width: '100%' }}
            />
          </label>
        </p>
        {error !== null && (
          <p role="alert" style={{ color: '#b30000' }}>
            {error}
          </p>
        )}
        <p>
          <button type="submit" disabled={pending || password.length === 0}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </p>
      </form>
    </main>
  );
}
