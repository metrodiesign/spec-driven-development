// F-Loop (REQ-15): read the loop and approve/steer/kill from the web, so
// autonomous supervision does not require a terminal on the host. Thin view —
// display shaping + control gating live in logic/loop.ts.

import { useEffect, useRef, useState } from 'react';

import {
  attestationChecklist,
  canApprove,
  canRollbackDeploy,
  deployCardVisible,
  deployProbeSummary,
  goalProvenanceLine,
  latestTaskState,
  nextSince,
  stateBadge,
  steeringControls,
  taskApprovalPackages,
  type DeployStatus,
  type LoopApprovalPackage,
  type LoopEvent,
} from './logic/loop.ts';
import { useI18n } from './I18nContext.tsx';
import { mergeNamedRecords } from './logic/console.ts';
import { destructiveConfirmationText } from './logic/mutation.ts';
import { mergeBySequence } from './logic/readState.ts';
import { protectedFetch, useRead } from './useFetch.ts';
import { usePendingMutation } from './usePendingMutation.ts';

interface RunSummary {
  runId: string;
  ended: boolean;
}

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};
const POLL_MS = 3000;
// A hung fetch (e.g. the proxy waiting on a stale Human Plane upstream) never settles,
// so without a timeout it would hold `inFlight` true forever and freeze all later ticks.
// Abort comfortably above POLL_MS so a slow-but-live poll still completes (PR #64 review).
const POLL_TIMEOUT_MS = 10_000;

export function Loop(): React.JSX.Element {
  const { t } = useI18n();
  const [runCursor, setRunCursor] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [nextRunCursor, setNextRunCursor] = useState<string | null>(null);
  const runsRes = useRead<{ runs: RunSummary[]; nextCursor: string | null }>(
    `/api/loop/runs?limit=50${runCursor === null ? '' : `&cursor=${encodeURIComponent(runCursor)}`}`,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [approvals, setApprovals] = useState<object[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [guidance, setGuidance] = useState('');
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const pollNowRef = useRef<() => void>(() => {});
  const mutations = usePendingMutation();

  useEffect(() => {
    if (runsRes.state.kind !== 'data') return;
    const page = runsRes.state.value;
    setRuns((current) => runCursor === null
      ? page.runs
      : mergeNamedRecords(current, page.runs, (run) => run.runId));
    setNextRunCursor(page.nextCursor);
  }, [runCursor, runsRes.state]);

  // The polling effect below intentionally depends only on [selected] (re-running it
  // on every locale change would reset events/approvals/deployStatus needlessly) — so
  // poll() reads the translator through this ref instead of closing over `t` directly,
  // else error messages would stay in whatever language was active when the run was
  // selected, even after a later locale toggle (PR #50 review).
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  // Poll approvals + events since= the last seen seq (REQ-15.8) while a run is selected.
  useEffect(() => {
    setEvents([]);
    setApprovals([]);
    setDeployStatus(null);
    setPollError(null);
    setLastReadAt(null);
    setActionNote(null);
    if (selected === null) return;
    let alive = true;
    let since = 0;
    // Skip a tick while the previous poll is still in flight: two overlapping slow
    // polls would read the same `since` (only advanced after the await), refetch the
    // same events, and append both -> duplicated events / double-counted probes
    // (PR #50 review).
    let inFlight = false;
    let controller: AbortController | null = null;
    const run = encodeURIComponent(selected);
    const poll = async (): Promise<void> => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), POLL_TIMEOUT_MS);
      try {
        const [evRes, apRes, depRes] = await Promise.all([
          protectedFetch(`/api/loop/${run}/events?since=${since}&limit=50`, { signal: controller.signal }),
          protectedFetch(`/api/loop/${run}/approvals`, { signal: controller.signal }),
          protectedFetch(`/api/loop/${run}/deploy`, { signal: controller.signal }),
        ]);
        if (!alive) return;
        if (evRes.ok) {
          const fresh = (await evRes.json()) as LoopEvent[];
          since = nextSince(since, fresh);
          if (fresh.length > 0) setEvents((current) => [...mergeBySequence(current, fresh)]);
        }
        if (apRes.ok) setApprovals((await apRes.json()) as object[]);
        // GET /deploy is 501 on a server without deploy composed (REQ-6.3 Phase-1
        // pattern) — deployCardVisible(null) hides the card, same as a network failure;
        // that is expected steady-state, not folded into the pollError banner below.
        setDeployStatus(depRes.ok ? ((await depRes.json()) as DeployStatus) : null);
        setPollError(
          evRes.ok && apRes.ok ? null : tRef.current('loopPollFailed', { events: evRes.status, approvals: apRes.status }),
        );
        if (evRes.ok && apRes.ok) setLastReadAt(new Date().toISOString());
      } catch {
        if (alive && controller?.signal.aborted !== true) setPollError(tRef.current('loopPollFailedNetwork'));
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
        controller = null;
      }
    };
    pollNowRef.current = () => void poll();
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    const onVisibility = (): void => { if (document.visibilityState === 'visible') void poll(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
      pollNowRef.current = () => {};
    };
  }, [selected]);

  const run =
    selected === null ? null : (runs.find((candidate) => candidate.runId === selected) ?? null);
  const ended = run?.ended ?? false;
  const state = latestTaskState(events);
  const controls = steeringControls(ended, state);
  const packages = taskApprovalPackages(approvals);
  const deployVisible = deployCardVisible(deployStatus);
  const deployPkg = deployStatus?.approval ?? null;
  const deployProbes = deployProbeSummary(events);
  const canRollback = canRollbackDeploy(deployStatus?.state ?? null);

  const mutationIdentity = (path: string) => ({ action: path, target: selected ?? '', concurrencyKey: null });

  const mutate = async (path: string, body?: unknown): Promise<boolean> => {
    if (selected === null) return false;
    const result = await mutations.run(mutationIdentity(path), async () => {
      try {
        const res = await protectedFetch(`/api/loop/${encodeURIComponent(selected)}${path}`, {
          method: 'POST',
          ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        const responseBody = await res.json().catch(() => null) as unknown;
        if (!res.ok) {
          const reason = typeof responseBody === 'object' && responseBody !== null && 'error' in responseBody
            ? String((responseBody as { error: unknown }).error)
            : String(res.status);
          setPollError(t('loopActionFailed', { path, status: reason }));
          return false;
        }
        setPollError(null);
        setActionNote(`${path}: ${JSON.stringify(responseBody)}`);
        pollNowRef.current();
        return true;
      } catch {
        setPollError(t('loopPollFailedNetwork'));
        return false;
      }
    });
    return result === true;
  };

  const toggleAttestation = (pkgId: string, text: string): void => {
    setChecked((prev) => {
      const current = new Set(prev[pkgId] ?? []);
      if (current.has(text)) current.delete(text);
      else current.add(text);
      return { ...prev, [pkgId]: [...current] };
    });
  };

  return (
    <section aria-label="F-Loop">
      <h2>{t('loopHeading')}</h2>

      <div style={box} aria-label={t('loopRunsHeading')}>
        <h3>{t('loopRunsHeading')}</h3>
        {runsRes.state.kind === 'loading' && runs.length === 0 ? (
          <p role="status">{t('loading')}</p>
        ) : runsRes.state.kind === 'error' && runs.length === 0 ? (
          <p role="alert">{t('fetchUnavailable')} <button type="button" onClick={runsRes.retry}>{t('shellRetry')}</button></p>
        ) : runs.length === 0 ? (
          <p>{t('loopNoRuns')}</p>
        ) : (
          <ul>
            {runs.map((r) => (
              <li key={r.runId}>
                <button type="button" onClick={() => setSelected(r.runId)} aria-current={selected === r.runId}>
                  {r.runId}
                </button>{' '}
                <small>({r.ended ? t('loopStateEnded') : t('loopStateLive')})</small>
              </li>
            ))}
          </ul>
        )}
        {runsRes.state.kind === 'error' && runs.length > 0 && (
          <p role="alert">{t('consoleStaleAt', { time: runsRes.state.readAt ?? 'unknown' })}{' '}
            <button type="button" onClick={runsRes.retry}>{t('shellRetry')}</button>
          </p>
        )}
        {nextRunCursor !== null && (
          <button type="button" disabled={runsRes.inFlight} onClick={() => setRunCursor(nextRunCursor)}>{t('consoleLoadMore')}</button>
        )}
      </div>

      {selected !== null && (
        <div style={box} aria-label={t('loopSelectedRunAriaLabel')}>
          <h3>
            <code>{selected}</code> — <span role="status">{stateBadge(ended, state)}</span>
          </h3>
          {pollError !== null && (
            <p role="alert">
              {pollError}{lastReadAt === null ? '' : ` · ${t('consoleStaleAt', { time: lastReadAt })}`}{' '}
              <button type="button" onClick={() => pollNowRef.current()}>{t('shellRetry')}</button>
            </p>
          )}
          {actionNote !== null && <p role="status"><code>{actionNote}</code></p>}

          <div>
            <button type="button" disabled={!controls.canPause || mutations.isPending(mutationIdentity('/steering/pause'))} onClick={() => void mutate('/steering/pause')}>
              {t('loopPause')}
            </button>{' '}
            <button type="button" disabled={!controls.canResume || mutations.isPending(mutationIdentity('/steering/resume'))} onClick={() => void mutate('/steering/resume')}>
              {t('loopResume')}
            </button>{' '}
            {/* Kill has no state gate server-side (unlike pause/resume/inject) — only "is this run live" applies. */}
            <button
              type="button"
              disabled={ended || mutations.isPending(mutationIdentity('/kill'))}
              onClick={() => {
                if (window.confirm(destructiveConfirmationText(t('loopKill'), selected))) void mutate('/kill');
              }}
            >
              {t('loopKill')}
            </button>
          </div>

          <div>
            <label>
              {t('loopSteeringGuidanceLabel')}{' '}
              <input value={guidance} onChange={(e) => setGuidance(e.target.value)} disabled={!controls.canInject} />
            </label>{' '}
            <button
              type="button"
              disabled={!controls.canInject || guidance.length === 0 || mutations.isPending(mutationIdentity('/steering/inject'))}
              onClick={() => {
                void mutate('/steering/inject', { guidance, atNextBoundary: controls.injectAtNextBoundary })
                  .then((saved) => { if (saved) setGuidance(''); });
              }}
            >
              {controls.injectAtNextBoundary ? t('loopQueueAtNextBoundary') : t('loopInjectNow')}
            </button>
          </div>

          <h4>{t('loopApprovalPackagesHeading')}</h4>
          {packages.length === 0 ? (
            <p>{t('loopNonePending')}</p>
          ) : (
            packages.map((p) => (
              <ApprovalCard
                key={p.id}
                pkg={p}
                checkedIds={checked[p.id] ?? []}
                disabled={mutations.isPending(mutationIdentity(`/approvals/${encodeURIComponent(p.id)}`))}
                onToggle={(text) => toggleAttestation(p.id, text)}
                onDecide={(decision) =>
                  void mutate(`/approvals/${encodeURIComponent(p.id)}`, { decision, attestations: checked[p.id] ?? [] })
                }
              />
            ))
          )}
        </div>
      )}

      {selected !== null && deployVisible && (
        <div style={box} aria-label={t('loopDeployHeading')}>
          <h4>
            {t('loopDeployHeading')} <small>{t('loopDeploySimulationNote')}</small>
          </h4>
          <p>
            {t('loopDeployStateLabel')} <strong>{deployStatus?.state ?? t('loopDeployStatePending')}</strong>
            {deployProbes !== null && (
              <>
                {' '}
                {t('loopProbesSummary', { pass: deployProbes.pass, fail: deployProbes.fail })}
              </>
            )}
          </p>
          {deployPkg !== null && (
            <ApprovalCard
              pkg={deployPkg}
              checkedIds={checked[deployPkg.id] ?? []}
              disabled={mutations.isPending(mutationIdentity('/deploy/decision'))}
              onToggle={(text) => toggleAttestation(deployPkg.id, text)}
              onDecide={(decision) =>
                void mutate('/deploy/decision', { decision, attestations: checked[deployPkg.id] ?? [] })
              }
            />
          )}
          {canRollback && (
            <button
              type="button"
              disabled={mutations.isPending(mutationIdentity('/deploy/rollback'))}
              onClick={() => {
                if (window.confirm(destructiveConfirmationText(t('loopRollBackButton'), selected))) void mutate('/deploy/rollback');
              }}
            >
              {t('loopRollBackButton')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ApprovalCard({
  pkg,
  checkedIds,
  disabled,
  onToggle,
  onDecide,
}: {
  pkg: LoopApprovalPackage;
  checkedIds: string[];
  disabled: boolean;
  onToggle: (text: string) => void;
  onDecide: (decision: 'approve' | 'reject') => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const rows = attestationChecklist(pkg, checkedIds);
  return (
    <div style={box} aria-label={t('loopApprovalAriaLabel', { id: pkg.id })}>
      <p>
        {t('loopTaskPrefix')} <code>{pkg.taskId}</code> {t('loopRiskInfix')} <strong>{pkg.riskClass}</strong>{' '}
        {t('loopAcsInfix')} {pkg.acIds.join(', ')}
      </p>
      <p>{pkg.goalExcerpt}</p>
      {goalProvenanceLine(pkg) !== null && (
        <p>
          {t('loopProvenanceHeading')} <code>{goalProvenanceLine(pkg)}</code>
        </p>
      )}
      {pkg.unresolvedRisks.length > 0 && (
        <p role="status">
          {t('loopUnresolvedPrefix')} {pkg.unresolvedRisks.join('; ')}
        </p>
      )}
      <fieldset>
        <legend>{t('loopAttestationsLegend')}</legend>
        {rows.map((row) => (
          <label key={row.text} style={{ display: 'block' }}>
            <input type="checkbox" checked={row.checked} onChange={() => onToggle(row.text)} />
            {row.text}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={disabled || !canApprove(pkg, checkedIds)} onClick={() => onDecide('approve')}>
        {t('approve')}
      </button>{' '}
      <button type="button" disabled={disabled} onClick={() => onDecide('reject')}>
        {t('reject')}
      </button>
    </div>
  );
}
