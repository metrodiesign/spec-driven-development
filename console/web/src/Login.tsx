// Login view (REQ-19/20). Password only, no username: there is exactly one
// operator (INV-15). Which form renders depends on the active provider (REQ-20):
// Basic shows the password form; OIDC shows a Google sign-in link that
// navigates (full page load, not fetch) into the redirect-based flow. On
// success a full reload re-runs App's auth probe under the new session cookie.

import { useEffect, useState } from 'react';

import { interpretLoginResponse, interpretProviderProbe, type ProviderKind } from './logic/auth.ts';

export function Login(): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [kind, setKind] = useState<ProviderKind>('basic');

  useEffect(() => {
    let alive = true;
    fetch('/auth/provider')
      .then((r) => r.json().then((body: { kind?: string }) => interpretProviderProbe(r.status, body)))
      .then((k) => {
        if (alive) setKind(k);
      })
      .catch(() => {
        /* stays 'basic' — a network hiccup shouldn't dead-end the login view */
      });
    return () => {
      alive = false;
    };
  }, []);

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

  if (kind === 'oidc') {
    return (
      <main style={{ maxWidth: 360, margin: '4rem auto', padding: '1rem', fontFamily: 'system-ui' }}>
        <h1>Platform Console</h1>
        <p>
          <a href="/auth/oidc/start">Sign in with Google</a>
        </p>
      </main>
    );
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
