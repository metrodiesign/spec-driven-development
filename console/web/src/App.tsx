// Console SPA — Phase 0 dashboard: F-Status, F-Proj, F-Sess (read), F-Auth,
// F-Usage mini card (spec §8). Views stay thin; display logic lives in
// src/logic/ with unit tests. Deep-linkable via ?project= (spec §8 principles).

import { useEffect, useState } from 'react';

import { authBanner, projectLabel, windowSummary, type AuthInfo, type WindowInfo } from './logic/format.ts';
import { interpretAuthProbe, type AuthGateState } from './logic/auth.ts';
import { isTheme, resolveInitialTheme, themeToggleLabel, toggleTheme, THEME_STORAGE_KEY, type Theme } from './logic/theme.ts';
import { useI18n } from './I18nContext.tsx';
import { useFetch } from './useFetch.ts';
import { TerminalPanel } from './TerminalPanel.tsx';
import { Surfaces } from './Surfaces.tsx';
import { Loop } from './Loop.tsx';
import { Sched } from './Sched.tsx';
import { Issues } from './Issues.tsx';
import { Chat } from './Chat.tsx';
import { Login } from './Login.tsx';
import { PrQuality } from './PrQuality.tsx';

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

// Theme toggle (REQ-20.2): index.html's inline script already stamps
// data-theme on <html> before paint, so read that as the source of truth
// instead of re-resolving prefers-color-scheme a second time here.
function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    return isTheme(attr)
      ? attr
      : resolveInitialTheme(localStorage.getItem(THEME_STORAGE_KEY), window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  const toggle = (): void => {
    setTheme((prev) => {
      const next = toggleTheme(prev);
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(THEME_STORAGE_KEY, next);
      return next;
    });
  };
  return { theme, toggle };
}

export function App() {
  const gate = useAuthGate();
  const ready = gate === 'authed';
  const { theme, toggle: onToggleTheme } = useTheme();
  const { t, locale, onToggleLocale } = useI18n();

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

  const banner = auth.kind === 'data' ? authBanner(auth.value) : null;

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
      <header className="app-header">
        <h1>{t('appTitle')}</h1>
        <button type="button" aria-pressed={theme === 'dark'} onClick={onToggleTheme}>
          {t(themeToggleLabel(theme))}
        </button>
        <button type="button" onClick={onToggleLocale}>
          {locale === 'th' ? t('localeToggleToEnglish') : t('localeToggleToThai')}
        </button>
      </header>
      <p role="note">{(status.kind === 'data' ? status.value.disclaimer : undefined) ?? t('appStatusDisclaimerFallback')}</p>

      {banner !== null && (
        <section
          aria-label={t('appAuthStatusAriaLabel')}
          role={banner.tone === 'red' ? 'alert' : 'status'}
          style={{
            padding: '0.75rem',
            border: '2px solid',
            borderColor: banner.tone === 'red' ? 'var(--color-danger)' : 'var(--color-success)',
            color: banner.tone === 'red' ? 'var(--color-danger)' : 'var(--color-success)',
            marginBottom: '1rem',
          }}
        >
          {banner.text}
        </section>
      )}

      <section aria-label={t('appCliStatusAriaLabel')}>
        <h2>{t('appStatusHeading')}</h2>
        {status.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : status.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : status.value.cli.available ? (
          <p>
            {t('appCliVersionPrefix')} <code>{status.value.cli.version}</code> {t('appActiveRunsInfix')}{' '}
            {status.value.activeRuns.length}
          </p>
        ) : (
          <p>{status.value.cli.hint}</p>
        )}
      </section>

      <section aria-label={t('appUsageAriaLabel')}>
        <h2>{t('appUsageHeading')}</h2>
        {usage.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : usage.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <>
            <p>{windowSummary(usage.value.currentWindow, Date.now())}</p>
            <p>{t('appWindowsOpenedLine', { count: usage.value.windowsLast7Days })}</p>
            {usage.value.weekly.available ? (
              <p>
                {t('appWeeklySinceLine', { date: usage.value.weekly.sinceReset, count: usage.value.weekly.entryCount })}
                {usage.value.weekly.calibratedPercent !== undefined
                  ? t('appCalibratedSuffix', { percent: usage.value.weekly.calibratedPercent })
                  : ''}
              </p>
            ) : (
              <p>{usage.value.weekly.needed}</p>
            )}
            <p>
              <small>
                {usage.value.disclaimer} · {usage.value.moneyDisclaimer}
              </small>
            </p>
          </>
        )}
      </section>

      <section aria-label={t('appProjectsHeading')}>
        <h2>{t('appProjectsHeading')}</h2>
        {projectsRes.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : projectsRes.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : projectsRes.value.projects.length === 0 ? (
          <p>{projectsRes.value.guidance ?? t('appNoProjectsFallback')}</p>
        ) : (
          <ul>
            {projectsRes.value.projects.map((p) => (
              <li key={p.id}>
                <a href={`?project=${encodeURIComponent(p.id)}`}>{projectLabel(p)}</a>{' '}
                <small>{t('appSessionsCountSuffix', { count: p.sessionCount })}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Loop />

      <Sched />

      <Issues />

      <PrQuality />

      <Surfaces project={selected} remote={auth.kind === 'data' ? auth.value.remote : true} />

      {selected !== null && <TerminalPanel project={selected} />}

      {selected !== null && <Chat project={selected} />}

      {selected !== null && (
        <section aria-label={t('appSessionsAriaLabel')}>
          <h2>
            {t('appSessionsHeadingPrefix')} <code>{selected}</code>
          </h2>
          {sessionsRes.kind === 'loading' ? (
            <p>{t('loading')}</p>
          ) : sessionsRes.kind === 'error' ? (
            <p role="status">{t('fetchUnavailable')}</p>
          ) : (
            <>
              {sessionsRes.value.warnings.length > 0 && (
                <p role="status">{sessionsRes.value.warnings.join(' · ')}</p>
              )}
              <div style={{ overflowX: 'auto' }}>
                <table>
                <caption>{t('appSessionsCaption')}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('appThSession')}</th>
                    <th scope="col">{t('appThFirst')}</th>
                    <th scope="col">{t('appThLast')}</th>
                    <th scope="col">{t('appThEntries')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionsRes.value.sessions.map((s) => (
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
