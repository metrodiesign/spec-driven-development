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
import { useFetch } from './useFetch.ts';

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
  const runsRes = useFetch<{ runs: RunSummary[] }>('/api/loop/runs');
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [approvals, setApprovals] = useState<object[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [guidance, setGuidance] = useState('');
  const [pollError, setPollError] = useState<string | null>(null);

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
    if (selected === null) return;
    let alive = true;
    let since = 0;
    // Skip a tick while the previous poll is still in flight: two overlapping slow
    // polls would read the same `since` (only advanced after the await), refetch the
    // same events, and append both -> duplicated events / double-counted probes
    // (PR #50 review).
    let inFlight = false;
    const run = encodeURIComponent(selected);
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const [evRes, apRes, depRes] = await Promise.all([
          fetch(`/api/loop/${run}/events?since=${since}`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }),
          fetch(`/api/loop/${run}/approvals`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }),
          fetch(`/api/loop/${run}/deploy`, { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }),
        ]);
        if (!alive) return;
        if (evRes.ok) {
          const fresh = (await evRes.json()) as LoopEvent[];
          since = nextSince(since, fresh);
          if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
        }
        if (apRes.ok) setApprovals((await apRes.json()) as object[]);
        // GET /deploy is 501 on a server without deploy composed (REQ-6.3 Phase-1
        // pattern) — deployCardVisible(null) hides the card, same as a network failure;
        // that is expected steady-state, not folded into the pollError banner below.
        setDeployStatus(depRes.ok ? ((await depRes.json()) as DeployStatus) : null);
        setPollError(
          evRes.ok && apRes.ok ? null : tRef.current('loopPollFailed', { events: evRes.status, approvals: apRes.status }),
        );
      } catch {
        if (alive) setPollError(tRef.current('loopPollFailedNetwork'));
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selected]);

  const run =
    selected === null || runsRes.kind !== 'data' ? null : (runsRes.value.runs.find((r) => r.runId === selected) ?? null);
  const ended = run?.ended ?? false;
  const state = latestTaskState(events);
  const controls = steeringControls(ended, state);
  const packages = taskApprovalPackages(approvals);
  const deployVisible = deployCardVisible(deployStatus);
  const deployPkg = deployStatus?.approval ?? null;
  const deployProbes = deployProbeSummary(events);
  const canRollback = canRollbackDeploy(deployStatus?.state ?? null);

  const mutate = async (path: string, body?: unknown): Promise<void> => {
    if (selected === null) return;
    const res = await fetch(`/api/loop/${encodeURIComponent(selected)}${path}`, {
      method: 'POST',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    setPollError(res.ok ? null : t('loopActionFailed', { path, status: res.status }));
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
        {runsRes.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : runsRes.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : runsRes.value.runs.length === 0 ? (
          <p>{t('loopNoRuns')}</p>
        ) : (
          <ul>
            {runsRes.value.runs.map((r) => (
              <li key={r.runId}>
                <button type="button" onClick={() => setSelected(r.runId)} aria-current={selected === r.runId}>
                  {r.runId}
                </button>{' '}
                <small>({r.ended ? t('loopStateEnded') : t('loopStateLive')})</small>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null && (
        <div style={box} aria-label={t('loopSelectedRunAriaLabel')}>
          <h3>
            <code>{selected}</code> — <span role="status">{stateBadge(ended, state)}</span>
          </h3>
          {pollError !== null && <p role="alert">{pollError}</p>}

          <div>
            <button type="button" disabled={!controls.canPause} onClick={() => void mutate('/steering/pause')}>
              {t('loopPause')}
            </button>{' '}
            <button type="button" disabled={!controls.canResume} onClick={() => void mutate('/steering/resume')}>
              {t('loopResume')}
            </button>{' '}
            {/* Kill has no state gate server-side (unlike pause/resume/inject) — only "is this run live" applies. */}
            <button type="button" disabled={ended} onClick={() => void mutate('/kill')}>
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
              disabled={!controls.canInject || guidance.length === 0}
              onClick={() => {
                void mutate('/steering/inject', { guidance, atNextBoundary: controls.injectAtNextBoundary });
                setGuidance('');
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
              onToggle={(text) => toggleAttestation(deployPkg.id, text)}
              onDecide={(decision) =>
                void mutate('/deploy/decision', { decision, attestations: checked[deployPkg.id] ?? [] })
              }
            />
          )}
          {canRollback && (
            <button type="button" onClick={() => void mutate('/deploy/rollback')}>
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
  onToggle,
  onDecide,
}: {
  pkg: LoopApprovalPackage;
  checkedIds: string[];
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
      <button type="button" disabled={!canApprove(pkg, checkedIds)} onClick={() => onDecide('approve')}>
        {t('approve')}
      </button>{' '}
      <button type="button" onClick={() => onDecide('reject')}>
        {t('reject')}
      </button>
    </div>
  );
}
