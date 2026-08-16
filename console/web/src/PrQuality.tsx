import { useEffect, useRef, useState } from 'react';

import { useI18n } from './I18nContext.tsx';
import {
  canCancel,
  canOverride,
  decisionTone,
  semanticStatus,
  type PrGateDetail,
  type PrGateProjection,
} from './logic/pr-quality.ts';
import { destructiveConfirmationText } from './logic/mutation.ts';
import { usePendingMutation } from './usePendingMutation.ts';
import { protectedFetch } from './useFetch.ts';

const POLL_MS = 4000;
const box: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.75rem', marginBottom: '0.75rem', overflowWrap: 'anywhere',
};

export function PrQuality(): React.JSX.Element {
  const { t } = useI18n();
  const [runs, setRuns] = useState<PrGateProjection[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PrGateDetail | null>(null);
  const [repository, setRepository] = useState('');
  const [pullRequest, setPullRequest] = useState('');
  const [reason, setReason] = useState('');
  const [findingIds, setFindingIds] = useState('');
  const [action, setAction] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [overrideKey, setOverrideKey] = useState(() => crypto.randomUUID());
  const [note, setNote] = useState<string | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsReadAt, setRunsReadAt] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const runsInFlight = useRef(false);
  const runsController = useRef<AbortController | null>(null);
  const refreshDetailRef = useRef<() => void>(() => {});
  const mutations = usePendingMutation();

  const refreshRuns = async (): Promise<void> => {
    if (runsInFlight.current) return;
    runsInFlight.current = true;
    runsController.current = new AbortController();
    try {
      const response = await protectedFetch('/api/pr-quality/runs?limit=50', { signal: runsController.current.signal });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { runs: PrGateProjection[] };
      setRuns(body.runs);
      setRunsError(null);
      setRunsReadAt(new Date().toISOString());
    } catch (error) {
      if (runsController.current?.signal.aborted !== true) {
        setRunsError(error instanceof Error ? error.message : t('prGateUnavailable'));
      }
    } finally {
      runsController.current = null;
      runsInFlight.current = false;
    }
  };

  useEffect(() => {
    const poll = (): void => { if (document.visibilityState === 'visible') void refreshRuns(); };
    poll();
    const timer = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
      runsController.current?.abort();
    };
  }, []);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (selected === null) return;
    let alive = true;
    let inFlight = false;
    let controller: AbortController | null = null;
    const refresh = async (): Promise<void> => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      controller = new AbortController();
      try {
        const response = await protectedFetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as PrGateDetail;
        if (alive) {
          setDetail(body);
          setDetailError(null);
        }
      } catch (error) {
        if (alive && controller?.signal.aborted !== true) {
          setDetailError(error instanceof Error ? error.message : t('prDetailUnavailable', { detail: '' }));
        }
      } finally {
        inFlight = false;
        controller = null;
      }
    };
    refreshDetailRef.current = () => void refresh();
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onVisibility = (): void => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      controller?.abort();
      refreshDetailRef.current = () => {};
    };
  }, [selected]);

  const start = async (): Promise<void> => {
    await mutations.run({ action: 'pr-start', target: `${repository}#${pullRequest}`, concurrencyKey: null }, async () => {
      setNote(null);
      const response = await protectedFetch('/api/pr-quality/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository, pullRequest: Number(pullRequest) }),
      }).catch(() => null);
      if (response === null || !response.ok) {
        const body = response === null ? null : await response.json().catch(() => null) as { error?: string } | null;
        setNote(`${t('prStartFailed')}${body?.error === undefined ? '' : `: ${body.error}`}`);
        return;
      }
      const body = await response.json() as { runId: string };
      setNote(t('prStartQueued', { id: body.runId }));
      setSelected(body.runId);
      await refreshRuns();
    });
  };

  const cancel = async (): Promise<void> => {
    if (selected === null) return;
    await mutations.run({ action: 'pr-cancel', target: selected, concurrencyKey: null }, async () => {
      const response = await protectedFetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}/cancel`, { method: 'POST' }).catch(() => null);
      const body = response === null ? null : await response.json().catch(() => null) as PrGateProjection | { error?: string } | null;
      if (response === null || !response.ok) {
        setNote(`${t('prCancelFailed')}${body !== null && 'error' in body && body.error !== undefined ? `: ${body.error}` : ''}`);
        return;
      }
      setNote(t('prCancelResult', { state: (body as PrGateProjection).state, id: selected }));
      await refreshRuns();
      refreshDetailRef.current();
    });
  };

  const override = async (): Promise<void> => {
    if (selected === null || detail?.headStatus === null || detail?.headStatus === undefined) return;
    await mutations.run({ action: 'pr-override', target: selected, concurrencyKey: overrideKey }, async () => {
      const response = await protectedFetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}/override`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': overrideKey },
        body: JSON.stringify({
          headSha: detail.headStatus?.currentHeadSha,
          action,
          reason,
          findingIds: findingIds.split(',').map((value) => value.trim()).filter(Boolean),
        }),
      }).catch(() => null);
      const body = response === null ? null : await response.json().catch(() => null) as { error?: string; action?: string } | null;
      if (response === null || !response.ok) {
        setNote(response?.status === 409 ? t('prOverrideRejected') : `${t('prOverrideFailed')}${body?.error === undefined ? '' : `: ${body.error}`}`);
        return;
      }
      setNote(t('prOverrideRecorded', { action: body?.action ?? action, id: selected }));
      setReason('');
      setFindingIds('');
      setOverrideKey(crypto.randomUUID());
      refreshDetailRef.current();
    });
  };

  const tone = decisionTone(detail?.effectiveDecision ?? null);
  const failures = detail?.deterministicReport?.checks.filter((check) => check.status !== 'PASSED') ?? [];

  return (
    <section aria-label={t('prGateAria')}>
      <h2>{t('prGateHeading')}</h2>
      {note !== null && <p role="status">{note}</p>}
      {runsError !== null && (
        <p role="alert">
          {runs.length === 0 ? t('prGateUnavailable') : t('prGateStaleRuns', { time: runsReadAt ?? 'unknown' })}{' '}
          <small><code>{runsError}</code></small>{' '}
          <button type="button" onClick={() => void refreshRuns()}>{t('shellRetry')}</button>
        </p>
      )}

      <form style={box} onSubmit={(event) => { event.preventDefault(); void start(); }} aria-label={t('prStartAria')}>
        <h3>{t('prStartHeading')}</h3>
        <label>
          {t('prRepository')}{' '}
          <input required pattern="[^/\s]+/[^/\s]+" value={repository} onChange={(event) => setRepository(event.target.value)} />
        </label>{' '}
        <label>
          {t('prPullRequest')}{' '}
          <input required type="number" min="1" value={pullRequest} onChange={(event) => setPullRequest(event.target.value)} />
        </label>{' '}
        <button
          type="submit"
          disabled={mutations.isPending({ action: 'pr-start', target: `${repository}#${pullRequest}`, concurrencyKey: null })}
        >
          {t('prStartReview')}
        </button>
      </form>

      <div style={box} aria-label={t('prRunsAria')}>
        <h3>{t('prRuns')}</h3>
        {runs.length === 0 ? <p>{t('prNoRuns')}</p> : (
          <ul>
            {runs.map((run) => (
              <li key={run.runId}>
                <button type="button" aria-current={selected === run.runId} onClick={() => setSelected(run.runId)}>
                  {run.runId}
                </button>{' '}
                <span>{semanticStatus(run)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null && detail === null && <p role="status">{t('prLoadingDetail')}</p>}
      {detailError !== null && (
        <p role="alert">{t('prDetailUnavailable', { detail: detailError })}{' '}
          <button type="button" onClick={() => refreshDetailRef.current()}>{t('shellRetry')}</button>
        </p>
      )}
      {detail !== null && (
        <div style={box} aria-label={t('prSelectedAria')}>
          <h3><code>{detail.runId}</code></h3>
          <p className={`prq-status prq-${tone}`} role="status">{semanticStatus(detail)}</p>
          <p>{t('prSystemDecision')} <strong>{detail.systemDecision ?? 'pending'}</strong></p>
          <p>{t('prEffectiveDecision')} <strong>{detail.effectiveDecision ?? 'pending'}</strong></p>
          <p>{t('prPublication')} <strong>{detail.publication}</strong></p>
          <p>
            {t('prReviewedHead')} <code>{detail.headStatus?.reviewedHeadSha ?? detail.headSha ?? 'pending'}</code><br />
            {t('prCurrentHead')} <code>{detail.headStatus?.currentHeadSha ?? 'unavailable'}</code><br />
            {t('prHeadStatus')} <strong>{detail.headStatus?.stale === true ? t('prStaleOverrideDisabled') : t('prCurrent')}</strong>
          </p>
          <button
            type="button"
            disabled={!canCancel(detail.state) || mutations.isPending({ action: 'pr-cancel', target: detail.runId, concurrencyKey: null })}
            onClick={() => {
              if (window.confirm(destructiveConfirmationText(t('prCancelConfirm'), detail.runId))) void cancel();
            }}
          >
            {t('prCancel')}
          </button>

          <h4>{t('prDeterministicFailures')}</h4>
          {detail.deterministicReport === null ? <p>{t('commonPending')}</p> : failures.length === 0 ? <p>{t('commonNone')}</p> : (
            <ul>{failures.map((check) => <li key={check.id}><code>{check.id}</code>: {check.status} · <code>{check.evidenceRef}</code></li>)}</ul>
          )}

          <h4>{t('prAiFindings')}</h4>
          {detail.judgedFindings.length === 0 ? <p>{t('prNonePending')}</p> : (
            <ul>{detail.judgedFindings.map((finding) => (
              <li key={finding.canonicalFindingKey}>
                <code>{finding.canonicalFindingKey}</code>: {finding.severity} · {finding.classification}
              </li>
            ))}</ul>
          )}

          <h4>{t('prCoverageCost')}</h4>
          <p>
            {t('prAnalysis')} <strong>{detail.systemReport?.analysisCoverage ?? 'pending'}</strong> · {t('prReviewer')}{' '}
            <strong>{detail.systemReport?.reviewerCoverage ?? 'pending'}</strong> · {t('prCostUnits')}{' '}
            <strong>{detail.systemReport?.costUnits ?? 0}</strong>
          </p>
          <ul>{detail.reviewerStatuses.map((reviewer) => <li key={reviewer.adapterId}>{reviewer.adapterId}: {reviewer.status}</li>)}</ul>

          <h4>{t('prHumanOverride')}</h4>
          <form onSubmit={(event) => {
            event.preventDefault();
            if (window.confirm(destructiveConfirmationText(t('prOverrideConfirm', { action }), detail.runId))) void override();
          }}>
            <label>
              {t('prAction')}{' '}
              <select value={action} onChange={(event) => setAction(event.target.value as 'APPROVE' | 'REJECT')} disabled={!canOverride(detail)}>
                <option value="APPROVE">{t('prApprove')}</option>
                <option value="REJECT">{t('prReject')}</option>
              </select>
            </label>{' '}
            <label>
              {t('prReason')}{' '}
              <input required value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canOverride(detail)} />
            </label>{' '}
            <label>
              {t('prFindingIds')}{' '}
              <input value={findingIds} onChange={(event) => setFindingIds(event.target.value)} disabled={!canOverride(detail)} />
            </label>{' '}
            <button
              type="submit"
              disabled={!canOverride(detail) || reason.trim() === '' || mutations.isPending({ action: 'pr-override', target: detail.runId, concurrencyKey: overrideKey })}
            >
              {t('prRecordOverride')}
            </button>
          </form>

          <h4>{t('prOverrideHistory')}</h4>
          {detail.overrideHistory.length === 0 ? <p>{t('commonNone')}</p> : (
            <ul>{detail.overrideHistory.map((item) => (
              <li key={item.overrideId}>{item.createdAt} · {item.action} {t('prBy')} {item.actor}: {item.reason}</li>
            ))}</ul>
          )}
        </div>
      )}
    </section>
  );
}
