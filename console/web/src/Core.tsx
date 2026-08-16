import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { openModalDialog } from './dialog.ts';
import { useI18n } from './I18nContext.tsx';
import {
  type BudgetProjection,
  filterCoreRuns,
  latestSequence,
  mergeCoreEvents,
  mergeRunPages,
  taskTransitions,
  type CoreEventProjection,
  type CoreRunDetail,
  type CoreRunList,
  type CoreRunSummary,
  type ProjectionEnvelope,
  type RecordedDimension,
  type TaskNode,
} from './logic/controlCenter.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { useRead, type ReadResult } from './useFetch.ts';

interface CoreProps {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}

function valueFromRead<T>(result: ReadResult<T>): T | null {
  if (result.state.kind === 'data') return result.state.value;
  return result.state.previous;
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

function Dimension<T>({ value, format }: { readonly value: RecordedDimension<T>; readonly format?: (item: T) => string }): React.JSX.Element {
  const { t } = useI18n();
  return value.status === 'known' ? (
    <span>{format === undefined ? String(value.value ?? t('coreNone')) : format(value.value)}</span>
  ) : (
    <span className="dimension-unavailable">{t('dimensionUnavailable', { reason: value.reason })}</span>
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

function CoreInspector({
  idPrefix,
  runId,
  detail,
  selectedTaskId,
  onSelectTask,
}: {
  readonly idPrefix: string;
  readonly runId: string;
  readonly detail: ReadResult<ProjectionEnvelope<CoreRunDetail>>;
  readonly selectedTaskId: string | null;
  readonly onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const envelope = valueFromRead(detail);
  const graph = envelope?.data.taskGraph;
  const tasks = graph?.status === 'known' ? graph.value.tasks : [];
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  return (
    <section aria-labelledby={`${idPrefix}-heading`}>
      <h2 id={`${idPrefix}-heading`}>{t('coreInspector')}</h2>
      <p><code>{runId}</code></p>
      <button type="button" onClick={() => copyText(runId)}>{t('coreCopyRunId')}</button>
      <ReadNotice result={detail} />
      {detail.state.kind === 'error' && detail.state.reason === 'http 404' && (
        <p role="alert">{t('coreSelectedUnavailable')}</p>
      )}
      {envelope !== null && (
        <>
          <dl className="inspector-dl">
            <dt>{t('coreLifecycle')}</dt>
            <dd><Dimension value={envelope.data.summary.lifecycle} /></dd>
            <dt>{t('coreCurrentTask')}</dt>
            <dd><Dimension value={envelope.data.summary.currentTaskId} /></dd>
            <dt>{t('corePendingApprovals')}</dt>
            <dd><Dimension value={envelope.data.summary.pendingApprovals} /></dd>
            <dt>{t('coreLatestSeq')}</dt>
            <dd><Dimension value={envelope.data.summary.latestSequence} /></dd>
          </dl>
          {graph?.status === 'known' ? (
            <section>
              <h3>{t('coreTaskGraph')}</h3>
              <p>{graph.value.mode} · {t('coreGraphHash')} <code>{graph.value.graphHash ?? 'unavailable'}</code></p>
              <ul className="task-list">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      aria-pressed={task.id === selectedTaskId}
                      onClick={() => onSelectTask(task.id)}
                    >
                      <code>{task.id}</code> {task.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : graph !== undefined ? (
            <p className="dimension-unavailable">{t('coreTaskGraphUnavailable', { reason: graph.reason })}</p>
          ) : null}
          {selectedTask !== null && (
            <TaskInspector
              task={selectedTask}
              gates={envelope.data.latestGatesByTask[selectedTask.id] ?? []}
              budget={envelope.data.budgetsByTask[selectedTask.id]}
            />
          )}
          {envelope.issues.length > 0 && (
            <details>
              <summary>{t('projectionIssues', { count: envelope.issues.length })}</summary>
              <ul>
                {envelope.issues.map((issue, index) => (
                  <li key={`${issue.field}:${index}`}><code>{issue.field}</code>: {issue.reason}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="provenance-line">{t('projectionProjectorRead')}: <time>{envelope.readAt}</time></p>
        </>
      )}
    </section>
  );
}

function TaskInspector({
  task,
  gates,
  budget,
}: {
  readonly task: TaskNode;
  readonly gates: CoreRunDetail['latestGatesByTask'][string];
  readonly budget: RecordedDimension<BudgetProjection> | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section aria-label={t('coreTaskAria', { id: task.id })}>
      <h3><code>{task.id}</code></h3>
      <dl className="inspector-dl">
        <dt>{t('coreState')}</dt><dd><Dimension value={task.state} /></dd>
        <dt>{t('coreRisk')}</dt><dd><Dimension value={task.risk} /></dd>
        <dt>{t('coreDiffBudget')}</dt><dd><Dimension value={task.diffBudget} /></dd>
        <dt>{t('coreDependsOn')}</dt><dd>{task.dependsOn.join(', ') || t('coreNone')}</dd>
        <dt>{t('coreSatisfies')}</dt><dd>{task.satisfies.join(', ') || t('coreNone')}</dd>
      </dl>
      <h4>{t('coreGateTiers')}</h4>
      {gates.length === 0 ? <p>{t('coreNoGate')}</p> : gates.map((gate) => (
        <section key={gate.tier} className="gate-result" aria-label={t('coreGateAria', { tier: gate.tier })}>
          <h5>{gate.tier}: {String(gate.verdict)} <small>seq {gate.sequence}</small></h5>
          {gate.evidence.length === 0 ? <p>{t('coreNoEvidence')}</p> : (
            <ul>
              {gate.evidence.map((evidence, index) => (
                <li key={`${evidence.ref}:${index}`}>
                  <code>{evidence.ref}</code>{' '}
                  <strong>{evidence.available ? t('coreEvidenceAvailable') : t('coreEvidenceUnavailable')}</strong>
                  {evidence.byteLength !== null && ` · ${evidence.byteLength} bytes`}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <h4>{t('coreBudget')}</h4>
      {budget === undefined ? <p>{t('coreNoBudget')}</p> : budget.status !== 'known' ? (
        <p className="dimension-unavailable">{t('dimensionUnavailable', { reason: budget.reason })}</p>
      ) : (
        <dl className="inspector-dl">
          <dt>{t('coreIterations')}</dt><dd>{budget.value.used.iterations} / {budget.value.cap.iterations}</dd>
          <dt>{t('coreCostUnits')}</dt><dd>{budget.value.used.costUnits} / {budget.value.cap.costUnits}</dd>
          <dt>{t('coreWallclock')}</dt><dd>{budget.value.used.wallclockMs} / {budget.value.cap.wallclockMs} ms</dd>
          <dt>{t('coreSourceTime')}</dt><dd><time>{budget.value.recordedAt}</time></dd>
        </dl>
      )}
    </section>
  );
}

function RunList({
  runs,
  route,
  navigate,
}: {
  readonly runs: readonly CoreRunSummary[];
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (runs.length === 0) return <p>{t('coreNoMatchingRuns')}</p>;
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <thead><tr><th scope="col">{t('coreRun')}</th><th scope="col">{t('coreLifecycle')}</th><th scope="col">{t('coreCurrentTask')}</th><th scope="col">{t('coreState')}</th><th scope="col">{t('corePending')}</th></tr></thead>
        <tbody>
          {runs.map((run) => {
            const next = { ...route, view: 'runs', item: run.runId };
            const currentTask = run.currentTaskId.status === 'known' ? run.currentTaskId.value : null;
            const currentState = currentTask === null ? run.taskStates.at(-1)?.currentState : run.taskStates.find((task) => task.taskId === currentTask)?.currentState;
            return (
              <tr key={run.runId}>
                <th scope="row"><a href={encodeRoute(next)} onClick={(event) => routeClick(event, () => navigate(next))}><code>{run.runId}</code></a></th>
                <td><Dimension value={run.lifecycle} /></td>
                <td><Dimension value={run.currentTaskId} /></td>
                <td>{currentState === undefined ? 'unavailable' : <Dimension value={currentState} />}</td>
                <td><Dimension value={run.pendingApprovals} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Core({ route, navigate }: CoreProps): React.JSX.Element {
  const { t } = useI18n();
  const [cursor, setCursor] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly CoreRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lifecycle, setLifecycle] = useState<'all' | 'active' | 'ended'>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [eventAfter, setEventAfter] = useState(0);
  const [events, setEvents] = useState<readonly CoreEventProjection[]>([]);
  const [nextEventCursor, setNextEventCursor] = useState<string | null>(null);
  const inspectorDialog = useRef<HTMLDialogElement>(null);

  const listRead = useRead<ProjectionEnvelope<CoreRunList>>(
    `/api/control-center/core/runs?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
  );
  const selectedRun = route.item;
  const detailRead = useRead<ProjectionEnvelope<CoreRunDetail>>(
    selectedRun === null ? null : `/api/control-center/core/runs/${encodeURIComponent(selectedRun)}`,
  );
  const eventRead = useRead<ProjectionEnvelope<{ readonly items: readonly CoreEventProjection[]; readonly nextCursor: string | null; readonly limit: number }>>(
    selectedRun === null ? null : `/api/control-center/core/runs/${encodeURIComponent(selectedRun)}/events?after=${eventAfter}&limit=50`,
  );

  useEffect(() => {
    if (listRead.state.kind !== 'data') return;
    const envelope = listRead.state.value;
    setRuns((current) => cursor === null ? envelope.data.page.items : mergeRunPages(current, envelope.data.page.items));
    setNextCursor(envelope.data.page.nextCursor);
  }, [cursor, listRead.state]);

  useEffect(() => {
    setSelectedTaskId(null);
    setEvents([]);
    setEventAfter(0);
    setNextEventCursor(null);
  }, [selectedRun]);

  useEffect(() => {
    const envelope = valueFromRead(detailRead);
    const graph = envelope?.data.taskGraph;
    if (graph?.status !== 'known') return;
    setSelectedTaskId((current) => graph.value.tasks.some((task) => task.id === current) ? current : (graph.value.tasks[0]?.id ?? null));
  }, [detailRead.state]);

  useEffect(() => {
    if (eventRead.state.kind !== 'data') return;
    const envelope = eventRead.state.value;
    setEvents((current) => eventAfter === 0 ? mergeCoreEvents([], envelope.data.items) : mergeCoreEvents(current, envelope.data.items));
    setNextEventCursor(envelope.data.nextCursor);
  }, [eventAfter, eventRead.state]);

  const listEnvelope = valueFromRead(listRead);
  const visibleRuns = filterCoreRuns(runs, query, lifecycle);
  const transitions = taskTransitions(events);
  const hasInspector = selectedRun !== null;
  const inspector = selectedRun === null ? null : (
    <CoreInspector
      idPrefix="core-inspector"
      runId={selectedRun}
      detail={detailRead}
      selectedTaskId={selectedTaskId}
      onSelectTask={setSelectedTaskId}
    />
  );

  const refreshEvents = (): void => {
    const after = latestSequence(events);
    if (eventAfter === after) eventRead.retry();
    else setEventAfter(after);
  };

  return (
    <>
      <main id="workspace" className="shell-workspace" tabIndex={-1}>
        <div className="workspace-heading-row">
          <div>
            <p className="workspace-kicker">core / runs</p>
            <h1>{t('coreWorkspace')}</h1>
          </div>
          {hasInspector && (
            <button className="drawer-trigger" type="button" onClick={(event) => openModalDialog(inspectorDialog.current, event.currentTarget)}>{t('shellOpenInspector')}</button>
          )}
        </div>
        <p>{t('coreIntro')}</p>
        <ReadNotice result={listRead} />
        <div className="toolbar" role="group" aria-label={t('coreFilters')}>
          <label>{t('commonSearch')} <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label>{t('coreLifecycle')} <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value as typeof lifecycle)}>
            <option value="all">all</option><option value="active">active</option><option value="ended">ended</option>
          </select></label>
          <button type="button" onClick={() => { setCursor(null); if (cursor === null) listRead.retry(); }}>{t('coreRefreshRuns')}</button>
        </div>
        {listEnvelope !== null && (
          <p className="provenance-line">
            {t('coreSummary', { active: listEnvelope.data.totals.activeRuns, pending: listEnvelope.data.totals.pendingApprovals })} {t('projectionProjectorRead')} <time>{listEnvelope.readAt}</time>
          </p>
        )}
        <RunList runs={visibleRuns} route={route} navigate={navigate} />
        {nextCursor !== null && <button type="button" disabled={listRead.inFlight} onClick={() => setCursor(nextCursor)}>{t('coreLoadMoreRuns')}</button>}

        {selectedRun !== null && (
          <section aria-labelledby="core-events-heading">
            <div className="workspace-heading-row">
              <h2 id="core-events-heading">{t('coreAuditEvents')}</h2>
              <div>
                <button type="button" disabled={eventRead.inFlight || nextEventCursor !== null} onClick={refreshEvents}>{t('coreRefreshAfterSeq', { seq: latestSequence(events) })}</button>{' '}
                {nextEventCursor !== null && (
                  <button type="button" disabled={eventRead.inFlight} onClick={() => setEventAfter(Number(nextEventCursor))}>{t('coreLoadMoreEvents')}</button>
                )}
              </div>
            </div>
            <ReadNotice result={eventRead} />
            <p>{t('coreTransitionSummary', { transitions: transitions.length, events: events.length })}</p>
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">seq</th><th scope="col">{t('coreSourceTime')}</th><th scope="col">{t('coreTask')}</th><th scope="col">{t('coreType')}</th><th scope="col">{t('coreFields')}</th></tr></thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={event.seq}>
                      <td><code>{event.seq}</code></td>
                      <td><time>{event.ts}</time></td>
                      <td><code>{event.taskId ?? '—'}</code></td>
                      <td><code>{event.type}</code></td>
                      <td><code>{Object.entries(event.fields).map(([key, value]) => `${key}=${String(value)}`).join(' · ') || '—'}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
      {hasInspector && <aside className="shell-inspector" aria-label={t('coreInspector')}>{inspector}</aside>}
      <dialog ref={inspectorDialog} className="drawer-dialog" aria-label={t('coreInspector')}>
        <button data-initial-focus type="button" onClick={() => inspectorDialog.current?.close()}>{t('shellClose')}</button>
        {selectedRun !== null && (
          <CoreInspector
            idPrefix="core-dialog-inspector"
            runId={selectedRun}
            detail={detailRead}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
          />
        )}
      </dialog>
    </>
  );
}
