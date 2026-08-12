import { useEffect, useState } from 'react';

import {
  canCancel,
  canOverride,
  decisionTone,
  semanticStatus,
  type PrGateDetail,
  type PrGateProjection,
} from './logic/pr-quality.ts';

const POLL_MS = 4000;
const box: React.CSSProperties = {
  border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.75rem', marginBottom: '0.75rem', overflowWrap: 'anywhere',
};

export function PrQuality(): React.JSX.Element {
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

  const refreshRuns = async (): Promise<void> => {
    try {
      const response = await fetch('/api/pr-quality/runs?limit=50');
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { runs: PrGateProjection[] };
      setRuns(body.runs);
    } catch {
      setNote('PR quality gate unavailable');
    }
  };

  useEffect(() => {
    void refreshRuns();
    const timer = setInterval(() => void refreshRuns(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setDetail(null);
    if (selected === null) return;
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}`);
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as PrGateDetail;
        if (alive) setDetail(body);
      } catch {
        if (alive) setNote('Run detail unavailable');
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [selected]);

  const start = async (): Promise<void> => {
    setNote(null);
    const response = await fetch('/api/pr-quality/runs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository, pullRequest: Number(pullRequest) }),
    }).catch(() => null);
    if (response === null || !response.ok) {
      setNote('Start failed');
      return;
    }
    const body = await response.json() as { runId: string };
    setSelected(body.runId);
    await refreshRuns();
  };

  const cancel = async (): Promise<void> => {
    if (selected === null) return;
    const response = await fetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}/cancel`, { method: 'POST' }).catch(() => null);
    setNote(response?.ok ? 'Cancellation requested' : 'Cancellation failed');
  };

  const override = async (): Promise<void> => {
    if (selected === null || detail?.headStatus === null || detail?.headStatus === undefined) return;
    const response = await fetch(`/api/pr-quality/runs/${encodeURIComponent(selected)}/override`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': overrideKey },
      body: JSON.stringify({
        headSha: detail.headStatus.currentHeadSha,
        action,
        reason,
        findingIds: findingIds.split(',').map((value) => value.trim()).filter(Boolean),
      }),
    }).catch(() => null);
    if (response === null || !response.ok) {
      setNote(response?.status === 409 ? 'Override rejected: head or run state changed' : 'Override failed');
      return;
    }
    setNote('Override recorded');
    setReason('');
    setFindingIds('');
    setOverrideKey(crypto.randomUUID());
  };

  const tone = decisionTone(detail?.effectiveDecision ?? null);
  const failures = detail?.deterministicReport?.checks.filter((check) => check.status !== 'PASSED') ?? [];

  return (
    <section aria-label="PR quality gate">
      <h2>PR Quality Gate</h2>
      {note !== null && <p role="status">{note}</p>}

      <form style={box} onSubmit={(event) => { event.preventDefault(); void start(); }} aria-label="Start PR quality run">
        <h3>Start run</h3>
        <label>
          Repository (owner/name){' '}
          <input required pattern="[^/\s]+/[^/\s]+" value={repository} onChange={(event) => setRepository(event.target.value)} />
        </label>{' '}
        <label>
          Pull request{' '}
          <input required type="number" min="1" value={pullRequest} onChange={(event) => setPullRequest(event.target.value)} />
        </label>{' '}
        <button type="submit">Start review</button>
      </form>

      <div style={box} aria-label="PR quality runs">
        <h3>Runs</h3>
        {runs.length === 0 ? <p>No runs</p> : (
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

      {selected !== null && detail === null && <p>Loading run detail…</p>}
      {detail !== null && (
        <div style={box} aria-label="Selected PR quality run">
          <h3><code>{detail.runId}</code></h3>
          <p className={`prq-status prq-${tone}`} role="status">{semanticStatus(detail)}</p>
          <p>System decision: <strong>{detail.systemDecision ?? 'pending'}</strong></p>
          <p>Effective decision: <strong>{detail.effectiveDecision ?? 'pending'}</strong></p>
          <p>Publication: <strong>{detail.publication}</strong></p>
          <p>
            Reviewed head: <code>{detail.headStatus?.reviewedHeadSha ?? detail.headSha ?? 'pending'}</code><br />
            Current head: <code>{detail.headStatus?.currentHeadSha ?? 'unavailable'}</code><br />
            Head status: <strong>{detail.headStatus?.stale === true ? 'STALE — override disabled' : 'CURRENT'}</strong>
          </p>
          <button type="button" disabled={!canCancel(detail.state)} onClick={() => void cancel()}>Cancel run</button>

          <h4>Deterministic failures</h4>
          {detail.deterministicReport === null ? <p>Pending</p> : failures.length === 0 ? <p>None</p> : (
            <ul>{failures.map((check) => <li key={check.id}><code>{check.id}</code>: {check.status} · <code>{check.evidenceRef}</code></li>)}</ul>
          )}

          <h4>AI findings</h4>
          {detail.judgedFindings.length === 0 ? <p>None or pending</p> : (
            <ul>{detail.judgedFindings.map((finding) => (
              <li key={finding.canonicalFindingKey}>
                <code>{finding.canonicalFindingKey}</code>: {finding.severity} · {finding.classification}
              </li>
            ))}</ul>
          )}

          <h4>Coverage and cost</h4>
          <p>
            Analysis: <strong>{detail.systemReport?.analysisCoverage ?? 'pending'}</strong> · Reviewer:{' '}
            <strong>{detail.systemReport?.reviewerCoverage ?? 'pending'}</strong> · Cost units:{' '}
            <strong>{detail.systemReport?.costUnits ?? 0}</strong>
          </p>
          <ul>{detail.reviewerStatuses.map((reviewer) => <li key={reviewer.adapterId}>{reviewer.adapterId}: {reviewer.status}</li>)}</ul>

          <h4>Human override</h4>
          <form onSubmit={(event) => { event.preventDefault(); void override(); }}>
            <label>
              Action{' '}
              <select value={action} onChange={(event) => setAction(event.target.value as 'APPROVE' | 'REJECT')} disabled={!canOverride(detail)}>
                <option value="APPROVE">Approve</option>
                <option value="REJECT">Reject</option>
              </select>
            </label>{' '}
            <label>
              Reason{' '}
              <input required value={reason} onChange={(event) => setReason(event.target.value)} disabled={!canOverride(detail)} />
            </label>{' '}
            <label>
              Finding IDs (comma separated){' '}
              <input value={findingIds} onChange={(event) => setFindingIds(event.target.value)} disabled={!canOverride(detail)} />
            </label>{' '}
            <button type="submit" disabled={!canOverride(detail) || reason.trim() === ''}>Record override</button>
          </form>

          <h4>Override history</h4>
          {detail.overrideHistory.length === 0 ? <p>None</p> : (
            <ul>{detail.overrideHistory.map((item) => (
              <li key={item.overrideId}>{item.createdAt} · {item.action} by {item.actor}: {item.reason}</li>
            ))}</ul>
          )}
        </div>
      )}
    </section>
  );
}
