// F-Issue (REQ-8/9): file issues locally, convert to a draft goal.yaml, or
// reject — no webhook, no auto-run. Body text is UNTRUSTED DATA (INV-3):
// rendered as plain text only (a <pre>, never dangerouslySetInnerHTML), never
// parsed as HTML/markdown. Thin view — gating logic lives in logic/issues.ts.

import { useEffect, useState } from 'react';

import { canAct, overCap, TITLE_MAX, BODY_MAX, type IssueRecord } from './logic/issues.ts';
import { fetchStateFromResponse, FETCH_LOADING, FETCH_ERROR, type FetchState } from './logic/fetchState.ts';
import { useI18n } from './I18nContext.tsx';

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};

export function Issues(): React.JSX.Element {
  const { t } = useI18n();
  const [issuesState, setIssuesState] = useState<FetchState<IssueRecord[]>>(FETCH_LOADING);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = (): void => {
    fetch('/api/issues')
      .then((r) => r.json().then((d: { issues: IssueRecord[] }) => setIssuesState(fetchStateFromResponse(r.ok, d.issues))))
      .catch(() => setIssuesState(FETCH_ERROR));
  };
  useEffect(() => {
    refresh();
  }, []);

  async function file(): Promise<void> {
    try {
      const res = await fetch('/api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      if (res.ok) {
        setTitle('');
        setBody('');
        setNote(null);
        refresh();
      } else {
        const err = (await res.json()) as { error?: string };
        setNote(t('issuesFilingFailed', { error: err.error ?? res.status }));
      }
    } catch {
      setNote(t('fetchUnavailable'));
    }
  }

  async function act(id: string, action: 'convert' | 'reject'): Promise<void> {
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      const actionLabel = action === 'convert' ? t('issuesConvertButton') : t('reject');
      setNote(res.ok ? null : t('issuesActionFailed', { action: actionLabel, status: res.status }));
      refresh();
    } catch {
      setNote(t('fetchUnavailable'));
    }
  }

  return (
    <section aria-label="F-Issue">
      <h2>{t('issuesHeading')}</h2>
      <p role="status">{t('issuesUntrustedNotice')}</p>
      {note !== null && <p role="alert">{note}</p>}

      <div style={box} aria-label={t('issuesFileHeading')}>
        <h3>{t('issuesFileHeading')}</h3>
        <p>
          <label>
            {t('issuesTitleLabel')}{' '}
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={TITLE_MAX}
              style={{ width: '20rem', maxWidth: '100%' }}
            />
          </label>
        </p>
        <p>
          <label>
            {t('issuesBodyLabel')}
            <br />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={BODY_MAX}
              rows={4}
              style={{ width: '100%' }}
            />
          </label>
        </p>
        <button type="button" disabled={title.length === 0 || body.length === 0 || overCap(title, body)} onClick={() => void file()}>
          {t('issuesFileButton')}
        </button>
      </div>

      {issuesState.kind === 'loading' ? (
        <p>{t('loading')}</p>
      ) : issuesState.kind === 'error' ? (
        <p role="status">{t('fetchUnavailable')}</p>
      ) : issuesState.value.length === 0 ? (
        <p>{t('issuesNoIssuesYet')}</p>
      ) : (
        issuesState.value.map((issue) => (
          <div key={issue.id} style={box} aria-label={t('issuesIssueAriaLabel', { id: issue.id })}>
            <p>
              <strong>{issue.title}</strong> · <code>{issue.status}</code>
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{issue.body}</pre>
            <button type="button" disabled={!canAct(issue)} onClick={() => void act(issue.id, 'convert')}>
              {t('issuesConvertButton')}
            </button>{' '}
            <button type="button" disabled={!canAct(issue)} onClick={() => void act(issue.id, 'reject')}>
              {t('reject')}
            </button>
            {issue.goalDraftPath !== undefined && (
              <p>
                <small>
                  {t('issuesDraftLabel')} <code>{issue.goalDraftPath}</code>
                </small>
              </p>
            )}
          </div>
        ))
      )}
    </section>
  );
}
