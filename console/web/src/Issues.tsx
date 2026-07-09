// F-Issue (REQ-8/9): file issues locally, convert to a draft goal.yaml, or
// reject — no webhook, no auto-run. Body text is UNTRUSTED DATA (INV-3):
// rendered as plain text only (a <pre>, never dangerouslySetInnerHTML), never
// parsed as HTML/markdown. Thin view — gating logic lives in logic/issues.ts.

import { useEffect, useState } from 'react';

import { canAct, overCap, TITLE_MAX, BODY_MAX, type IssueRecord } from './logic/issues.ts';

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};

export function Issues(): React.JSX.Element {
  const [issues, setIssues] = useState<IssueRecord[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const refresh = (): void => {
    fetch('/api/issues')
      .then((r) => r.json())
      .then((d: { issues: IssueRecord[] }) => setIssues(d.issues))
      .catch(() => setIssues([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  async function file(): Promise<void> {
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
      setNote(`filing failed: ${err.error ?? res.status}`);
    }
  }

  async function act(id: string, action: 'convert' | 'reject'): Promise<void> {
    const res = await fetch(`/api/issues/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    setNote(res.ok ? null : `${action} failed: ${res.status}`);
    refresh();
  }

  return (
    <section aria-label="F-Issue">
      <h2>Issues</h2>
      <p role="status">issue text is untrusted data — shown as plain text, never executed or run automatically</p>
      {note !== null && <p role="alert">{note}</p>}

      <div style={box} aria-label="File an issue">
        <h3>File an issue</h3>
        <p>
          <label>
            title{' '}
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
            body
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
          File
        </button>
      </div>

      {issues.length === 0 ? (
        <p>no issues yet</p>
      ) : (
        issues.map((issue) => (
          <div key={issue.id} style={box} aria-label={`Issue ${issue.id}`}>
            <p>
              <strong>{issue.title}</strong> · <code>{issue.status}</code>
            </p>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{issue.body}</pre>
            <button type="button" disabled={!canAct(issue)} onClick={() => void act(issue.id, 'convert')}>
              Convert to draft goal
            </button>{' '}
            <button type="button" disabled={!canAct(issue)} onClick={() => void act(issue.id, 'reject')}>
              Reject
            </button>
            {issue.goalDraftPath !== undefined && (
              <p>
                <small>
                  draft: <code>{issue.goalDraftPath}</code>
                </small>
              </p>
            )}
          </div>
        ))
      )}
    </section>
  );
}
