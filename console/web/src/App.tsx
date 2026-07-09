// Console SPA — Phase 0 dashboard: F-Status, F-Proj, F-Sess (read), F-Auth,
// F-Usage mini card (spec §8). Views stay thin; display logic lives in
// src/logic/ with unit tests. Deep-linkable via ?project= (spec §8 principles).

import { useEffect, useState } from 'react';

import { authBanner, projectLabel, windowSummary, type AuthInfo, type WindowInfo } from './logic/format.ts';
import { interpretAuthProbe, type AuthGateState } from './logic/auth.ts';
import { TerminalPanel } from './TerminalPanel.tsx';
import { Surfaces } from './Surfaces.tsx';
import { Loop } from './Loop.tsx';
import { Sched } from './Sched.tsx';
import { Issues } from './Issues.tsx';
import { Login } from './Login.tsx';

interface Status {
  disclaimer: string;
  cli: { available: boolean; version?: string; hint?: string };
  activeRuns: unknown[];
}
interface Project {
  id: string;
  cwd: string | null;
  sessionCount: number;
  loopManaged: boolean;
}
interface Session {
  sessionId: string;
  firstTs: string | null;
  lastTs: string | null;
  entryCount: number;
}
interface Usage {
  label: string;
  disclaimer: string;
  moneyDisclaimer: string;
  currentWindow: WindowInfo | null;
  windowsLast7Days: number;
  weekly:
    | { available: true; sinceReset: string; entryCount: number; calibratedPercent?: number }
    | { available: false; needed: string };
}

// Remote auth gate (REQ-19): probes the ALREADY-fetched /api/auth endpoint's
// status code — a 401 means no valid session, so the dashboard's own fetches
// stay unfired below (`ready ? url : null`) until a login flips the cookie.
function useAuthGate(): AuthGateState {
  const [state, setState] = useState<AuthGateState>('checking');
  useEffect(() => {
    let alive = true;
    fetch('/api/auth')
      .then((r) => {
        if (alive) setState(interpretAuthProbe(r.status));
      })
      .catch(() => {
        if (alive) setState('authed'); // network hiccup: don't lock the shell out, let downstream fetches fail gracefully
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function useFetch<T>(url: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (url === null) return;
    let alive = true;
    fetch(url)
      .then((r) => r.json())
      .then((d: T) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return data;
}

export function App() {
  const gate = useAuthGate();
  const ready = gate === 'authed';

  const status = useFetch<Status>(ready ? '/api/status' : null);
  const auth = useFetch<AuthInfo>(ready ? '/api/auth' : null);
  const projectsRes = useFetch<{ projects: Project[]; guidance: string | null }>(ready ? '/api/projects' : null);
  const usage = useFetch<Usage>(ready ? '/api/usage/estimate' : null);

  const params = new URLSearchParams(window.location.search);
  const selected = params.get('project');
  const sessionsRes = useFetch<{ sessions: Session[]; warnings: string[] }>(
    ready && selected !== null ? `/api/sessions?project=${encodeURIComponent(selected)}` : null,
  );

  if (gate === 'checking') return null;
  if (gate === 'unauthed') return <Login />;

  const banner = auth !== null ? authBanner(auth) : null;

  return (
    <main
      style={{
        maxWidth: 900,
        margin: '0 auto',
        padding: '1rem',
        fontFamily: 'system-ui',
        overflowWrap: 'anywhere',
      }}
    >
      <h1>Platform Console</h1>
      <p role="note">
        {status?.disclaimer ??
          'Third-party tool operating on your local Claude Code installation — not an Anthropic product.'}
      </p>

      {banner !== null && (
        <section
          aria-label="Auth status"
          role={banner.tone === 'red' ? 'alert' : 'status'}
          style={{
            padding: '0.75rem',
            border: '2px solid',
            borderColor: banner.tone === 'red' ? '#b30000' : '#2e7d32',
            color: banner.tone === 'red' ? '#b30000' : '#2e7d32',
            marginBottom: '1rem',
          }}
        >
          {banner.text}
        </section>
      )}

      <section aria-label="CLI status">
        <h2>Status</h2>
        {status === null ? (
          <p>loading…</p>
        ) : status.cli.available ? (
          <p>
            CLI version: <code>{status.cli.version}</code> · active runs: {status.activeRuns.length}
          </p>
        ) : (
          <p>{status.cli.hint}</p>
        )}
      </section>

      <section aria-label="Usage estimate">
        <h2>Usage (estimate)</h2>
        {usage === null ? (
          <p>loading…</p>
        ) : (
          <>
            <p>{windowSummary(usage.currentWindow, Date.now())}</p>
            <p>5h windows opened in the last 7 days: {usage.windowsLast7Days}</p>
            {usage.weekly.available ? (
              <p>
                Weekly since {usage.weekly.sinceReset}: {usage.weekly.entryCount} entries
                {usage.weekly.calibratedPercent !== undefined
                  ? ` · calibrated at ${usage.weekly.calibratedPercent}%`
                  : ''}
              </p>
            ) : (
              <p>{usage.weekly.needed}</p>
            )}
            <p>
              <small>
                {usage.disclaimer} · {usage.moneyDisclaimer}
              </small>
            </p>
          </>
        )}
      </section>

      <section aria-label="Projects">
        <h2>Projects</h2>
        {projectsRes === null ? (
          <p>loading…</p>
        ) : projectsRes.projects.length === 0 ? (
          <p>{projectsRes.guidance ?? 'no projects yet'}</p>
        ) : (
          <ul>
            {projectsRes.projects.map((p) => (
              <li key={p.id}>
                <a href={`?project=${encodeURIComponent(p.id)}`}>{projectLabel(p)}</a>{' '}
                <small>({p.sessionCount} sessions)</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Loop />

      <Sched />

      <Issues />

      <Surfaces project={selected} remote={auth?.remote ?? true} />

      {selected !== null && <TerminalPanel project={selected} />}

      {selected !== null && (
        <section aria-label="Sessions">
          <h2>
            Sessions — <code>{selected}</code>
          </h2>
          {sessionsRes === null ? (
            <p>loading…</p>
          ) : (
            <>
              {sessionsRes.warnings.length > 0 && (
                <p role="status">{sessionsRes.warnings.join(' · ')}</p>
              )}
              <div style={{ overflowX: 'auto' }}>
                <table>
                <caption>Sessions read live from local transcripts</caption>
                <thead>
                  <tr>
                    <th scope="col">session</th>
                    <th scope="col">first</th>
                    <th scope="col">last</th>
                    <th scope="col">entries</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsRes.sessions.map((s) => (
                    <tr key={s.sessionId}>
                      <td>
                        <code>{s.sessionId}</code>
                      </td>
                      <td>{s.firstTs ?? '—'}</td>
                      <td>{s.lastTs ?? '—'}</td>
                      <td>{s.entryCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
