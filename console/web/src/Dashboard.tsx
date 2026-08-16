import type { MouseEvent, ReactNode } from 'react';

import { useI18n } from './I18nContext.tsx';
import { dashboardRoute, latestPrQuality, usageEstimateLines, type DashboardDestination, type UsageEstimateView } from './logic/dashboard.ts';
import { statsRows, type SysStats } from './logic/surfaces.ts';
import { semanticStatus, type PrGateProjection } from './logic/pr-quality.ts';
import { type ConsoleServiceHealth, type CoreRunList, type ProjectionEnvelope } from './logic/controlCenter.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { useRead, type ReadResult } from './useFetch.ts';

interface DashboardProps {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}

function routeClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void): void {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  navigate();
}

function valueFromRead<T>(result: ReadResult<T>): T | null {
  return result.state.kind === 'data' ? result.state.value : result.state.previous;
}

function ReadMeta<T>({ result, sourceTimestamp }: { readonly result: ReadResult<T>; readonly sourceTimestamp: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const readAt = result.state.kind === 'data' ? result.state.readAt : result.state.kind === 'error' ? result.state.readAt : null;
  return (
    <p className="provenance-line">
      {t('projectionSourceTimestamp')} {sourceTimestamp === null ? t('projectionUnknownFreshness') : <time dateTime={sourceTimestamp}>{sourceTimestamp}</time>}
      {' · '}{t('projectionClientRead')} {readAt === null ? t('projectionNotLoaded') : <time dateTime={readAt}>{readAt}</time>}
      {result.state.kind === 'error' && result.state.stale ? ` · ${t('projectionStale')}` : ''}
    </p>
  );
}

function Card({
  title,
  route,
  navigate,
  result,
  sourceTimestamp,
  children,
}: {
  readonly title: string;
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
  readonly result: ReadResult<unknown>;
  readonly sourceTimestamp: string | null;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section className="dashboard-card">
      <h2><a href={encodeRoute(route)} onClick={(event) => routeClick(event, () => navigate(route))}>{title}</a></h2>
      {result.state.kind === 'loading' && result.state.previous === null ? <p role="status">{t('loading')}</p> : children}
      {result.state.kind === 'error' && (
        <div className="read-error" role="alert">
          <span>{t('shellReadFailed', { reason: result.state.reason })}</span>
          {result.state.stale && <span>{t('shellStaleRead')}</span>}
          <button type="button" onClick={result.retry}>{t('dashboardRetry')}</button>
        </div>
      )}
      <ReadMeta result={result} sourceTimestamp={sourceTimestamp} />
    </section>
  );
}

function destination(route: RouteState, target: DashboardDestination): RouteState {
  return dashboardRoute(route, target);
}

export function Dashboard({ route, navigate }: DashboardProps): React.JSX.Element {
  const { t, locale } = useI18n();
  const host = useRead<SysStats>('/api/system/stats');
  const services = useRead<ProjectionEnvelope<ConsoleServiceHealth>>('/api/control-center/health');
  const core = useRead<ProjectionEnvelope<CoreRunList>>('/api/control-center/core/runs?limit=1');
  const usage = useRead<UsageEstimateView>('/api/usage/estimate');
  const prQuality = useRead<{ readonly runs: readonly PrGateProjection[] }>('/api/pr-quality/runs?limit=1');
  const hostData = valueFromRead(host);
  const serviceData = valueFromRead(services);
  const coreData = valueFromRead(core);
  const usageData = valueFromRead(usage);
  const prData = valueFromRead(prQuality);
  const latestPr = latestPrQuality(prData?.runs ?? []);
  const latestRunTimestamp = coreData?.data.page.items[0]?.provenance.sourceTimestamp ?? null;
  const usageTimestamp = usageData?.currentWindow?.end ?? (usageData?.weekly.available === true ? usageData.weekly.sinceReset : null);

  const refreshAll = (): void => {
    host.retry();
    services.retry();
    core.retry();
    usage.retry();
    prQuality.retry();
  };

  return (
    <main id="workspace" className="shell-workspace" tabIndex={-1}>
      <div className="workspace-heading-row">
        <div><p className="workspace-kicker">dashboard / overview</p><h1>{t('dashboardHeading')}</h1></div>
        <button type="button" disabled={host.inFlight || services.inFlight || core.inFlight || usage.inFlight || prQuality.inFlight} onClick={refreshAll}>
          {t('dashboardRefresh')}
        </button>
      </div>
      <p>{t('dashboardIntro')}</p>
      <div className="dashboard-grid">
        <Card title={t('dashboardHostHealth')} route={destination(route, 'system')} navigate={navigate} result={host} sourceTimestamp={null}>
          {hostData === null ? <p>{t('dashboardNoHost')}</p> : <ul>{statsRows(hostData, locale).map((line) => <li key={line}>{line}</li>)}</ul>}
        </Card>

        <Card title={t('dashboardConsoleServices')} route={destination(route, 'system')} navigate={navigate} result={services} sourceTimestamp={null}>
          {serviceData === null ? <p>{t('dashboardNoServices')}</p> : (
            <>
              <p>{t('dashboardConsoleLabel')} <strong>{serviceData.data.console}</strong></p>
              <ul>{Object.entries(serviceData.data.services).map(([name, service]) => (
                <li key={name}><code>{name}</code>: {service.status}{service.reason === null ? '' : ` — ${service.reason}`}</li>
              ))}</ul>
              <small>{serviceData.data.disclaimer}</small>
            </>
          )}
        </Card>

        <Card title={t('dashboardActiveRuns')} route={destination(route, 'runs')} navigate={navigate} result={core} sourceTimestamp={latestRunTimestamp}>
          {coreData === null ? <p>{t('dashboardNoCore')}</p> : (
            <><p className="dashboard-number">{coreData.data.totals.activeRuns}</p>{coreData.data.page.items.length === 0 && <p>{t('dashboardNoRuns')}</p>}</>
          )}
        </Card>

        <Card title={t('dashboardPendingApprovals')} route={destination(route, 'runs')} navigate={navigate} result={core} sourceTimestamp={latestRunTimestamp}>
          {coreData === null ? <p>{t('dashboardNoApprovalProjection')}</p> : (
            <><p className="dashboard-number">{coreData.data.totals.pendingApprovals}</p>{coreData.data.totals.pendingApprovals === 0 && <p>{t('dashboardNoApprovals')}</p>}</>
          )}
        </Card>

        <Card title={t('dashboardUsage')} route={destination(route, 'usage')} navigate={navigate} result={usage} sourceTimestamp={usageTimestamp}>
          {usageData === null ? <p>{t('dashboardNoUsage')}</p> : (
            <><ul>{usageEstimateLines(usageData, locale).map((line) => <li key={line}>{line}</li>)}</ul><p><strong>{usageData.label}</strong> — {usageData.disclaimer}</p><small>{usageData.moneyDisclaimer}</small></>
          )}
        </Card>

        <Card title={t('dashboardLatestPr')} route={destination(route, 'pr-quality')} navigate={navigate} result={prQuality} sourceTimestamp={latestPr?.updatedAt ?? null}>
          {latestPr === null ? <p>{t('dashboardNoPr')}</p> : (
            <><p><code>{latestPr.runId}</code></p><p>{semanticStatus(latestPr)}</p><p><code>{latestPr.repository ?? 'unknown repository'}#{latestPr.pullRequest ?? 'unknown'}</code></p></>
          )}
        </Card>
      </div>
    </main>
  );
}
