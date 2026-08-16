import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { openModalDialog } from './dialog.ts';
import { useI18n } from './I18nContext.tsx';
import {
  conformanceProbeRows,
  filterAdapters,
  mergeAdapterPages,
  type AdapterProjection,
  type Page,
  type ProjectionEnvelope,
  type RecordedDimension,
  type SourceStamp,
} from './logic/controlCenter.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { useRead, type ReadResult } from './useFetch.ts';

interface AdaptersProps {
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
  const sourceTimestamp = stamp.sourceTimestamp === null || stamp.freshness === 'unknown' ? null : stamp.sourceTimestamp;
  return (
    <span className="provenance-line">
      {t('projectionRecordedSource')} <code>{stamp.source}</code> ·{' '}
      {sourceTimestamp === null ? t('projectionUnknownFreshness') : <time dateTime={sourceTimestamp}>{sourceTimestamp}</time>}
      {stamp.sequence === null ? '' : ` · seq ${stamp.sequence}`}
    </span>
  );
}

function DimensionDetails<T>({ dimension, format }: {
  readonly dimension: RecordedDimension<T>;
  readonly format: (value: T) => string;
}): React.JSX.Element {
  const { t } = useI18n();
  const provenance = dimension.provenance;
  return (
    <>
      <span className={dimension.status === 'known' ? undefined : 'dimension-unavailable'}>
        {dimension.status === 'known'
          ? format(dimension.value)
          : `${dimension.status === 'invalid-record' ? t('dimensionInvalid') : t('dimensionUnknown')} — ${dimension.reason}`}
      </span>
      {provenance !== undefined && <><br /><Provenance stamp={provenance} /></>}
    </>
  );
}

function compactDimension<T>(dimension: RecordedDimension<T>, format: (value: T) => string, unavailable: (detail: string) => string): string {
  return dimension.status === 'known' ? format(dimension.value) : unavailable(`${dimension.status}: ${dimension.reason}`);
}

function AdapterInspector({ idPrefix, id, detail }: { readonly idPrefix: string; readonly id: string; readonly detail: ReadResult<ProjectionEnvelope<AdapterProjection>> }): React.JSX.Element {
  const { t } = useI18n();
  const envelope = valueFromRead(detail);
  const adapter = envelope?.data ?? null;
  return (
    <section aria-labelledby={`${idPrefix}-heading`}>
      <h2 id={`${idPrefix}-heading`}>{t('adapterInspector')}</h2>
      <p><code>{id}</code></p>
      <button type="button" onClick={() => copyText(id)}>{t('adapterCopyId')}</button>{' '}
      <button type="button" disabled={detail.inFlight} onClick={detail.retry}>{t('adapterRefresh')}</button>
      <ReadNotice result={detail} />
      {detail.state.kind === 'error' && detail.state.reason === 'http 404' && <p role="alert">{t('adapterSelectedUnavailable')}</p>}
      {adapter !== null && envelope !== null && (
        <>
          <h3>{t('adapterRegistration')}</h3>
          <p>
            <strong>{adapter.registrationEligibility.state}</strong>
            {adapter.registrationEligibility.reasons.length === 0 ? '' : ` — ${adapter.registrationEligibility.reasons.join(', ')}`}
          </p>
          {adapter.registrationEligibility.provenance !== null && <Provenance stamp={adapter.registrationEligibility.provenance} />}

          <h3>{t('adapterCapabilityManifest')}</h3>
          <dl className="inspector-dl">
            <dt>{t('adapterTransport')}</dt><dd><code>{adapter.transport}</code></dd>
            <dt>{t('adapterLineage')}</dt><dd><code>{adapter.manifest.lineage ?? 'unknown'}</code></dd>
            <dt>{t('adapterStructuredOutput')}</dt><dd>{String(adapter.manifest.structuredOutput)}</dd>
            <dt>{t('adapterToolCalling')}</dt><dd>{String(adapter.manifest.toolCalling)}</dd>
            <dt>{t('adapterContextWindow')}</dt><dd>{adapter.manifest.contextWindowTokens ?? 'unknown'}</dd>
            <dt>{t('adapterExecutionBackend')}</dt><dd>{String(adapter.manifest.executionBackend)}</dd>
            <dt>{t('adapterDeterminism')}</dt><dd>{adapter.manifest.determinism}</dd>
          </dl>

          <h3>{t('adapterModelMappings')}</h3>
          {adapter.modelMappings.length === 0 ? <p>{t('adapterNoModelMapping')}</p> : (
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">{t('adapterContext')}</th><th scope="col">{t('adapterRole')}</th><th scope="col">{t('adapterModel')}</th><th scope="col">{t('aalSource')}</th></tr></thead>
                <tbody>{adapter.modelMappings.map((mapping) => (
                  <tr key={`${mapping.context}:${mapping.role}`}>
                    <td><code>{mapping.context}</code></td>
                    <td><code>{mapping.role}</code></td>
                    <td><code>{mapping.model ?? 'unknown'}</code></td>
                    <td><Provenance stamp={mapping.provenance} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}

          <h3>{t('adapterRecordedReadiness')}</h3>
          <dl className="inspector-dl">
            <dt>{t('adapterHealth')}</dt><dd><DimensionDetails dimension={adapter.health} format={(value) => `${value.ok ? t('adapterOk') : t('adapterNotOk')}${value.reason === undefined ? '' : ` — ${value.reason}`}`} /></dd>
            <dt>{t('adapterCalibration')}</dt><dd><DimensionDetails dimension={adapter.calibration} format={(value) => `${value.recordType} · ${value.outcome}`} /></dd>
            <dt>{t('adapterConformance')}</dt><dd><DimensionDetails dimension={adapter.conformance} format={(value) => value.modelVersion} /></dd>
          </dl>
          {adapter.calibration.status === 'known' && (
            <details><summary>{t('adapterCalibrationMetrics')}</summary><dl className="inspector-dl">
              {Object.entries(adapter.calibration.value.metrics).map(([key, value]) => (
                <div className="definition-row" key={key}><dt><code>{key}</code></dt><dd><code>{String(value)}</code></dd></div>
              ))}
            </dl></details>
          )}
          {adapter.conformance.status === 'known' && (
            <details open><summary>{t('aalConformance')}</summary><dl className="inspector-dl">
              {conformanceProbeRows(adapter.conformance.value).map((probe) => (
                <div className="definition-row" key={probe.id}>
                  <dt>{probe.id}</dt><dd>{probe.id === 'P7' ? t('aalSusceptibility', { value: String(probe.value) }) : probe.value === true ? t('aalPass') : t('aalFail')}</dd>
                </div>
              ))}
            </dl></details>
          )}
          {envelope.issues.length > 0 && (
            <details><summary>{t('projectionIssues', { count: envelope.issues.length })}</summary><ul>
              {envelope.issues.map((issue, index) => <li key={`${issue.field}:${index}`}><code>{issue.field}</code>: {issue.reason}</li>)}
            </ul></details>
          )}
          <p className="provenance-line">{t('projectionProjectorRead')} <time dateTime={envelope.readAt}>{envelope.readAt}</time></p>
        </>
      )}
    </section>
  );
}

export function Adapters({ route, navigate }: AdaptersProps): React.JSX.Element {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [adapters, setAdapters] = useState<readonly AdapterProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [eligibility, setEligibility] = useState<'all' | 'eligible' | 'ineligible' | 'unknown'>('all');
  const inspectorDialog = useRef<HTMLDialogElement>(null);
  const listRead = useRead<ProjectionEnvelope<Page<AdapterProjection>>>(
    `/api/control-center/adapters?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
  );
  const selectedId = route.item;
  const detailRead = useRead<ProjectionEnvelope<AdapterProjection>>(
    selectedId === null ? null : `/api/control-center/adapters/${encodeURIComponent(selectedId)}`,
  );

  useEffect(() => {
    if (listRead.state.kind !== 'data') return;
    const page = listRead.state.value.data;
    setAdapters((current) => cursor === null ? page.items : mergeAdapterPages(current, page.items));
    setNextCursor(page.nextCursor);
  }, [cursor, listRead.state]);

  const visible = filterAdapters(adapters, query, eligibility);
  const listEnvelope = valueFromRead(listRead);
  const inspector = selectedId === null ? null : <AdapterInspector idPrefix="adapter-inspector" id={selectedId} detail={detailRead} />;
  const refresh = (): void => {
    setCursor(null);
    if (cursor === null) listRead.retry();
  };

  return (
    <>
      <main id="workspace" className="shell-workspace" tabIndex={-1}>
        <div className="workspace-heading-row">
          <div><p className="workspace-kicker">adapters / catalog</p><h1>{t('adapterWorkspace')}</h1></div>
          <div>
            {inspector !== null && <button className="drawer-trigger" type="button" onClick={(event) => openModalDialog(inspectorDialog.current, event.currentTarget)}>{t('shellOpenInspector')}</button>}{' '}
            <button type="button" disabled={listRead.inFlight} onClick={refresh}>{t('adapterRefreshCatalog')}</button>
          </div>
        </div>
        <p>{t('adapterIntro')}</p>
        <ReadNotice result={listRead} />
        <div className="toolbar" role="group" aria-label={t('adapterFilters')}>
          <label>{t('commonSearch')} <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label>{t('adapterEligibility')} <select value={eligibility} onChange={(event) => setEligibility(event.target.value as typeof eligibility)}>
            <option value="all">all</option><option value="eligible">eligible</option><option value="ineligible">ineligible</option><option value="unknown">unknown</option>
          </select></label>
        </div>
        {listEnvelope !== null && <p className="provenance-line">{t('projectionProjectorRead')} <time dateTime={listEnvelope.readAt}>{listEnvelope.readAt}</time></p>}
        {visible.length === 0 ? <p>{t('adapterNoMatching')}</p> : (
          <div className="table-scroll" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">{t('adapterColumn')}</th><th scope="col">{t('adapterTransport')}</th><th scope="col">{t('adapterLineage')}</th><th scope="col">{t('adapterRegistration')}</th><th scope="col">{t('adapterHealth')}</th><th scope="col">{t('adapterConformance')}</th></tr></thead>
              <tbody>{visible.map((adapter) => {
                const next = { ...route, view: 'catalog', item: adapter.id };
                return (
                  <tr key={adapter.id}>
                    <th scope="row"><a href={encodeRoute(next)} onClick={(event) => routeClick(event, () => navigate(next))}><code>{adapter.id}</code></a></th>
                    <td><code>{adapter.transport}</code></td>
                    <td><code>{adapter.manifest.lineage ?? 'unknown'}</code></td>
                    <td>{adapter.registrationEligibility.state}{adapter.registrationEligibility.reasons.length === 0 ? '' : ` — ${adapter.registrationEligibility.reasons.join(', ')}`}</td>
                    <td>{compactDimension(adapter.health, (value) => value.ok ? t('adapterOk') : `${t('adapterNotOk')}${value.reason === undefined ? '' : ` — ${value.reason}`}`, (detail) => t('dimensionUnavailable', { reason: detail }))}</td>
                    <td>{compactDimension(adapter.conformance, (value) => `${value.modelVersion} · P7 ${value.p7SusceptibilityScore}`, (detail) => t('dimensionUnavailable', { reason: detail }))}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {nextCursor !== null && <button type="button" disabled={listRead.inFlight} onClick={() => setCursor(nextCursor)}>{t('adapterLoadMore')}</button>}
        {listEnvelope !== null && listEnvelope.issues.length > 0 && (
          <details><summary>{t('adapterCatalogIssues', { count: listEnvelope.issues.length })}</summary><ul>
            {listEnvelope.issues.map((issue, index) => <li key={`${issue.field}:${index}`}><code>{issue.field}</code>: {issue.reason}</li>)}
          </ul></details>
        )}
      </main>
      {inspector !== null && <aside className="shell-inspector" aria-label={t('adapterInspector')}>{inspector}</aside>}
      <dialog ref={inspectorDialog} className="drawer-dialog" aria-label={t('adapterInspector')}>
        <button data-initial-focus type="button" onClick={() => inspectorDialog.current?.close()}>{t('shellClose')}</button>
        {selectedId !== null && <AdapterInspector idPrefix="adapter-dialog-inspector" id={selectedId} detail={detailRead} />}
      </dialog>
    </>
  );
}
