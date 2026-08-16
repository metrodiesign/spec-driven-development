// F-Issue (REQ-8/9): file issues locally, convert to a draft goal.yaml, or
// reject — no webhook, no auto-run. Body text is UNTRUSTED DATA (INV-3):
// rendered as plain text only (a <pre>, never dangerouslySetInnerHTML), never
// parsed as HTML/markdown. Thin view — gating logic lives in logic/issues.ts.

import { useEffect, useState } from 'react';

import { canAct, mergeIssues, overCap, TITLE_MAX, BODY_MAX, type IssueRecord } from './logic/issues.ts';
import { destructiveConfirmationText } from './logic/mutation.ts';
import { fetchStateFromResponse, FETCH_LOADING, FETCH_ERROR, type FetchState } from './logic/fetchState.ts';
import { useI18n } from './I18nContext.tsx';
import { usePendingMutation } from './usePendingMutation.ts';
import { protectedFetch } from './useFetch.ts';

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
  const [readError, setReadError] = useState(false);
  const [lastReadAt, setLastReadAt] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const mutations = usePendingMutation();

  const refresh = (cursor: string | null = null): void => {
    protectedFetch(`/api/issues?limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
      .then((r) => r.json().then((d: { issues: IssueRecord[]; nextCursor: string | null }) => {
        if (!r.ok) {
          setReadError(true);
          setIssuesState((current) => current.kind === 'data' ? current : FETCH_ERROR);
          return;
        }
        setReadError(false);
        setLastReadAt(new Date().toISOString());
        setIssuesState((current) => fetchStateFromResponse(true, cursor === null || current.kind !== 'data'
          ? d.issues
          : [...mergeIssues(current.value, d.issues)]));
        setNextCursor(d.nextCursor);
      }))
      .catch(() => {
        setReadError(true);
        setIssuesState((current) => current.kind === 'data' ? current : FETCH_ERROR);
      });
  };
  useEffect(() => {
    refresh();
  }, []);

  async function file(): Promise<void> {
    await mutations.run({ action: 'issue-create', target: title, concurrencyKey: null }, async () => {
      try {
        const res = await protectedFetch('/api/issues', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title, body }),
        });
        if (res.ok) {
          const created = await res.json() as IssueRecord;
          setTitle('');
          setBody('');
          setNote(`${t('issuesFileButton')}: ${created.status} (${created.id})`);
          refresh();
        } else {
          const err = (await res.json()) as { error?: string };
          setNote(t('issuesFilingFailed', { error: err.error ?? res.status }));
        }
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  async function act(id: string, action: 'convert' | 'reject'): Promise<void> {
    await mutations.run({ action: `issue-${action}`, target: id, concurrencyKey: null }, async () => {
      try {
        const res = await protectedFetch(`/api/issues/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
        const result = await res.json() as { issue?: IssueRecord; error?: string };
        const actionLabel = action === 'convert' ? t('issuesConvertButton') : t('reject');
        setNote(res.ok
          ? `${actionLabel}: ${result.issue?.status ?? 'confirmed'} (${id})`
          : t('issuesActionFailed', { action: actionLabel, status: result.error ?? res.status }));
        if (res.ok) refresh();
      } catch {
        setNote(t('fetchUnavailable'));
      }
    });
  }

  return (
    <section aria-label="F-Issue">
      <h2>{t('issuesHeading')}</h2>
      <p role="status">{t('issuesUntrustedNotice')}</p>
      {note !== null && <p role="alert">{note}</p>}
      {readError && (
        <p role="alert">{issuesState.kind === 'data' ? t('consoleStaleAt', { time: lastReadAt ?? 'unknown' }) : t('fetchUnavailable')}{' '}
          <button type="button" onClick={() => refresh()}>{t('shellRetry')}</button>
        </p>
      )}

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
        <button
          type="button"
          disabled={title.length === 0 || body.length === 0 || overCap(title, body) || mutations.isPending({ action: 'issue-create', target: title, concurrencyKey: null })}
          onClick={() => void file()}
        >
          {t('issuesFileButton')}
        </button>
      </div>

      {issuesState.kind === 'loading' ? (
        <p role="status">{t('loading')}</p>
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
            <button
              type="button"
              disabled={!canAct(issue) || mutations.isPending({ action: 'issue-convert', target: issue.id, concurrencyKey: null })}
              onClick={() => void act(issue.id, 'convert')}
            >
              {t('issuesConvertButton')}
            </button>{' '}
            <button
              type="button"
              disabled={!canAct(issue) || mutations.isPending({ action: 'issue-reject', target: issue.id, concurrencyKey: null })}
              onClick={() => {
                if (window.confirm(destructiveConfirmationText(t('reject'), issue.id))) void act(issue.id, 'reject');
              }}
            >
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
      {nextCursor !== null && (
        <button type="button" onClick={() => refresh(nextCursor)}>{t('consoleLoadMore')}</button>
      )}
    </section>
  );
}
