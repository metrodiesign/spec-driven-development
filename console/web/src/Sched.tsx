// F-Sched (REQ-16): start/stop the platform loop process or an allowlisted
// script under the same quota guard `platform loop run --live` uses. Thin
// view — status/automation interpretation lives in logic/sched.ts.

import { useEffect, useRef, useState } from 'react';

import { automationHint, interpretStartResponse, schedStatusLabel, type SchedStatus } from './logic/sched.ts';
import { useI18n } from './I18nContext.tsx';
import { destructiveConfirmationText } from './logic/mutation.ts';
import { usePendingMutation } from './usePendingMutation.ts';
import { protectedFetch } from './useFetch.ts';

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};
const POLL_MS = 3000;

export function Sched(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<SchedStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [task, setTask] = useState('');
  const [live, setLive] = useState(false);
  const [scriptName, setScriptName] = useState('');
  const [confirm, setConfirm] = useState<{ hint: string; confirmToken: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mutations = usePendingMutation();

  const refreshStatus = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    controller.current = new AbortController();
    try {
      const response = await protectedFetch('/api/sched/status', { signal: controller.current.signal });
      if (!response.ok) throw new Error(String(response.status));
      setStatus(await response.json() as SchedStatus);
      setReadError(null);
      setLastReadAt(new Date().toISOString());
    } catch (error) {
      if (controller.current?.signal.aborted !== true) {
        setReadError(error instanceof Error ? error.message : t('fetchUnavailable'));
      }
    } finally {
      controller.current = null;
      inFlight.current = false;
    }
  };
  useEffect(() => {
    const poll = (): void => { if (document.visibilityState === 'visible') void refreshStatus(); };
    poll();
    const id = setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', poll);
      controller.current?.abort();
    };
  }, []);

  async function start(confirmToken?: string): Promise<void> {
    await mutations.run({ action: 'scheduler-start', target: goal, concurrencyKey: confirmToken ?? null }, async () => {
      try {
        const body: Record<string, unknown> = { goal, live };
        if (task.trim().length > 0) body['task'] = task.trim();
        if (confirmToken !== undefined) body['confirmToken'] = confirmToken;
        const res = await protectedFetch('/api/sched/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const outcome = interpretStartResponse(res.status, await res.json());
        if (outcome.kind === 'started') {
          setNote(t('schedStarted', { pid: outcome.pid }));
          setConfirm(null);
          void refreshStatus();
        } else if (outcome.kind === 'needs_confirmation') {
          setConfirm({ hint: automationHint(outcome.automation), confirmToken: outcome.confirmToken });
        } else {
          setNote(t('schedStartRefused', { reason: outcome.reason }));
          setConfirm(null);
        }
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  async function stop(): Promise<void> {
    await mutations.run({ action: 'scheduler-stop', target: status?.running === true ? String(status.pid) : 'child-process', concurrencyKey: null }, async () => {
      try {
        const res = await protectedFetch('/api/sched/stop', { method: 'POST' });
        const { stopped } = (await res.json()) as { stopped: boolean };
        setNote(stopped ? t('schedStopped') : t('schedNothingRunning'));
        void refreshStatus();
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  async function runScript(): Promise<void> {
    await mutations.run({ action: 'scheduler-script', target: scriptName, concurrencyKey: null }, async () => {
      try {
        const res = await protectedFetch('/api/sched/script', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: scriptName }),
        });
        const body = (await res.json()) as { error?: string; pid?: number };
        setNote(res.ok ? t('schedScriptStarted', { pid: body.pid ?? 0 }) : t('schedScriptRefused', { error: body.error ?? '' }));
        void refreshStatus();
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  const running = status?.running ?? false;

  return (
    <section aria-label="F-Sched">
      <h2>{t('schedHeading')}</h2>
      <p role="status">
        {status === null ? t('loading') : schedStatusLabel(status)}
      </p>
      {readError !== null && (
        <p role="alert">
          {status === null ? t('fetchUnavailable') : t('consoleStaleAt', { time: lastReadAt ?? 'unknown' })}{' '}
          <button type="button" onClick={() => void refreshStatus()}>{t('shellRetry')}</button>
        </p>
      )}
      {note !== null && <p role="status">{note}</p>}

      <div style={box} aria-label={t('schedLoopRunHeading')}>
        <h3>{t('schedLoopRunHeading')}</h3>
        <p>
          <label>
            {t('schedGoalPathLabel')}{' '}
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
            {t('schedTaskIdLabel')} <input value={task} onChange={(e) => setTask(e.target.value)} style={{ width: '10rem' }} />
          </label>{' '}
          <label>
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> {t('schedLiveLabel')}
          </label>
        </p>
        <p>
          <button
            type="button"
            disabled={running || goal.trim().length === 0 || mutations.isPending({ action: 'scheduler-start', target: goal, concurrencyKey: null })}
            onClick={() => void start()}
          >
            {t('schedStartButton')}
          </button>{' '}
          <button
            type="button"
            disabled={!running || mutations.isPending({ action: 'scheduler-stop', target: status?.running === true ? String(status.pid) : 'child-process', concurrencyKey: null })}
            onClick={() => {
              const target = status?.running === true ? `pid ${status.pid}` : 'child-process';
              if (window.confirm(destructiveConfirmationText(t('schedStopButton'), target))) void stop();
            }}
          >
            {t('schedStopButton')}
          </button>
        </p>
        {confirm !== null && (
          <div style={box} role="alert" aria-label={t('schedConfirmStartAriaLabel')}>
            <p>{confirm.hint}</p>
            <button
              type="button"
              disabled={mutations.isPending({ action: 'scheduler-start', target: goal, concurrencyKey: confirm.confirmToken })}
              onClick={() => void start(confirm.confirmToken)}
            >
              {t('schedConfirmAndStartButton')}
            </button>{' '}
            <button type="button" onClick={() => setConfirm(null)}>
              {t('schedCancelButton')}
            </button>
          </div>
        )}
      </div>

      <div style={box} aria-label={t('schedScriptSectionAriaLabel')}>
        <h3>{t('schedAllowlistedScriptHeading')}</h3>
        <p>
          <label>
            {t('schedScriptNameLabel')}{' '}
            <input
              value={scriptName}
              onChange={(e) => setScriptName(e.target.value)}
              placeholder="calibrate.sh"
              style={{ width: '14rem' }}
            />
          </label>{' '}
          <button
            type="button"
            disabled={running || scriptName.trim().length === 0 || mutations.isPending({ action: 'scheduler-script', target: scriptName, concurrencyKey: null })}
            onClick={() => void runScript()}
          >
            {t('schedRunButton')}
          </button>
        </p>
      </div>
    </section>
  );
}
