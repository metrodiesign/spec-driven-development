import { useRef, useState, type MouseEvent } from 'react';

import { openModalDialog } from './dialog.ts';
import { useI18n } from './I18nContext.tsx';
import {
  conformanceProbeRows,
  filterAalTargets,
  type AalProjection,
  type ProjectionEnvelope,
  type RecordedDimension,
  type RoutingTargetProjection,
  type SourceStamp,
} from './logic/controlCenter.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { useRead, type ReadResult } from './useFetch.ts';

interface AalProps {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}

function valueFromRead<T>(result: ReadResult<T>): T | null {
  return result.state.kind === 'data' ? result.state.value : result.state.previous;
}

function ReadNotice<T>({ result }: { readonly result: ReadResult<T> }): React.JSX.Element | null {
  const { t } = useI18n();
  if (result.state.kind === 'loading' && result.state.previous === null) return <p role="status">{t('loading')}</p>;
  if (result.state.kind !== 'error') return null;
  return (
    <div className="read-error" role="alert">
      <span>{t('shellReadFailed', { reason: result.state.reason })}</span>
      {result.state.stale && <span>{t('shellStaleRead')}</span>}
      {result.state.readAt !== null && <span>{t('readLastSuccessfulClient', { time: result.state.readAt })}</span>}
      <button type="button" onClick={result.retry}>{t('shellRetry')}</button>
    </div>
  );
}

function routeClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void): void {
  if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  navigate();
}

function copyText(value: string): void {
  void navigator.clipboard.writeText(value).catch(() => undefined);
}

function Provenance({ stamp }: { readonly stamp: SourceStamp }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span className="provenance-line">
      <code>{stamp.source}</code> ·{' '}
      {stamp.sourceTimestamp === null || stamp.freshness === 'unknown'
        ? t('projectionUnknownFreshness')
        : <time dateTime={stamp.sourceTimestamp}>{stamp.sourceTimestamp}</time>}
      {stamp.sequence === null ? '' : ` · seq ${stamp.sequence}`}
    </span>
  );
}

function dimensionText<T>(dimension: RecordedDimension<T>, format: (value: T) => string, invalid: string, unknown: string): string {
  if (dimension.status === 'known') return format(dimension.value);
  return `${dimension.status === 'invalid-record' ? invalid : unknown} — ${dimension.reason}`;
}

function DimensionDetails<T>({
  dimension,
  format,
}: {
  readonly dimension: RecordedDimension<T>;
  readonly format: (value: T) => string;
}): React.JSX.Element {
  const { t } = useI18n();
  const provenance = dimension.status === 'known' || dimension.status === 'invalid-record'
    ? dimension.provenance
    : dimension.provenance;
  return (
    <>
      <span className={dimension.status === 'known' ? undefined : 'dimension-unavailable'}>{dimensionText(dimension, format, t('dimensionInvalid'), t('dimensionUnknown'))}</span>
      {provenance !== undefined && <><br /><Provenance stamp={provenance} /></>}
    </>
  );
}

function TargetInspector({ idPrefix, requested, target }: { readonly idPrefix: string; readonly requested: string; readonly target: RoutingTargetProjection | null }): React.JSX.Element {
  const { t } = useI18n();
  if (target === null) {
    return (
      <section aria-labelledby={`${idPrefix}-heading`}>
        <h2 id={`${idPrefix}-heading`}>{t('aalInspector')}</h2>
        <p role="status">{t('aalSelectedUnavailable', { target: requested })}</p>
      </section>
    );
  }
  return (
    <section aria-labelledby={`${idPrefix}-heading`}>
      <h2 id={`${idPrefix}-heading`}>{t('aalInspector')}</h2>
      <p><code>{target.target}</code></p>
      <button type="button" onClick={() => copyText(target.target)}>{t('aalCopyTarget')}</button>
      <dl className="inspector-dl">
        <dt>{t('aalBreaker')}</dt>
        <dd><DimensionDetails dimension={target.breaker} format={(value) => value.state} /></dd>
        <dt>{t('aalRatePolicy')}</dt>
        <dd><DimensionDetails dimension={target.rateLimitPolicy} format={(value) => t('aalCapacity', { count: value.capacity, rate: value.refillPerSec })} /></dd>
        <dt>{t('aalRecordedRate')}</dt>
        <dd><DimensionDetails dimension={target.recordedLimitState} format={(value) => value.availableTokens === null ? t('aalUnlimited') : t('aalLimitedTokens', { state: value.limited ? t('aalLimited') : t('aalAvailable'), count: value.availableTokens })} /></dd>
      </dl>
      <h3>{t('aalConformance')}</h3>
      {target.conformance.status !== 'known' ? (
        <DimensionDetails dimension={target.conformance} format={() => ''} />
      ) : (
        <>
          <p>{t('aalModel')} <code>{target.conformance.value.modelVersion}</code></p>
          <dl className="inspector-dl">
            {conformanceProbeRows(target.conformance.value).map((probe) => (
              <div className="definition-row" key={probe.id}>
                <dt>{probe.id}</dt>
                <dd>{probe.id === 'P7' ? t('aalSusceptibility', { value: String(probe.value) }) : probe.value === true ? t('aalPass') : t('aalFail')}</dd>
              </div>
            ))}
          </dl>
          <Provenance stamp={target.conformance.provenance} />
        </>
      )}
    </section>
  );
}

function ViewNavigation({ route, navigate }: AalProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <nav aria-label={t('aalViews')}>
      <ul className="secondary-nav">
        {(['routing', 'fusion'] as const).map((view) => {
          const next = { ...route, view, item: null };
          const selected = (route.view ?? 'routing') === view;
          return (
            <li key={view}>
              <a href={encodeRoute(next)} aria-current={selected ? 'page' : undefined} onClick={(event) => routeClick(event, () => navigate(next))}>
                {view === 'routing' ? t('aalRoutingAndResilience') : t('aalFusion')}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function RoutingView({
  projection,
  route,
  navigate,
}: {
  readonly projection: AalProjection;
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [conformance, setConformance] = useState<'all' | 'known' | 'unknown' | 'invalid-record'>('all');
  const targets = filterAalTargets(projection.targets, query, conformance);
  const targetLink = (target: string): React.JSX.Element => {
    const next = { ...route, view: 'routing', item: target };
    return <a href={encodeRoute(next)} onClick={(event) => routeClick(event, () => navigate(next))}><code>{target}</code></a>;
  };
  return (
    <>
      <section aria-labelledby="aal-role-heading">
        <h2 id="aal-role-heading">{t('aalRoleRouting')}</h2>
        {projection.roles.length === 0 ? <p>{t('aalNoRouting')}</p> : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">{t('aalContextRole')}</th><th scope="col">{t('aalOrderedTargets')}</th><th scope="col">{t('aalFallback')}</th><th scope="col">{t('aalBasisSource')}</th></tr></thead>
              <tbody>{projection.roles.map((role) => (
                <tr key={`${role.context}:${role.role}`}>
                  <th scope="row"><code>{role.context} / {role.role}</code></th>
                  <td>{role.orderedTargets.length === 0 ? 'unknown' : role.orderedTargets.map((target, index) => <span key={target}>{index > 0 && ' → '}{targetLink(target)}</span>)}</td>
                  <td>{role.fallbackOrder.length === 0 ? t('aalNoneRecorded') : role.fallbackOrder.map((target, index) => <span key={target}>{index > 0 && ' → '}{targetLink(target)}</span>)}</td>
                  <td>{role.basis}<br /><Provenance stamp={role.provenance} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="aal-target-heading">
        <h2 id="aal-target-heading">{t('aalRoutingTargets')}</h2>
        <div className="toolbar" role="group" aria-label={t('aalTargetFilters')}>
          <label>{t('commonSearch')} <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label>{t('aalConformanceFilter')} <select value={conformance} onChange={(event) => setConformance(event.target.value as typeof conformance)}>
            <option value="all">all</option><option value="known">known</option><option value="unknown">unknown</option><option value="invalid-record">invalid</option>
          </select></label>
        </div>
        {targets.length === 0 ? <p>{t('aalNoTargets')}</p> : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">{t('aalTarget')}</th><th scope="col">{t('aalBreaker')}</th><th scope="col">{t('aalRatePolicy')}</th><th scope="col">{t('aalRecordedRate')}</th><th scope="col">{t('aalConformanceFilter')}</th></tr></thead>
              <tbody>{targets.map((target) => (
                <tr key={target.target}>
                  <th scope="row">{targetLink(target.target)}</th>
                  <td>{dimensionText(target.breaker, (value) => value.state, t('dimensionInvalid'), t('dimensionUnknown'))}</td>
                  <td>{dimensionText(target.rateLimitPolicy, (value) => `${value.capacity} / ${value.refillPerSec}s`, t('dimensionInvalid'), t('dimensionUnknown'))}</td>
                  <td>{dimensionText(target.recordedLimitState, (value) => value.availableTokens === null ? t('aalUnlimited') : `${value.limited ? t('aalLimited') : t('aalAvailable')} · ${value.availableTokens}`, t('dimensionInvalid'), t('dimensionUnknown'))}</td>
                  <td>{dimensionText(target.conformance, (value) => `${value.modelVersion} · P7 ${value.p7SusceptibilityScore}`, t('dimensionInvalid'), t('dimensionUnknown'))}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function FusionView({ projection }: { readonly projection: AalProjection }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section aria-labelledby="aal-fusion-heading">
      <h2 id="aal-fusion-heading">{t('aalFusionHeading')}</h2>
      <p>{t('aalPlannerTrigger')} <strong>{projection.fusion.plannerRoleEnabled ? t('commonEnabled') : t('commonDisabled')}</strong></p>
      {projection.fusion.profiles.length === 0 ? <p>{t('aalNoFusionProfiles')}</p> : (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">{t('aalArtifact')}</th><th scope="col">{t('aalPanel')}</th><th scope="col">{t('aalDiversity')}</th><th scope="col">{t('aalResolve')}</th><th scope="col">{t('aalBudgetEstimate')}</th><th scope="col">{t('aalSource')}</th></tr></thead>
            <tbody>{projection.fusion.profiles.map((profile) => (
              <tr key={profile.artifact}>
                <th scope="row"><code>{profile.artifact}</code></th>
                <td>{profile.panelSize}</td>
                <td><code>{profile.diversity}</code></td>
                <td><code>{profile.resolve}</code></td>
                <td>{profile.budgetCapCostUnits} / {profile.estimateCostUnitsPerCandidate}</td>
                <td><Provenance stamp={profile.provenance} /></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <h3>{t('aalLatestRun')}</h3>
      <DimensionDetails
        dimension={projection.fusion.latestRun}
        format={(value) => t('aalLatestRunSummary', { resolved: value.resolved ?? t('coreNone'), escalation: value.escalated ? t('aalEscalated') : t('aalNotEscalated'), usage: value.usageCostUnits ?? t('dimensionUnknown') })}
      />
    </section>
  );
}

export function Aal({ route, navigate }: AalProps): React.JSX.Element {
  const { t } = useI18n();
  const read = useRead<ProjectionEnvelope<AalProjection>>('/api/control-center/aal');
  const envelope = valueFromRead(read);
  const view = route.view === 'fusion' ? 'fusion' : 'routing';
  const selected = route.item === null ? null : envelope?.data.targets.find((target) => target.target === route.item) ?? null;
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const inspector = route.item === null ? null : <TargetInspector idPrefix="aal-inspector" requested={route.item} target={selected} />;
  return (
    <>
      <main id="workspace" className="shell-workspace" tabIndex={-1}>
        <div className="workspace-heading-row">
          <div><p className="workspace-kicker">aal / {view}</p><h1>{t('aalWorkspace')}</h1></div>
          <div>
            {inspector !== null && <button className="drawer-trigger" type="button" onClick={(event) => openModalDialog(inspectorDialog.current, event.currentTarget)}>{t('shellOpenInspector')}</button>}{' '}
            <button type="button" disabled={read.inFlight} onClick={read.retry}>{t('aalRefresh')}</button>
          </div>
        </div>
        <p>{t('aalIntro')}</p>
        <ViewNavigation route={route} navigate={navigate} />
        <ReadNotice result={read} />
        {envelope !== null && (
          <>
            <p className="provenance-line">{t('projectionProjectorRead')} <time dateTime={envelope.readAt}>{envelope.readAt}</time></p>
            {view === 'routing'
              ? <RoutingView projection={envelope.data} route={route} navigate={navigate} />
              : <FusionView projection={envelope.data} />}
            {envelope.issues.length > 0 && (
              <details><summary>{t('projectionIssues', { count: envelope.issues.length })}</summary><ul>
                {envelope.issues.map((issue, index) => <li key={`${issue.field}:${index}`}><code>{issue.field}</code>: {issue.reason}</li>)}
              </ul></details>
            )}
          </>
        )}
      </main>
      {inspector !== null && <aside className="shell-inspector" aria-label={t('aalInspector')}>{inspector}</aside>}
      <dialog ref={inspectorDialog} className="drawer-dialog" aria-label={t('aalInspector')}>
        <button data-initial-focus type="button" onClick={() => inspectorDialog.current?.close()}>{t('shellClose')}</button>
        {route.item !== null && <TargetInspector idPrefix="aal-dialog-inspector" requested={route.item} target={selected} />}
      </dialog>
    </>
  );
}
