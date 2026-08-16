import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { DraftProvider } from './DraftContext.tsx';
import { Aal } from './Aal.tsx';
import { Adapters } from './Adapters.tsx';
import { Core } from './Core.tsx';
import { Console } from './Console.tsx';
import { Dashboard } from './Dashboard.tsx';
import { openModalDialog } from './dialog.ts';
import { useI18n } from './I18nContext.tsx';
import { Login } from './Login.tsx';
import { interpretAuthProbe, type AuthGateState } from './logic/auth.ts';
import {
  AREAS,
  decodeRoute,
  encodeRoute,
  routeForArea,
  validateSelectedItem,
  type Area,
  type DecodedRoute,
  type RouteState,
  type RouteWarning,
} from './logic/navigation.ts';
import type { LocaleKey } from './logic/i18n.ts';
import { readPreference, writePreference } from './logic/preferences.ts';
import {
  isTheme,
  resolveInitialTheme,
  themeToggleLabel,
  toggleTheme,
  THEME_STORAGE_KEY,
  type Theme,
} from './logic/theme.ts';
import { AUTH_INVALID_EVENT, resetAuthInvalidSignal, useRead, type ReadResult } from './useFetch.ts';

interface Project {
  readonly id: string;
  readonly cwd: string | null;
  readonly sessionCount: number;
  readonly loopManaged: boolean;
}

interface ProjectsResponse {
  readonly projects: readonly Project[];
  readonly guidance: string | null;
}

const AREA_LABEL_KEYS: Readonly<Record<Area, LocaleKey>> = {
  dashboard: 'areaDashboard',
  core: 'areaCore',
  aal: 'areaAal',
  adapters: 'areaAdapters',
  console: 'areaConsole',
};

const DEFAULT_VIEWS: Readonly<Record<Area, string>> = {
  dashboard: 'overview',
  core: 'runs',
  aal: 'routing',
  adapters: 'catalog',
  console: 'projects',
};

function useAuthGate(): { readonly gate: AuthGateState; readonly authenticated: () => void } {
  const [gate, setGate] = useState<AuthGateState>('checking');

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth', { signal: controller.signal })
      .then((response) => setGate(interpretAuthProbe(response.status)))
      .catch(() => {
        if (!controller.signal.aborted) setGate('unauthed');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const invalidate = (): void => setGate('unauthed');
    window.addEventListener(AUTH_INVALID_EVENT, invalidate);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, invalidate);
  }, []);

  return {
    gate,
    authenticated: useCallback(() => {
      resetAuthInvalidSignal();
      setGate('authed');
    }, []),
  };
}

function storedTheme(): string | null {
  return readPreference(localStorage, THEME_STORAGE_KEY);
}

function useTheme(): { readonly theme: Theme; readonly toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const attr = document.documentElement.getAttribute('data-theme');
    return isTheme(attr)
      ? attr
      : resolveInitialTheme(storedTheme(), window.matchMedia('(prefers-color-scheme: dark)').matches);
  });
  return {
    theme,
    toggle: () => {
      setTheme((current) => {
        const next = toggleTheme(current);
        document.documentElement.setAttribute('data-theme', next);
        writePreference(localStorage, THEME_STORAGE_KEY, next);
        return next;
      });
    },
  };
}

function useRoute(): {
  readonly decoded: DecodedRoute;
  readonly navigate: (route: RouteState) => void;
} {
  const [decoded, setDecoded] = useState<DecodedRoute>(() => decodeRoute(window.location.search));

  useEffect(() => {
    const readLocation = (): void => {
      const next = decodeRoute(window.location.search);
      const canonical = encodeRoute(next.route);
      if (window.location.search !== canonical) {
        window.history.replaceState(null, '', `${window.location.pathname}${canonical}${window.location.hash}`);
      }
      setDecoded(next);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, []);

  return {
    decoded,
    navigate: useCallback((route) => {
      const search = encodeRoute(route);
      if (window.location.search !== search) {
        window.history.pushState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
      }
      setDecoded({ route, warning: null });
    }, []),
  };
}

class AreaErrorBoundary extends Component<
  { readonly children: ReactNode; readonly message: string; readonly retryLabel: string },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="area-error" role="alert">
        <p>{this.props.message}</p>
        <button type="button" onClick={() => this.setState({ failed: false })}>
          {this.props.retryLabel}
        </button>
      </section>
    );
  }
}

function plainNavigationClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function AreaNavigation({
  route,
  navigate,
}: {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <nav aria-label={t('shellNavigationAriaLabel')}>
      <ul className="area-nav-list">
        {AREAS.map((area) => {
          const next = routeForArea(route, area);
          return (
            <li key={area}>
              <a
                href={encodeRoute(next)}
                aria-current={route.area === area ? 'page' : undefined}
                onClick={(event) => {
                  if (!plainNavigationClick(event)) return;
                  event.preventDefault();
                  navigate(next);
                }}
              >
                {t(AREA_LABEL_KEYS[area])}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function routeWarningText(warning: RouteWarning): { readonly key: 'shellInvalidArea' | 'shellInvalidView' | 'shellInvalidItem'; readonly value: string } {
  if (warning.kind === 'invalid-area') return { key: 'shellInvalidArea', value: warning.value };
  if (warning.kind === 'invalid-view') return { key: 'shellInvalidView', value: warning.value };
  return { key: 'shellInvalidItem', value: warning.value };
}

function Workspace({ decoded }: { readonly decoded: DecodedRoute }): React.JSX.Element {
  const { t } = useI18n();
  const { route, warning } = decoded;
  const warningText = warning === null ? null : routeWarningText(warning);
  return (
    <>
      {warningText !== null && (
        <p className="route-warning" role="alert">
          {t(warningText.key, { value: warningText.value })}
        </p>
      )}
      <section aria-labelledby="workspace-heading">
        <p className="workspace-kicker">
          {route.area} / {route.view ?? DEFAULT_VIEWS[route.area]}
        </p>
        <h1 id="workspace-heading">{t('shellWorkspaceHeading', { area: t(AREA_LABEL_KEYS[route.area]) })}</h1>
        <p>{t('shellWorkspaceIntro')}</p>
        <details>
          <summary>{t('shellRouteDetails')}</summary>
          <dl className="route-details">
            <dt>{t('shellRouteArea')}</dt>
            <dd><code>{route.area}</code></dd>
            <dt>{t('shellRouteView')}</dt>
            <dd><code>{route.view ?? DEFAULT_VIEWS[route.area]}</code></dd>
            <dt>{t('shellRouteProject')}</dt>
            <dd><code>{route.project ?? '—'}</code></dd>
          </dl>
        </details>
      </section>
    </>
  );
}

function ContextInspector({ decoded }: { readonly decoded: DecodedRoute }): React.JSX.Element | null {
  const { t } = useI18n();
  const { route, warning } = decoded;
  if (route.item === null && warning?.kind !== 'invalid-item') return null;
  return (
    <section aria-labelledby="inspector-heading">
      <h2 id="inspector-heading">{t('shellInspectorAriaLabel')}</h2>
      {warning?.kind === 'invalid-item' ? (
        <p role="status">{t('shellInvalidItem', { value: warning.value })}</p>
      ) : (
        <>
          <p>{t('shellSelectedItem')}</p>
          <code>{route.item}</code>
          <details>
            <summary>{t('shellRouteDetails')}</summary>
            <p><code>{encodeRoute(route)}</code></p>
          </details>
        </>
      )}
    </section>
  );
}

function ProjectControl({
  route,
  navigate,
  result,
}: {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
  readonly result: ReadResult<ProjectsResponse>;
}): React.JSX.Element {
  const { t } = useI18n();
  const data = result.state.kind === 'data' ? result.state.value : result.state.kind === 'error' ? result.state.previous : result.state.previous;
  const projects = data?.projects ?? [];
  const selectedMissing = route.project !== null && !projects.some((project) => project.id === route.project);

  return (
    <div className="project-control">
      <label>
        <span>{t('shellProjectLabel')}</span>
        <select
          value={route.project ?? ''}
          onChange={(event) => navigate({ ...route, project: event.target.value || null, item: null })}
        >
          <option value="">{t('shellAllProjects')}</option>
          {selectedMissing && <option value={route.project ?? ''}>{route.project}</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.cwd ?? project.id}</option>
          ))}
        </select>
      </label>
      {result.state.kind === 'loading' && result.state.previous === null && <span role="status">{t('loading')}</span>}
      {result.state.kind === 'error' && (
        <div className="read-error" role="alert">
          <span>{t('shellReadFailed', { reason: result.state.reason })}</span>
          {result.state.stale && <span>{t('shellStaleRead')}</span>}
          {result.state.readAt !== null && <span>{t('shellLastRead', { time: result.state.readAt })}</span>}
          <button type="button" onClick={result.retry}>{t('shellRetry')}</button>
        </div>
      )}
    </div>
  );
}

function AuthenticatedShell(): React.JSX.Element {
  const { decoded: rawDecoded, navigate: baseNavigate } = useRoute();
  const knownItems = rawDecoded.route.area === 'console' && rawDecoded.route.view === 'terminal' ? ['mcp-authenticate'] : null;
  const decoded = validateSelectedItem(rawDecoded, knownItems);
  const route = decoded.route;
  const projectRead = useRead<ProjectsResponse>('/api/projects?limit=50');
  const navDialog = useRef<HTMLDialogElement>(null);
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const { theme, toggle: onToggleTheme } = useTheme();
  const { t, locale, onToggleLocale } = useI18n();

  const navigate = (next: RouteState): void => {
    navDialog.current?.close();
    inspectorDialog.current?.close();
    baseNavigate(next);
  };
  const customArea = route.area === 'dashboard' || route.area === 'core' || route.area === 'aal' || route.area === 'adapters' || route.area === 'console';
  const inspector = customArea ? null : <ContextInspector decoded={decoded} />;
  const hasInspector = route.area === 'core' || route.area === 'aal' || route.area === 'adapters'
    ? route.item !== null
    : inspector !== null;

  return (
    <div className="control-center">
      <header className="app-header">
        <a className="skip-link" href="#workspace">{t('shellSkipToWorkspace')}</a>
        <strong>{t('appTitle')}</strong>
        <ProjectControl route={route} navigate={navigate} result={projectRead} />
        <div className="header-actions">
          <button className="drawer-trigger" type="button" onClick={(event) => openModalDialog(navDialog.current, event.currentTarget)}>
            {t('shellOpenNavigation')}
          </button>
          {inspector !== null && (
            <button className="drawer-trigger" type="button" onClick={(event) => openModalDialog(inspectorDialog.current, event.currentTarget)}>
              {t('shellOpenInspector')}
            </button>
          )}
          <button type="button" aria-pressed={theme === 'dark'} onClick={onToggleTheme}>
            {t(themeToggleLabel(theme))}
          </button>
          <button type="button" onClick={onToggleLocale}>
            {locale === 'th' ? t('localeToggleToEnglish') : t('localeToggleToThai')}
          </button>
        </div>
      </header>

      <div className={`shell-grid${hasInspector ? '' : ' shell-grid-without-inspector'}`}>
        <aside className="shell-nav">
          <AreaNavigation route={route} navigate={navigate} />
        </aside>
        <AreaErrorBoundary
          key={`${route.area}:${route.view ?? ''}`}
          message={t('shellAreaError')}
          retryLabel={t('shellReloadArea')}
        >
          {route.area === 'dashboard' ? (
            <Dashboard route={route} navigate={navigate} />
          ) : route.area === 'core' ? (
            <Core route={route} navigate={navigate} />
          ) : route.area === 'aal' ? (
            <Aal route={route} navigate={navigate} />
          ) : route.area === 'adapters' ? (
            <Adapters route={route} navigate={navigate} />
          ) : route.area === 'console' ? (
            <Console route={route} navigate={navigate} />
          ) : (
            <>
              <main id="workspace" className="shell-workspace" tabIndex={-1}>
                <Workspace decoded={decoded} />
              </main>
              {hasInspector && (
                <aside className="shell-inspector" aria-label={t('shellInspectorAriaLabel')}>
                  {inspector}
                </aside>
              )}
            </>
          )}
        </AreaErrorBoundary>
      </div>

      <dialog ref={navDialog} className="drawer-dialog" aria-label={t('shellNavigationAriaLabel')}>
        <button data-initial-focus type="button" onClick={() => navDialog.current?.close()}>{t('shellClose')}</button>
        <AreaNavigation route={route} navigate={navigate} />
      </dialog>
      <dialog ref={inspectorDialog} className="drawer-dialog" aria-label={t('shellInspectorAriaLabel')}>
        <button data-initial-focus type="button" onClick={() => inspectorDialog.current?.close()}>{t('shellClose')}</button>
        {inspector}
      </dialog>
    </div>
  );
}

export function App(): React.JSX.Element {
  const { gate, authenticated } = useAuthGate();
  const { t } = useI18n();
  return (
    <DraftProvider authVerified={gate === 'authed'}>
      {gate === 'checking' ? (
        <main className="auth-state" aria-live="polite">{t('shellCheckingSession')}</main>
      ) : gate === 'unauthed' ? (
        <Login onAuthenticated={authenticated} />
      ) : (
        <AuthenticatedShell />
      )}
    </DraftProvider>
  );
}
