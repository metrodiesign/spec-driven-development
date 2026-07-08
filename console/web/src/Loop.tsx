// F-Loop (REQ-15): read the loop and approve/steer/kill from the web, so
// autonomous supervision does not require a terminal on the host. Thin view —
// display shaping + control gating live in logic/loop.ts.

import { useEffect, useState } from 'react';

import {
  attestationChecklist,
  canApprove,
  latestTaskState,
  nextSince,
  stateBadge,
  steeringControls,
  taskApprovalPackages,
  type LoopApprovalPackage,
  type LoopEvent,
} from './logic/loop.ts';

interface RunSummary {
  runId: string;
  ended: boolean;
}

function useFetch<T>(url: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (url === null) return;
    let alive = true;
    fetch(url)
      .then((r) => r.json())
      .then((d: T) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [url]);
  return data;
}

const box: React.CSSProperties = {
  border: '1px solid #8884',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};
const POLL_MS = 3000;

export function Loop(): React.JSX.Element {
  const runsRes = useFetch<{ runs: RunSummary[] }>('/api/loop/runs');
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<LoopEvent[]>([]);
  const [approvals, setApprovals] = useState<object[]>([]);
  const [checked, setChecked] = useState<Record<string, string[]>>({});
  const [guidance, setGuidance] = useState('');
  const [pollError, setPollError] = useState<string | null>(null);

  // Poll approvals + events since= the last seen seq (REQ-15.8) while a run is selected.
  useEffect(() => {
    setEvents([]);
    setApprovals([]);
    setPollError(null);
    if (selected === null) return;
    let alive = true;
    let since = 0;
    const run = encodeURIComponent(selected);
    const poll = async (): Promise<void> => {
      try {
        const [evRes, apRes] = await Promise.all([
          fetch(`/api/loop/${run}/events?since=${since}`),
          fetch(`/api/loop/${run}/approvals`),
        ]);
        if (!alive) return;
        if (evRes.ok) {
          const fresh = (await evRes.json()) as LoopEvent[];
          since = nextSince(since, fresh);
          if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh]);
        }
        if (apRes.ok) setApprovals((await apRes.json()) as object[]);
        setPollError(evRes.ok && apRes.ok ? null : `poll failed (events ${evRes.status}, approvals ${apRes.status})`);
      } catch {
        if (alive) setPollError('poll failed: network error');
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [selected]);

  const run = selected === null ? null : runsRes?.runs.find((r) => r.runId === selected) ?? null;
  const ended = run?.ended ?? false;
  const state = latestTaskState(events);
  const controls = steeringControls(ended, state);
  const packages = taskApprovalPackages(approvals);

  const mutate = async (path: string, body?: unknown): Promise<void> => {
    if (selected === null) return;
    const res = await fetch(`/api/loop/${encodeURIComponent(selected)}${path}`, {
      method: 'POST',
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    setPollError(res.ok ? null : `${path} failed: ${res.status}`);
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
      <h2>Loop</h2>

      <div style={box} aria-label="Runs">
        <h3>Runs</h3>
        {runsRes === null ? (
          <p>loading…</p>
        ) : runsRes.runs.length === 0 ? (
          <p>no discovered runs — start one with `platform loop run --live`</p>
        ) : (
          <ul>
            {runsRes.runs.map((r) => (
              <li key={r.runId}>
                <button type="button" onClick={() => setSelected(r.runId)} aria-current={selected === r.runId}>
                  {r.runId}
                </button>{' '}
                <small>({r.ended ? 'ended' : 'live'})</small>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null && (
        <div style={box} aria-label="Selected run">
          <h3>
            <code>{selected}</code> — <span role="status">{stateBadge(ended, state)}</span>
          </h3>
          {pollError !== null && <p role="alert">{pollError}</p>}

          <div>
            <button type="button" disabled={!controls.canPause} onClick={() => void mutate('/steering/pause')}>
              Pause
            </button>{' '}
            <button type="button" disabled={!controls.canResume} onClick={() => void mutate('/steering/resume')}>
              Resume
            </button>{' '}
            {/* Kill has no state gate server-side (unlike pause/resume/inject) — only "is this run live" applies. */}
            <button type="button" disabled={ended} onClick={() => void mutate('/kill')}>
              Kill
            </button>
          </div>

          <div>
            <label>
              Steering guidance{' '}
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
              {controls.injectAtNextBoundary ? 'Queue at next boundary' : 'Inject now'}
            </button>
          </div>

          <h4>Approval packages</h4>
          {packages.length === 0 ? (
            <p>none pending</p>
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
  const rows = attestationChecklist(pkg, checkedIds);
  return (
    <div style={box} aria-label={`Approval ${pkg.id}`}>
      <p>
        task <code>{pkg.taskId}</code> · risk <strong>{pkg.riskClass}</strong> · ACs {pkg.acIds.join(', ')}
      </p>
      <p>{pkg.goalExcerpt}</p>
      {pkg.unresolvedRisks.length > 0 && <p role="status">unresolved: {pkg.unresolvedRisks.join('; ')}</p>}
      <fieldset>
        <legend>Attestations</legend>
        {rows.map((row) => (
          <label key={row.text} style={{ display: 'block' }}>
            <input type="checkbox" checked={row.checked} onChange={() => onToggle(row.text)} />
            {row.text}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={!canApprove(pkg, checkedIds)} onClick={() => onDecide('approve')}>
        Approve
      </button>{' '}
      <button type="button" onClick={() => onDecide('reject')}>
        Reject
      </button>
    </div>
  );
}
