// F-Sched (REQ-16): start/stop the platform loop process or an allowlisted
// script under the same quota guard `platform loop run --live` uses. Thin
// view — status/automation interpretation lives in logic/sched.ts.

import { useEffect, useState } from 'react';

import { automationHint, interpretStartResponse, schedStatusLabel, type SchedStatus } from './logic/sched.ts';

const box: React.CSSProperties = {
  border: '1px solid #8884',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};
const POLL_MS = 3000;

export function Sched(): React.JSX.Element {
  const [status, setStatus] = useState<SchedStatus | null>(null);
  const [goal, setGoal] = useState('');
  const [task, setTask] = useState('');
  const [live, setLive] = useState(false);
  const [scriptName, setScriptName] = useState('');
  const [confirm, setConfirm] = useState<{ hint: string; confirmToken: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refreshStatus = (): void => {
    fetch('/api/sched/status')
      .then((r) => r.json())
      .then((s: SchedStatus) => setStatus(s))
      .catch(() => setStatus(null));
  };
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function start(confirmToken?: string): Promise<void> {
    const body: Record<string, unknown> = { goal, live };
    if (task.trim().length > 0) body['task'] = task.trim();
    if (confirmToken !== undefined) body['confirmToken'] = confirmToken;
    const res = await fetch('/api/sched/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const outcome = interpretStartResponse(res.status, await res.json());
    if (outcome.kind === 'started') {
      setNote(`started (pid ${outcome.pid})`);
      setConfirm(null);
      refreshStatus();
    } else if (outcome.kind === 'needs_confirmation') {
      setConfirm({ hint: automationHint(outcome.automation), confirmToken: outcome.confirmToken });
    } else {
      setNote(`start refused: ${outcome.reason}`);
      setConfirm(null);
    }
  }

  async function stop(): Promise<void> {
    const res = await fetch('/api/sched/stop', { method: 'POST' });
    const { stopped } = (await res.json()) as { stopped: boolean };
    setNote(stopped ? 'stopped' : 'nothing was running');
    refreshStatus();
  }

  async function runScript(): Promise<void> {
    const res = await fetch('/api/sched/script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: scriptName }),
    });
    const body = (await res.json()) as { error?: string; pid?: number };
    setNote(res.ok ? `script started (pid ${body.pid})` : `script refused: ${body.error}`);
    refreshStatus();
  }

  const running = status?.running ?? false;

  return (
    <section aria-label="F-Sched">
      <h2>Sched</h2>
      <p role="status">{status === null ? 'loading…' : schedStatusLabel(status)}</p>
      {note !== null && <p role="status">{note}</p>}

      <div style={box} aria-label="Loop run">
        <h3>Loop run</h3>
        <p>
          <label>
            goal.yaml path{' '}
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder=".ai/runs/goal.yaml"
              style={{ width: '20rem', maxWidth: '100%' }}
            />
          </label>
        </p>
        <p>
          <label>
            task id (optional) <input value={task} onChange={(e) => setTask(e.target.value)} style={{ width: '10rem' }} />
          </label>{' '}
          <label>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
          </label>
        </p>
        <p>
          <button type="button" disabled={running || goal.trim().length === 0} onClick={() => void start()}>
            Start
          </button>{' '}
          <button type="button" disabled={!running} onClick={() => void stop()}>
            Stop
          </button>
        </p>
        {confirm !== null && (
          <div style={box} role="alert" aria-label="Confirm start">
            <p>{confirm.hint}</p>
            <button type="button" onClick={() => void start(confirm.confirmToken)}>
              Confirm and start
            </button>{' '}
            <button type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div style={box} aria-label="Script">
        <h3>Allowlisted script</h3>
        <p>
          <label>
            script name{' '}
            <input
              value={scriptName}
              onChange={(e) => setScriptName(e.target.value)}
              placeholder="calibrate.sh"
              style={{ width: '14rem' }}
            />
          </label>{' '}
          <button type="button" disabled={running || scriptName.trim().length === 0} onClick={() => void runScript()}>
            Run
          </button>
        </p>
      </div>
    </section>
  );
}
