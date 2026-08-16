import { useEffect, useState, type MouseEvent } from 'react';

import { Chat } from './Chat.tsx';
import { Governance } from './Governance.tsx';
import { Issues } from './Issues.tsx';
import { Loop } from './Loop.tsx';
import { PrQuality } from './PrQuality.tsx';
import { Sched } from './Sched.tsx';
import { SystemPanel } from './Surfaces.tsx';
import { TerminalPanel } from './TerminalPanel.tsx';
import { useI18n } from './I18nContext.tsx';
import { CONSOLE_VIEWS, consoleView, mergeNamedRecords, type ConsoleView } from './logic/console.ts';
import { projectLabel, windowSummary, type AuthInfo, type WindowInfo } from './logic/format.ts';
import type { LocaleKey } from './logic/i18n.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { protectedFetch, useRead, type ReadResult } from './useFetch.ts';
import { usePendingMutation } from './usePendingMutation.ts';

interface ConsoleProps {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}

interface Project {
  readonly id: string;
  readonly cwd: string | null;
  readonly sessionCount: number;
  readonly loopManaged: boolean;
}

interface Session {
  readonly sessionId: string;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly entryCount: number;
}

interface Usage {
  readonly label: string;
  readonly disclaimer: string;
  readonly moneyDisclaimer: string;
  readonly currentWindow: WindowInfo | null;
  readonly windowsLast7Days: number;
  readonly weekly:
    | { readonly available: true; readonly sinceReset: string; readonly entryCount: number; readonly calibratedPercent?: number }
    | { readonly available: false; readonly needed: string };
}

const VIEW_LABELS: Readonly<Record<ConsoleView, LocaleKey>> = {
  projects: 'consoleViewProjects',
  sessions: 'consoleViewSessions',
  terminal: 'consoleViewTerminal',
  chat: 'consoleViewChat',
  runs: 'consoleViewRuns',
  scheduler: 'consoleViewScheduler',
  issues: 'consoleViewIssues',
  'pr-quality': 'consoleViewPrQuality',
  governance: 'consoleViewGovernance',
  system: 'consoleViewSystem',
  usage: 'consoleViewUsage',
};

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function ReadNotice<T>({ result }: { readonly result: ReadResult<T> }): React.JSX.Element | null {
  const { t } = useI18n();
  if (result.state.kind === 'loading' && result.state.previous === null) return <p role="status">{t('loading')}</p>;
  if (result.state.kind !== 'error') return null;
  return (
    <p role="alert">
      {result.state.stale ? t('shellStaleRead') : t('shellReadFailed', { reason: result.state.reason })}{' '}
      {result.state.readAt !== null && <time>{result.state.readAt}</time>}{' '}
      <button type="button" onClick={result.retry}>{t('shellRetry')}</button>
    </p>
  );
}

function ProjectsView({ route, navigate }: ConsoleProps): React.JSX.Element {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const result = useRead<{ projects: Project[]; guidance: string | null; nextCursor: string | null }>(
    `/api/projects?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
  );

  useEffect(() => {
    if (result.state.kind !== 'data') return;
    const page = result.state.value;
    setProjects((current) => cursor === null
      ? page.projects
      : mergeNamedRecords(current, page.projects, (project) => project.id));
    setNextCursor(page.nextCursor);
  }, [cursor, result.state]);

  const guidance = result.state.kind === 'data'
    ? result.state.value.guidance
    : result.state.kind === 'error'
      ? result.state.previous?.guidance ?? null
      : null;

  return (
    <section aria-labelledby="console-projects-heading">
      <h1 id="console-projects-heading">{t('appProjectsHeading')}</h1>
      <ReadNotice result={result} />
      {projects.length === 0 ? <p>{guidance ?? t('appNoProjectsFallback')}</p> : (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">{t('consoleProjectColumn')}</th><th scope="col">{t('consoleSessionsColumn')}</th><th scope="col">{t('consoleLoopColumn')}</th></tr></thead>
            <tbody>{projects.map((project) => {
              const next = { ...route, view: 'sessions', project: project.id, item: null };
              return (
                <tr key={project.id}>
                  <th scope="row">
                    <a href={encodeRoute(next)} onClick={(event) => {
                      if (!plainClick(event)) return;
                      event.preventDefault();
                      navigate(next);
                    }}><code>{projectLabel(project)}</code></a>
                  </th>
                  <td>{project.sessionCount}</td>
                  <td>{project.loopManaged ? t('consoleManaged') : t('consoleNotManaged')}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {nextCursor !== null && (
        <button type="button" disabled={result.inFlight} onClick={() => setCursor(nextCursor)}>{t('consoleLoadMore')}</button>
      )}
    </section>
  );
}

function SessionsView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [sessions, setSessions] = useState<readonly Session[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const result = useRead<{ sessions: Session[]; warnings: string[]; nextCursor: string | null }>(
    project === null ? null : `/api/sessions?project=${encodeURIComponent(project)}&limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
  );

  useEffect(() => {
    if (result.state.kind !== 'data') return;
    const page = result.state.value;
    setSessions((current) => cursor === null
      ? page.sessions
      : mergeNamedRecords(current, page.sessions, (session) => session.sessionId));
    setNextCursor(page.nextCursor);
  }, [cursor, result.state]);

  if (project === null) return <section><h1>{t('appSessionsAriaLabel')}</h1><p>{t('consoleSelectProject')}</p></section>;
  const data = result.state.kind === 'data' ? result.state.value : result.state.kind === 'error' ? result.state.previous : null;
  return (
    <section aria-labelledby="console-sessions-heading">
      <h1 id="console-sessions-heading">{t('appSessionsHeadingPrefix')} <code>{project}</code></h1>
      <ReadNotice result={result} />
      {(data?.warnings.length ?? 0) > 0 && <pre className="technical-output">{data?.warnings.join('\n')}</pre>}
      {sessions.length === 0 ? <p>{t('consoleNoSessions')}</p> : (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption>{t('appSessionsCaption')}</caption>
            <thead><tr><th scope="col">{t('appThSession')}</th><th scope="col">{t('appThFirst')}</th><th scope="col">{t('appThLast')}</th><th scope="col">{t('appThEntries')}</th></tr></thead>
            <tbody>{sessions.map((session) => (
              <tr key={session.sessionId}>
                <th scope="row"><code>{session.sessionId}</code></th>
                <td><time>{session.firstTs ?? '—'}</time></td>
                <td><time>{session.lastTs ?? '—'}</time></td>
                <td>{session.entryCount}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {nextCursor !== null && (
        <button type="button" disabled={result.inFlight} onClick={() => setCursor(nextCursor)}>{t('consoleLoadMore')}</button>
      )}
    </section>
  );
}

function TerminalView({ route }: { readonly route: RouteState }): React.JSX.Element {
  const { t } = useI18n();
  const auth = useRead<AuthInfo>('/api/auth');
  if (route.project === null) return <section><h1>{t('termHeading')}</h1><p>{t('consoleSelectProject')}</p></section>;
  const info = auth.state.kind === 'data' ? auth.state.value : auth.state.kind === 'error' ? auth.state.previous : null;
  if (info === null) return <section><h1>{t('termHeading')}</h1><ReadNotice result={auth} /></section>;
  if (info.remote) {
    return <section><h1>{t('termHeading')}</h1><p role="status">{t('consoleTerminalLocalOnly')}</p></section>;
  }
  return <TerminalPanel key={route.project} project={route.project} intent={route.item === 'mcp-authenticate' ? 'mcp-authenticate' : null} />;
}

function ChatView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  return project === null
    ? <section><h1>{t('chatHeading')}</h1><p>{t('consoleSelectProject')}</p></section>
    : <Chat key={project} project={project} />;
}

function GovernanceView({ route, navigate }: ConsoleProps): React.JSX.Element {
  const auth = useRead<AuthInfo>('/api/auth');
  const remote = auth.state.kind === 'data' ? auth.state.value.remote : true;
  return <Governance route={route} navigate={navigate} remote={remote} />;
}

function UsageView(): React.JSX.Element {
  const { t, locale } = useI18n();
  const estimate = useRead<Usage>('/api/usage/estimate');
  const [anchor, setAnchor] = useState('');
  const [percent, setPercent] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const mutations = usePendingMutation();
  const data = estimate.state.kind === 'data' ? estimate.state.value : estimate.state.kind === 'error' ? estimate.state.previous : null;
  const identity = { action: 'usage-calibrate', target: 'usage-config', concurrencyKey: `${anchor}:${percent}` };

  const save = async (): Promise<void> => {
    await mutations.run(identity, async () => {
      const body: { weeklyResetAnchor?: string; calibratedPercent?: number } = {};
      if (anchor !== '') body.weeklyResetAnchor = new Date(anchor).toISOString();
      if (percent !== '') body.calibratedPercent = Number(percent);
      try {
        const response = await protectedFetch('/api/usage/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const result = await response.json() as { saved?: boolean; error?: string };
        if (!response.ok) {
          setNote(result.error ?? String(response.status));
          return;
        }
        setNote(t('consoleUsageSaved'));
        estimate.retry();
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  };

  return (
    <section aria-labelledby="console-usage-heading">
      <h1 id="console-usage-heading">{t('appUsageHeading')}</h1>
      <ReadNotice result={estimate} />
      {data !== null && (
        <>
          <p>{windowSummary(data.currentWindow, Date.now(), locale)}</p>
          <p>{t('appWindowsOpenedLine', { count: data.windowsLast7Days })}</p>
          <p>{data.weekly.available
            ? t('appWeeklySinceLine', { date: data.weekly.sinceReset, count: data.weekly.entryCount })
            : data.weekly.needed}</p>
          <p><small>{data.disclaimer} · {data.moneyDisclaimer}</small></p>
        </>
      )}
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset>
          <legend>{t('consoleUsageCalibration')}</legend>
          <label>{t('consoleWeeklyReset')} <input type="datetime-local" value={anchor} onChange={(event) => setAnchor(event.target.value)} /></label>{' '}
          <label>{t('consoleCalibratedPercent')} <input type="number" min="0" max="100" value={percent} onChange={(event) => setPercent(event.target.value)} /></label>{' '}
          <button type="submit" disabled={(anchor === '' && percent === '') || mutations.isPending(identity)}>{t('consoleSaveCalibration')}</button>
        </fieldset>
      </form>
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

type ViewRenderer = (props: ConsoleProps) => React.JSX.Element;

const VIEW_REGISTRY: Readonly<Record<ConsoleView, ViewRenderer>> = {
  projects: (props) => <ProjectsView {...props} />,
  sessions: ({ route }) => <SessionsView key={route.project ?? 'none'} project={route.project} />,
  terminal: ({ route }) => <TerminalView route={route} />,
  chat: ({ route }) => <ChatView project={route.project} />,
  runs: () => <Loop />,
  scheduler: () => <Sched />,
  issues: () => <Issues />,
  'pr-quality': () => <PrQuality />,
  governance: (props) => <GovernanceView {...props} />,
  system: () => <SystemPanel />,
  usage: () => <UsageView />,
};

export function Console(props: ConsoleProps): React.JSX.Element {
  const { t } = useI18n();
  const view = consoleView(props.route.view);
  const render = VIEW_REGISTRY[view];
  return (
    <main id="workspace" className="shell-workspace console-workspace" tabIndex={-1}>
      <nav className="console-nav" aria-label={t('consoleViewsAriaLabel')}>
        <ul>{CONSOLE_VIEWS.map((candidate) => {
          const next = { ...props.route, view: candidate, item: null };
          return (
            <li key={candidate}>
              <a href={encodeRoute(next)} aria-current={candidate === view ? 'page' : undefined} onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                props.navigate(next);
              }}>{t(VIEW_LABELS[candidate])}</a>
            </li>
          );
        })}</ul>
      </nav>
      <div className="console-view" key={view}>{render(props)}</div>
    </main>
  );
}
