import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { useI18n } from './I18nContext.tsx';
import { SystemPanel } from './Surfaces.tsx';
import {
  GOVERNANCE_VIEWS,
  enabledPluginNames,
  governanceEditor,
  governanceScopes,
  governanceView,
  parsePermissionInput,
  provenanceRows,
  retentionPeriodDays,
  validateGovernanceDocument,
  type EffectiveEntry,
  type GovernanceDocumentKind,
  type GovernanceRead,
  type GovernanceScope,
  type GovernanceView,
} from './logic/govern.ts';
import { mergeNamedRecords } from './logic/console.ts';
import type { LocaleKey } from './logic/i18n.ts';
import { encodeRoute, type RouteState } from './logic/navigation.ts';
import { diffLines, mcpAuthenticateState } from './logic/surfaces.ts';
import { AUTH_INVALID_EVENT, protectedFetch, useRead, type ReadResult } from './useFetch.ts';
import { usePendingMutation } from './usePendingMutation.ts';

interface GovernanceProps {
  readonly route: RouteState;
  readonly navigate: (route: RouteState) => void;
  readonly remote: boolean;
}

interface ApiError {
  readonly error?: string;
  readonly currentHash?: string;
}

interface WriteResult extends ApiError {
  readonly saved?: boolean;
  readonly hash?: string;
  readonly applyTiming?: 'immediate' | 'next-session';
}

const VIEW_LABELS: Readonly<Record<GovernanceView, LocaleKey>> = {
  settings: 'governanceSettings',
  permissions: 'governancePermissions',
  memory: 'governanceMemory',
  mcp: 'governanceMcp',
  hooks: 'governanceHooks',
  subagents: 'governanceSubagents',
  skills: 'governanceSkills',
  plugins: 'governancePlugins',
  system: 'governanceSystem',
  retention: 'governanceRetention',
};

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

async function jsonBody<T>(response: Response): Promise<T & ApiError> {
  try {
    return await response.json() as T & ApiError;
  } catch {
    return { error: `http ${response.status}` } as T & ApiError;
  }
}

function projectQuery(scope: GovernanceScope, project: string | null): string {
  return scope === 'project' || scope === 'local'
    ? `?project=${encodeURIComponent(project ?? '')}`
    : '';
}

function projectBody(scope: GovernanceScope, project: string | null): { readonly project?: string } {
  return scope === 'project' || scope === 'local' ? { project: project ?? '' } : {};
}

function dataOf<T>(read: ReadResult<T>): T | null {
  return read.state.kind === 'data' ? read.state.value : read.state.kind === 'error' ? read.state.previous : read.state.previous;
}

function ReadFeedback<T>({ read }: { readonly read: ReadResult<T> }): React.JSX.Element | null {
  const { t } = useI18n();
  if (read.state.kind === 'loading' && read.state.previous === null) return <p role="status">{t('loading')}</p>;
  if (read.state.kind !== 'error') return null;
  return (
    <p role="alert">
      {read.state.stale ? t('shellStaleRead') : t('shellReadFailed', { reason: read.state.reason })}{' '}
      {read.state.stale && <code>{read.state.reason}</code>}{' '}
      <button type="button" onClick={read.retry}>{t('shellRetry')}</button>
    </p>
  );
}

function ScopeControl({
  view,
  scope,
  project,
  onChange,
}: {
  readonly view: GovernanceView;
  readonly scope: GovernanceScope;
  readonly project: string | null;
  readonly onChange: (scope: GovernanceScope) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const scopes = governanceScopes(view);
  return (
    <label className="governance-scope">
      {t('governanceScope')}{' '}
      <select value={scope} onChange={(event) => onChange(event.target.value as GovernanceScope)}>
        {scopes.map((candidate) => (
          <option
            key={candidate}
            value={candidate}
            disabled={(candidate === 'project' || candidate === 'local') && project === null}
          >
            {candidate}
          </option>
        ))}
      </select>
    </label>
  );
}

function useScope(view: GovernanceView, project: string | null): [GovernanceScope, (scope: GovernanceScope) => void] {
  const [scope, setScope] = useState<GovernanceScope>(() => governanceScopes(view)[0] ?? 'user');
  useEffect(() => {
    if ((scope === 'project' || scope === 'local') && project === null) setScope('user');
  }, [project, scope]);
  return [scope, setScope];
}

interface DocumentEditorProps {
  readonly title: string;
  readonly kind: GovernanceDocumentKind;
  readonly readUrl: string | null;
  readonly writeUrl: string | null;
  readonly scope: GovernanceScope;
  readonly project: string | null;
  readonly onSaved?: () => void;
  readonly onHash?: (hash: string | null) => void;
}

function DocumentEditor(props: DocumentEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const read = useRead<GovernanceRead>(props.readUrl);
  const mutations = usePendingMutation();
  const [source, setSource] = useState<GovernanceRead | null>(null);
  const [content, setContent] = useState('');
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<GovernanceRead | null>(null);
  const generation = useRef(0);
  const seen = useRef<GovernanceRead | null>(null);
  const current = dataOf(read);
  const model = source === null ? null : governanceEditor(source);

  useEffect(() => {
    if (current === null || current === seen.current) return;
    seen.current = current;
    if (dirty) return;
    const next = governanceEditor(current);
    setSource(current);
    setBaseHash(next.hash);
    setContent(next.editableContent ?? '');
    setReplaceOpen(next.editMode !== 'replace-entire');
    props.onHash?.(next.hash);
  }, [current, dirty, props.onHash]);

  useEffect(() => {
    const clear = (): void => {
      setContent('');
      setReplaceOpen(false);
      setDirty(false);
      setConflict(null);
    };
    window.addEventListener(AUTH_INVALID_EVENT, clear);
    return () => {
      generation.current += 1;
      window.removeEventListener(AUTH_INVALID_EVENT, clear);
    };
  }, []);

  const adopt = (value: GovernanceRead): void => {
    const next = governanceEditor(value);
    setSource(value);
    setBaseHash(next.hash);
    setContent(next.editableContent ?? '');
    setReplaceOpen(next.editMode !== 'replace-entire');
    setDirty(false);
    setConflict(null);
    setNote(t('governanceServerValueLoaded'));
    props.onHash?.(next.hash);
  };

  const loadConflict = async (): Promise<void> => {
    if (props.readUrl === null) return;
    const active = ++generation.current;
    const separator = props.readUrl.includes('?') ? '&' : '?';
    const response = await protectedFetch(`${props.readUrl}${separator}current=${active}`);
    if (!response.ok || active !== generation.current) return;
    const value = await jsonBody<GovernanceRead>(response);
    if (active === generation.current) setConflict(value);
  };

  const save = async (): Promise<void> => {
    if (props.writeUrl === null || model?.readOnly === true || (!replaceOpen && model?.editMode === 'replace-entire')) return;
    const writeUrl = props.writeUrl;
    const error = validateGovernanceDocument(props.kind, content);
    if (error !== null) {
      setNote(`${t('governanceValidationFailed')}: ${error}`);
      return;
    }
    const identity = { action: `save-${props.kind}`, target: writeUrl, concurrencyKey: baseHash };
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch(writeUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...projectBody(props.scope, props.project), scope: props.scope, content, baseHash }),
        });
        const result = await jsonBody<WriteResult>(response);
        if (response.status === 409) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? t('governanceStaleBase')}`);
          await loadConflict();
          return;
        }
        if (!response.ok || result.hash === undefined) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setBaseHash(result.hash);
        setContent('');
        setReplaceOpen(false);
        setDirty(false);
        setConflict(null);
        setNote(`${t('governanceSave')}: save-${props.kind}; apply ${result.applyTiming ?? 'next-session'}`);
        props.onHash?.(result.hash);
        props.onSaved?.();
        read.retry();
      } catch {
        setNote(t('governanceRequestUnavailableDraft'));
      }
    });
  };

  if (props.readUrl === null) return <p>{t('governanceSelectProjectScope')}</p>;
  const identity = { action: `save-${props.kind}`, target: props.writeUrl ?? props.readUrl, concurrencyKey: baseHash };
  return (
    <section className="governance-editor" aria-label={props.title}>
      <h3>{props.title}</h3>
      <ReadFeedback read={read} />
      {model !== null && (
        <>
          <p><small>{t('governanceProvenanceBase', { provenance: model.provenance })} <code>{model.hash ?? t('governanceNew')}</code></small></p>
          <pre className="technical-output governance-source">{model.displayContent === '' ? t('governanceNoContent') : model.displayContent}</pre>
          {model.readOnly ? (
            <p role="status">{t('governanceReadOnly')}</p>
          ) : model.editMode === 'replace-entire' && !replaceOpen ? (
            <p>
              {t('governanceRedacted')}{' '}
              <button type="button" onClick={() => { setContent(''); setReplaceOpen(true); setDirty(false); }}>
                {t('governanceReplaceEntire')}
              </button>
            </p>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <label>
                {t('governanceFullDocument')}
                <textarea
                  rows={14}
                  value={content}
                  onChange={(event) => { setContent(event.target.value); setDirty(true); setConflict(null); setNote(null); }}
                />
              </label>
              <p>
                <button type="submit" disabled={!dirty || mutations.isPending(identity)}>{t('governanceSave')}</button>{' '}
                {model.editMode === 'replace-entire' && (
                  <button type="button" onClick={() => { setContent(''); setReplaceOpen(false); setDirty(false); }}>{t('governanceCloseReplacement')}</button>
                )}
              </p>
            </form>
          )}
        </>
      )}
      {conflict !== null && (
        <div className="governance-conflict" role="alert">
          <h4>{t('governanceServerChangedEditor')}</h4>
          <pre className="technical-output">{conflict.content}</pre>
          <button type="button" onClick={() => adopt(conflict)}>{t('governanceReloadServer')}</button>{' '}
          <button type="button" onClick={() => { setConflict(null); setNote(t('governanceComparisonDraft')); }}>
            {t('governanceDiscardComparison')}
          </button>
        </div>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

function SettingsView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('settings', project);
  const query = projectQuery(scope, project);
  const readUrl = (scope === 'project' || scope === 'local') && project === null
    ? null
    : `/api/settings/${scope}${query}`;
  const writeUrl = scope === 'managed' ? null : `/api/settings/${scope}`;
  const effective = useRead<{
    readonly source: string;
    readonly effective: Record<string, EffectiveEntry>;
    readonly issues: readonly { readonly scope: string; readonly reason: string }[];
  }>(`/api/settings/effective${project === null ? '' : `?project=${encodeURIComponent(project)}`}`);
  const effectiveData = dataOf(effective);
  return (
    <section aria-labelledby="governance-settings-heading">
      <h2 id="governance-settings-heading">{t('governanceSettings')}</h2>
      <ScopeControl view="settings" scope={scope} project={project} onChange={setScope} />
      <DocumentEditor
        key={`${scope}:${project ?? ''}`}
        title={t('governanceScopedSettings', { scope })}
        kind="settings"
        readUrl={readUrl}
        writeUrl={writeUrl}
        scope={scope}
        project={project}
      />
      <section aria-labelledby="effective-settings-heading">
        <h3 id="effective-settings-heading">{t('governanceEffectiveSettings')}</h3>
        <ReadFeedback read={effective} />
        {effectiveData !== null && (
          <>
            <p><small>{effectiveData.source}</small></p>
            {provenanceRows(effectiveData.effective).length === 0 ? (
              <p>{t('governanceNoEffectiveSettings')}</p>
            ) : (
              <ul className="technical-list">
                {provenanceRows(effectiveData.effective).map((row) => <li key={row}><code>{row}</code></li>)}
              </ul>
            )}
            {effectiveData.issues.map((issue) => (
              <p key={`${issue.scope}:${issue.reason}`}><small>{issue.scope}: {issue.reason}</small></p>
            ))}
          </>
        )}
      </section>
    </section>
  );
}

function PermissionsView(): React.JSX.Element {
  const { t } = useI18n();
  const [rules, setRules] = useState('[\n  { "action": "ask", "pattern": "Bash", "scope": "user" }\n]');
  const [tool, setTool] = useState('Bash');
  const [path, setPath] = useState('');
  const [result, setResult] = useState<{
    readonly decision: string;
    readonly rule: { readonly action: string; readonly pattern: string; readonly scope?: string } | null;
    readonly provenance: { readonly scope: string; readonly source: string } | null;
  } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mutations = usePendingMutation();
  const identity = { action: 'permission-simulate', target: `${tool}:${path}`, concurrencyKey: null };

  const simulate = async (): Promise<void> => {
    const input = parsePermissionInput(rules, tool, path);
    if (typeof input === 'string') {
      setNote(`${t('governanceValidationFailed')}: ${input}`);
      return;
    }
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch('/api/permissions/simulate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        const body = await jsonBody<NonNullable<typeof result>>(response);
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${body.error ?? `http ${response.status}`}`);
          return;
        }
        setResult(body);
        setNote(t('governancePermissionSimulated'));
      } catch {
        setNote(t('governanceRequestUnavailableInput'));
      }
    });
  };

  return (
    <section aria-labelledby="governance-permissions-heading">
      <h2 id="governance-permissions-heading">{t('governancePermissions')}</h2>
      <p>{t('governanceSimulationOnly')}</p>
      <form onSubmit={(event) => { event.preventDefault(); void simulate(); }}>
        <label>{t('governanceRulesJson')}<textarea rows={10} value={rules} onChange={(event) => { setRules(event.target.value); setResult(null); }} /></label>
        <label>{t('governanceTool')} <input value={tool} onChange={(event) => setTool(event.target.value)} /></label>{' '}
        <label>{t('governancePath')} <input value={path} onChange={(event) => setPath(event.target.value)} /></label>{' '}
        <button type="submit" disabled={mutations.isPending(identity)}>{t('governanceSimulate')}</button>
      </form>
      {result !== null && (
        <dl className="governance-result">
          <dt>{t('governanceDecision')}</dt><dd><code>{result.decision}</code></dd>
          <dt>{t('governanceWinningRule')}</dt><dd><code>{result.rule === null ? 'default ask' : `${result.rule.action} ${result.rule.pattern}`}</code></dd>
          <dt>{t('governanceProvenance')}</dt><dd><code>{result.provenance?.source ?? 'default decision'}</code></dd>
        </dl>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

function MemoryView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('memory', project);
  const readUrl = scope === 'project' && project === null
    ? null
    : `/api/memory?scope=${scope}${scope === 'project' ? `&project=${encodeURIComponent(project ?? '')}` : ''}`;
  return (
    <section aria-labelledby="governance-memory-heading">
      <h2 id="governance-memory-heading">{t('governanceMemory')}</h2>
      <ScopeControl view="memory" scope={scope} project={project} onChange={setScope} />
      <DocumentEditor
        key={`${scope}:${project ?? ''}`}
        title={t('governanceScopedMemory', { scope })}
        kind="memory"
        readUrl={readUrl}
        writeUrl="/api/memory"
        scope={scope}
        project={project}
      />
    </section>
  );
}

function McpView({
  project,
  remote,
  onAuthenticate,
}: {
  readonly project: string | null;
  readonly remote: boolean;
  readonly onAuthenticate: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('mcp', project);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const mutations = usePendingMutation();
  const auth = mcpAuthenticateState(remote);
  const readUrl = scope === 'project' && project === null
    ? null
    : `/api/mcp/${scope}${scope === 'project' ? `?project=${encodeURIComponent(project ?? '')}` : ''}`;
  const identity = { action: 'mcp-test', target: transport, concurrencyKey: null };

  useEffect(() => {
    const clear = (): void => setTarget('');
    window.addEventListener(AUTH_INVALID_EVENT, clear);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, clear);
  }, []);
  useEffect(() => setTarget(''), [scope]);

  const testConnection = async (): Promise<void> => {
    const value = target.trim();
    if (value === '') {
      setNote(t('governanceRequired', { field: transport === 'stdio' ? t('governanceCommand') : t('governanceUrl') }));
      return;
    }
    if (transport === 'http') {
      try { new URL(value); } catch { setNote(t('governanceUrlValid')); return; }
    }
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch('/api/mcp/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(transport === 'stdio' ? { transport, command: value } : { transport, url: value }),
        });
        const body = await jsonBody<{ readonly advisory?: boolean; readonly reachable?: boolean; readonly detail?: string; readonly applyTiming?: string }>(response);
        setTarget('');
        setNote(response.ok
          ? `mcp-test: ${body.reachable ? t('governanceReachable') : `${t('governanceUnreachable')}: ${body.detail ?? 'unknown'}`}; apply ${body.applyTiming ?? 'immediate'}`
          : `${t('governanceRequestFailed')}: ${body.error ?? `http ${response.status}`}`);
      } catch {
        setNote(t('governanceRequestUnavailableSecret'));
        setTarget('');
      }
    });
  };

  return (
    <section aria-labelledby="governance-mcp-heading">
      <h2 id="governance-mcp-heading">{t('governanceMcp')}</h2>
      <ScopeControl view="mcp" scope={scope} project={project} onChange={setScope} />
      <DocumentEditor
        key={`${scope}:${project ?? ''}`}
        title={t('governanceScopedMcp', { scope })}
        kind="mcp"
        readUrl={readUrl}
        writeUrl={scope === 'project' ? '/api/mcp/project' : null}
        scope={scope}
        project={project}
      />
      {scope === 'user' && <p>{t('governanceMcpReadOnly')}</p>}
      {project !== null && (
        <p>
          <button type="button" disabled={!auth.enabled} onClick={onAuthenticate}>{t('governanceOpenMcpIntent')}</button>{' '}
          {auth.hint !== null && <small>{t('surfacesLocalTerminalHint')}</small>}
        </p>
      )}
      {scope === 'project' && project !== null && (
        <form onSubmit={(event) => { event.preventDefault(); void testConnection(); }}>
          <fieldset>
            <legend>{t('governanceExplicitTest')}</legend>
            <label>{t('governanceTransport')} <select value={transport} onChange={(event) => { setTransport(event.target.value as 'stdio' | 'http'); setTarget(''); }}>
              <option value="stdio">stdio</option><option value="http">http</option>
            </select></label>{' '}
            <label>{transport === 'stdio' ? t('governanceCommand') : t('governanceUrl')} <input value={target} onChange={(event) => setTarget(event.target.value)} /></label>{' '}
            <button type="submit" disabled={mutations.isPending(identity)}>{t('governanceTestConnection')}</button>
          </fieldset>
        </form>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

interface HookPreview {
  readonly valid: boolean;
  readonly error: string | null;
  readonly diff: { readonly removed: string[]; readonly added: string[] };
  readonly baseHash: string | null;
  readonly confirmToken: string;
  readonly content: string;
}

function HooksEditor({ scope, project }: { readonly scope: GovernanceScope; readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const readUrl = (scope === 'project' || scope === 'local') && project === null
    ? null
    : `/api/hooks/${scope}${projectQuery(scope, project)}`;
  const read = useRead<GovernanceRead>(readUrl);
  const mutations = usePendingMutation();
  const [source, setSource] = useState<GovernanceRead | null>(null);
  const [content, setContent] = useState('');
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<HookPreview | null>(null);
  const [conflict, setConflict] = useState<GovernanceRead | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const seen = useRef<GovernanceRead | null>(null);
  const generation = useRef(0);
  const current = dataOf(read);
  const model = source === null ? null : governanceEditor(source);

  useEffect(() => {
    if (current === null || current === seen.current) return;
    seen.current = current;
    if (dirty) return;
    const next = governanceEditor(current);
    setSource(current);
    setContent(next.editableContent ?? '');
    setBaseHash(next.hash);
    setReplaceOpen(next.editMode !== 'replace-entire');
  }, [current, dirty]);

  useEffect(() => {
    const clear = (): void => {
      setContent('');
      setPreview(null);
      setReplaceOpen(false);
      setDirty(false);
      setConflict(null);
    };
    window.addEventListener(AUTH_INVALID_EVENT, clear);
    return () => {
      generation.current += 1;
      window.removeEventListener(AUTH_INVALID_EVENT, clear);
    };
  }, []);

  const changed = (value: string): void => {
    setContent(value);
    setDirty(true);
    setPreview(null);
    setConflict(null);
    setNote(null);
  };

  const validate = async (): Promise<void> => {
    const error = validateGovernanceDocument('hooks', content);
    if (error !== null) {
      setNote(`${t('governanceValidationFailed')}: ${error}`);
      return;
    }
    const identity = { action: 'hooks-preview', target: `${scope}:${project ?? ''}`, concurrencyKey: baseHash };
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch('/api/hooks/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...projectBody(scope, project), scope, content }),
        });
        const result = await jsonBody<Omit<HookPreview, 'content'>>(response);
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        if (!result.valid) {
          setNote(`${t('governanceValidationFailed')}: ${result.error ?? 'server validation failed'}`);
          return;
        }
        setBaseHash(result.baseHash);
        setPreview({ ...result, content });
        setNote(t('governanceHooksPreviewReady'));
      } catch {
        setNote(t('governanceRequestUnavailableDraft'));
      }
    });
  };

  const loadConflict = async (): Promise<void> => {
    if (readUrl === null) return;
    const active = ++generation.current;
    const separator = readUrl.includes('?') ? '&' : '?';
    const response = await protectedFetch(`${readUrl}${separator}current=${active}`);
    if (!response.ok || active !== generation.current) return;
    const value = await jsonBody<GovernanceRead>(response);
    if (active === generation.current) setConflict(value);
  };

  const apply = async (action: 'install' | 'uninstall'): Promise<void> => {
    if (preview === null || preview.content !== content) {
      setNote(t('governancePreviewMissing'));
      return;
    }
    if (action === 'uninstall' && !window.confirm(t('governanceUninstallConfirm', { target: `${scope}:${project ?? 'user'}` }))) return;
    const identity = { action: `hooks-${action}`, target: `${scope}:${project ?? ''}`, concurrencyKey: preview.baseHash };
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch(`/api/hooks/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...projectBody(scope, project),
            scope,
            content: preview.content,
            baseHash: preview.baseHash,
            confirmToken: preview.confirmToken,
          }),
        });
        const result = await jsonBody<WriteResult>(response);
        if (response.status === 409) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? t('governanceStaleBase')}`);
          await loadConflict();
          return;
        }
        if (response.status === 428) {
          setPreview(null);
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? t('governanceTokenStale')}`);
          return;
        }
        if (!response.ok || result.hash === undefined) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setContent('');
        setPreview(null);
        setConflict(null);
        setReplaceOpen(false);
        setDirty(false);
        setBaseHash(result.hash);
        setNote(`${t('governanceSave')}: hooks-${action}; apply ${result.applyTiming ?? 'next-session'}`);
        read.retry();
      } catch {
        setNote(t('governanceRequestUnavailableDraft'));
      }
    });
  };

  const adoptConflict = (): void => {
    if (conflict === null) return;
    const next = governanceEditor(conflict);
    setSource(conflict);
    setContent(next.editableContent ?? '');
    setBaseHash(next.hash);
    setReplaceOpen(next.editMode !== 'replace-entire');
    setDirty(false);
    setPreview(null);
    setConflict(null);
    setNote(t('governanceServerValueLoaded'));
  };

  const previewIdentity = { action: 'hooks-preview', target: `${scope}:${project ?? ''}`, concurrencyKey: baseHash };
  const installIdentity = { action: 'hooks-install', target: `${scope}:${project ?? ''}`, concurrencyKey: preview?.baseHash ?? null };
  const uninstallIdentity = { action: 'hooks-uninstall', target: `${scope}:${project ?? ''}`, concurrencyKey: preview?.baseHash ?? null };
  const applying = mutations.isPending(installIdentity) || mutations.isPending(uninstallIdentity);
  if (readUrl === null) return <p>{t('governanceSelectProject')}</p>;
  return (
    <div>
      <ReadFeedback read={read} />
      {model !== null && (
        <>
          <p><small>{t('governanceProvenanceBase', { provenance: model.provenance })} <code>{model.hash ?? t('governanceNew')}</code></small></p>
          <pre className="technical-output governance-source">{model.displayContent === '' ? t('governanceNoHooks') : model.displayContent}</pre>
          {model.editMode === 'replace-entire' && !replaceOpen ? (
            <p>{t('governanceRedacted')}{' '}<button type="button" onClick={() => { setContent(''); setReplaceOpen(true); }}>{t('governanceReplaceEntire')}</button></p>
          ) : (
            <form onSubmit={(event) => { event.preventDefault(); void validate(); }}>
              <label>{t('governanceFullSettings')}<textarea rows={14} value={content} onChange={(event) => changed(event.target.value)} /></label>
              <p>
                <button type="submit" disabled={!dirty || mutations.isPending(previewIdentity)}>{t('governanceValidatePreview')}</button>{' '}
                {model.editMode === 'replace-entire' && <button type="button" onClick={() => { setContent(''); setReplaceOpen(false); setDirty(false); setPreview(null); }}>{t('governanceCloseReplacement')}</button>}
              </p>
            </form>
          )}
        </>
      )}
      {preview !== null && (
        <section className="governance-preview" aria-labelledby="hooks-preview-heading">
          <h3 id="hooks-preview-heading">{t('governanceDiffPreview')}</h3>
          <pre className="technical-output">{diffLines(preview.diff).join('\n') || t('governanceNoLineChanges')}</pre>
          <p><small>{t('governancePreviewBase')} <code>{preview.baseHash ?? t('governanceNew')}</code></small></p>
          <button type="button" disabled={applying} onClick={() => void apply('install')}>{t('governanceInstallPreview')}</button>{' '}
          <button type="button" disabled={applying} onClick={() => void apply('uninstall')}>{t('governanceUninstallPreview')}</button>
        </section>
      )}
      {conflict !== null && (
        <div className="governance-conflict" role="alert">
          <h3>{t('governanceServerChangedPreview')}</h3>
          <pre className="technical-output">{conflict.content}</pre>
          <button type="button" onClick={adoptConflict}>{t('governanceReloadServer')}</button>{' '}
          <button type="button" onClick={() => { setConflict(null); setNote(t('governanceComparisonDraft')); }}>{t('governanceDiscardComparison')}</button>
        </div>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </div>
  );
}

function HooksView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('hooks', project);
  return (
    <section aria-labelledby="governance-hooks-heading">
      <h2 id="governance-hooks-heading">{t('governanceHooks')}</h2>
      <ScopeControl view="hooks" scope={scope} project={project} onChange={setScope} />
      <HooksEditor key={`${scope}:${project ?? ''}`} scope={scope} project={project} />
    </section>
  );
}

function CatalogView({
  resource,
  project,
}: {
  readonly resource: 'subagents' | 'skills';
  readonly project: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const view: GovernanceView = resource;
  const [scope, setScope] = useScope(view, project);
  const [cursor, setCursor] = useState<string | null>(null);
  const [names, setNames] = useState<readonly string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const mutations = usePendingMutation();
  const projectPart = scope === 'project' ? `&project=${encodeURIComponent(project ?? '')}` : '';
  const list = useRead<{ readonly subagents?: string[]; readonly skills?: string[]; readonly nextCursor: string | null }>(
    scope === 'project' && project === null
      ? null
      : `/api/${resource}?scope=${scope}${projectPart}&limit=50${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
  );

  useEffect(() => {
    setCursor(null);
    setNames([]);
    setNextCursor(null);
    setName('');
    setHash(null);
    setNote(null);
  }, [project, scope]);

  useEffect(() => {
    if (list.state.kind !== 'data') return;
    const page = list.state.value;
    const incoming = resource === 'subagents' ? page.subagents ?? [] : page.skills ?? [];
    setNames((current) => cursor === null ? incoming : mergeNamedRecords(current, incoming, (entry) => entry));
    setNextCursor(page.nextCursor);
  }, [cursor, list.state, resource]);

  const basePath = `/api/${resource}/${encodeURIComponent(name)}`;
  const detailQuery = `?scope=${scope}${scope === 'project' ? `&project=${encodeURIComponent(project ?? '')}` : ''}`;
  const readUrl = name.trim() === '' ? null : `${basePath}${detailQuery}`;
  const deleteIdentity = { action: 'delete-subagent', target: `${scope}:${name}`, concurrencyKey: hash };

  const remove = async (): Promise<void> => {
    if (resource !== 'subagents' || name === '' || !window.confirm(t('governanceDeleteConfirm', { target: `${scope}:${name}` }))) return;
    await mutations.run(deleteIdentity, async () => {
      try {
        const response = await protectedFetch(
          `${basePath}${detailQuery}${hash === null ? '' : `&baseHash=${encodeURIComponent(hash)}`}`,
          { method: 'DELETE' },
        );
        const body = await jsonBody<{ readonly deleted?: boolean; readonly applyTiming?: string }>(response);
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${body.error ?? `http ${response.status}`}`);
          return;
        }
        setNote(`${t('governanceDeleteSubagent')}: delete-subagent ${body.deleted ? 'deleted' : 'already absent'}; apply ${body.applyTiming ?? 'next-session'}`);
        setName('');
        setHash(null);
        setCursor(null);
        list.retry();
      } catch {
        setNote(t('governanceRequestUnavailableSelection'));
      }
    });
  };

  return (
    <section aria-labelledby={`governance-${resource}-heading`}>
      <h2 id={`governance-${resource}-heading`}>{t(VIEW_LABELS[view])}</h2>
      <ScopeControl view={view} scope={scope} project={project} onChange={setScope} />
      <ReadFeedback read={list} />
      <label>
        {resource === 'subagents' ? t('governanceExistingSubagents') : t('governanceExistingSkills')}{' '}
        <select value={names.includes(name) ? name : ''} onChange={(event) => setName(event.target.value)}>
          <option value="">{t('governanceSelectOrNew')}</option>
          {names.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
      </label>{' '}
      <label>{t('governanceName')} <input value={name} onChange={(event) => setName(event.target.value)} /></label>{' '}
      {nextCursor !== null && <button type="button" disabled={list.inFlight} onClick={() => setCursor(nextCursor)}>{t('governanceLoadMore')}</button>}
      {name.trim() !== '' && (
        <>
          <DocumentEditor
            key={`${resource}:${scope}:${project ?? ''}:${name}`}
            title={`${scope} ${resource === 'subagents' ? 'subagent' : 'skill'} ${name}`}
            kind={resource === 'subagents' ? 'subagent' : 'skill'}
            readUrl={readUrl}
            writeUrl={basePath}
            scope={scope}
            project={project}
            onSaved={() => { setCursor(null); list.retry(); }}
            onHash={setHash}
          />
          {resource === 'subagents' && names.includes(name) && (
            <button type="button" disabled={mutations.isPending(deleteIdentity)} onClick={() => void remove()}>
              {t('governanceDeleteSubagent')}
            </button>
          )}
        </>
      )}
      {names.length === 0 && list.state.kind === 'data' && <p>{t(resource === 'subagents' ? 'governanceNoSubagents' : 'governanceNoSkills')}</p>}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

function PluginsView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('plugins', project);
  const [plugin, setPlugin] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [conflict, setConflict] = useState<GovernanceRead | null>(null);
  const generation = useRef(0);
  const mutations = usePendingMutation();
  const readUrl = (scope === 'project' || scope === 'local') && project === null
    ? null
    : `/api/settings/${scope}${projectQuery(scope, project)}`;
  const settings = useRead<GovernanceRead>(readUrl);
  const data = dataOf(settings);
  const baseHash = data?.hash ?? null;
  const identity = { action: 'plugin-toggle', target: `${scope}:${plugin}`, concurrencyKey: baseHash };

  useEffect(() => {
    generation.current += 1;
    setPlugin('');
    setConflict(null);
    setNote(null);
  }, [project, scope]);

  const loadConflict = async (): Promise<void> => {
    if (readUrl === null) return;
    const active = ++generation.current;
    const separator = readUrl.includes('?') ? '&' : '?';
    const response = await protectedFetch(`${readUrl}${separator}current=${active}`);
    if (!response.ok || active !== generation.current) return;
    const value = await jsonBody<GovernanceRead>(response);
    if (active === generation.current) setConflict(value);
  };

  const save = async (): Promise<void> => {
    if (plugin.trim() === '') {
      setNote(t('governancePluginRequired'));
      return;
    }
    await mutations.run(identity, async () => {
      try {
        const response = await protectedFetch('/api/settings/enabled-plugins', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...projectBody(scope, project), scope, plugin: plugin.trim(), enabled, baseHash }),
        });
        const result = await jsonBody<WriteResult>(response);
        if (response.status === 409) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? t('governanceStaleBase')}`);
          await loadConflict();
          return;
        }
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setNote(`${t('governanceApplyState')}: plugin-toggle ${enabled ? 'enabled' : 'disabled'} ${plugin.trim()}; apply ${result.applyTiming ?? 'next-session'}`);
        setConflict(null);
        settings.retry();
      } catch {
        setNote(t('governanceRequestUnavailableInput'));
      }
    });
  };

  return (
    <section aria-labelledby="governance-plugins-heading">
      <h2 id="governance-plugins-heading">{t('governancePlugins')}</h2>
      <p>{t('governancePluginsIntro')}</p>
      <ScopeControl view="plugins" scope={scope} project={project} onChange={setScope} />
      <ReadFeedback read={settings} />
      {data !== null && (
        <p>{t('governanceEnabled')} <code>{enabledPluginNames(data.content).join(', ') || 'none'}</code> · {t('governanceSettingsBase')} <code>{baseHash ?? t('governanceNew')}</code></p>
      )}
      {readUrl !== null && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>{t('governancePluginId')} <input value={plugin} onChange={(event) => { setPlugin(event.target.value); setConflict(null); }} /></label>{' '}
          <label><input type="checkbox" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); setConflict(null); }} /> {t('governanceEnabledCheckbox')}</label>{' '}
          <button type="submit" disabled={mutations.isPending(identity)}>{t('governanceApplyState')}</button>
        </form>
      )}
      {conflict !== null && (
        <div className="governance-conflict" role="alert">
          <h3>{t('governanceServerSettingsChanged')}</h3>
          <pre className="technical-output">{conflict.content}</pre>
          <button type="button" onClick={() => { setConflict(null); settings.retry(); }}>{t('governanceReloadServer')}</button>{' '}
          <button type="button" onClick={() => { setConflict(null); setNote(t('governanceComparisonPlugin')); }}>{t('governanceDiscardComparison')}</button>
        </div>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

interface RetentionPreview {
  readonly candidates: readonly string[];
  readonly confirmToken: string;
  readonly cleanupPeriodDays: number;
}

function RetentionView({ project }: { readonly project: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const [scope, setScope] = useScope('retention', project);
  const [days, setDays] = useState('30');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [conflict, setConflict] = useState<GovernanceRead | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const generation = useRef(0);
  const mutations = usePendingMutation();
  const readUrl = (scope === 'project' || scope === 'local') && project === null
    ? null
    : `/api/settings/${scope}${projectQuery(scope, project)}`;
  const settings = useRead<GovernanceRead>(readUrl);
  const data = dataOf(settings);
  const baseHash = data?.hash ?? null;
  const value = Number(days);
  const validDays = Number.isFinite(value) && value >= 0;
  const saveIdentity = { action: 'retention-save', target: `${scope}:${project ?? ''}`, concurrencyKey: baseHash };
  const previewIdentity = { action: 'retention-preview', target: String(days), concurrencyKey: null };
  const pruneIdentity = { action: 'retention-prune', target: String(preview?.cleanupPeriodDays ?? days), concurrencyKey: preview?.confirmToken ?? null };

  useEffect(() => {
    generation.current += 1;
    setPreview(null);
    setConflict(null);
    setDirty(false);
    setNote(null);
  }, [project, scope]);

  useEffect(() => {
    if (data === null || dirty) return;
    const currentDays = retentionPeriodDays(data.content);
    if (currentDays !== null) setDays(String(currentDays));
  }, [data, dirty]);

  useEffect(() => {
    const clear = (): void => setPreview(null);
    window.addEventListener(AUTH_INVALID_EVENT, clear);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, clear);
  }, []);

  const loadConflict = async (): Promise<void> => {
    if (readUrl === null) return;
    const active = ++generation.current;
    const separator = readUrl.includes('?') ? '&' : '?';
    const response = await protectedFetch(`${readUrl}${separator}current=${active}`);
    if (!response.ok || active !== generation.current) return;
    const current = await jsonBody<GovernanceRead>(response);
    if (active === generation.current) setConflict(current);
  };

  const save = async (): Promise<void> => {
    if (!validDays) {
      setNote(t('governanceRetentionInvalid'));
      return;
    }
    await mutations.run(saveIdentity, async () => {
      try {
        const response = await protectedFetch('/api/system/retention', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...projectBody(scope, project), scope, cleanupPeriodDays: Math.floor(value), baseHash }),
        });
        const result = await jsonBody<WriteResult>(response);
        if (response.status === 409) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? t('governanceStaleBase')}`);
          await loadConflict();
          return;
        }
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setDirty(false);
        setConflict(null);
        setNote(`${t('governanceSaveRetention')}: retention-save ${Math.floor(value)} days; apply ${result.applyTiming ?? 'next-session'}`);
        settings.retry();
      } catch {
        setNote(t('governanceRequestUnavailableInput'));
      }
    });
  };

  const loadPreview = async (): Promise<void> => {
    if (!validDays) {
      setNote(t('governanceRetentionInvalid'));
      return;
    }
    await mutations.run(previewIdentity, async () => {
      try {
        const normalized = Math.floor(value);
        const response = await protectedFetch(`/api/system/retention/preview?cleanupPeriodDays=${normalized}`);
        const result = await jsonBody<Omit<RetentionPreview, 'cleanupPeriodDays'>>(response);
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setPreview({ ...result, cleanupPeriodDays: normalized });
        setNote(`${t('governancePreviewPrune')}: retention-preview ${result.candidates.length}`);
      } catch {
        setNote(t('governanceRequestUnavailable'));
      }
    });
  };

  const prune = async (): Promise<void> => {
    if (preview === null) {
      setNote(t('governancePreviewRequired'));
      return;
    }
    const target = `${preview.candidates.length} file(s) older than ${preview.cleanupPeriodDays} days`;
    if (!window.confirm(t('governancePruneConfirm', { target }))) return;
    await mutations.run(pruneIdentity, async () => {
      try {
        const response = await protectedFetch('/api/system/retention/prune', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cleanupPeriodDays: preview.cleanupPeriodDays, confirmToken: preview.confirmToken }),
        });
        const result = await jsonBody<{ readonly pruned?: number; readonly files?: readonly string[]; readonly applyTiming?: string }>(response);
        if (response.status === 428) setPreview(null);
        if (!response.ok) {
          setNote(`${t('governanceRequestFailed')}: ${result.error ?? `http ${response.status}`}`);
          return;
        }
        setPreview(null);
        setNote(`${t('governanceConfirmPrune', { count: result.pruned ?? 0 })}: retention-prune; apply ${result.applyTiming ?? 'immediate'}`);
      } catch {
        setNote(t('governanceRequestUnavailablePreview'));
      }
    });
  };

  return (
    <section aria-labelledby="governance-retention-heading">
      <h2 id="governance-retention-heading">{t('governanceRetentionHeading')}</h2>
      <ScopeControl view="retention" scope={scope} project={project} onChange={setScope} />
      <ReadFeedback read={settings} />
      {data !== null && <p><small>{t('governanceSettingsBase')} <code>{baseHash ?? t('governanceNew')}</code></small></p>}
      {readUrl !== null && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label>cleanupPeriodDays <input type="number" min="0" step="1" value={days} onChange={(event) => { setDays(event.target.value); setDirty(true); setPreview(null); setConflict(null); }} /></label>{' '}
          <button type="submit" disabled={!dirty || mutations.isPending(saveIdentity)}>{t('governanceSaveRetention')}</button>{' '}
          <button type="button" disabled={!validDays || mutations.isPending(previewIdentity)} onClick={() => void loadPreview()}>{t('governancePreviewPrune')}</button>
        </form>
      )}
      {preview !== null && (
        <section className="governance-preview" aria-labelledby="retention-preview-heading">
          <h3 id="retention-preview-heading">{t('governancePruneCandidates')}</h3>
          <pre className="technical-output">{preview.candidates.join('\n') || t('governanceNoCandidates')}</pre>
          <button type="button" disabled={mutations.isPending(pruneIdentity)} onClick={() => void prune()}>
            {t('governanceConfirmPrune', { count: preview.candidates.length })}
          </button>
        </section>
      )}
      {conflict !== null && (
        <div className="governance-conflict" role="alert">
          <h3>{t('governanceServerSettingsChanged')}</h3>
          <pre className="technical-output">{conflict.content}</pre>
          <button type="button" onClick={() => { setConflict(null); setDirty(false); settings.retry(); }}>{t('governanceReloadServer')}</button>{' '}
          <button type="button" onClick={() => { setConflict(null); setNote(t('governanceComparisonRetention')); }}>{t('governanceDiscardComparison')}</button>
        </div>
      )}
      {note !== null && <p role="status"><code>{note}</code></p>}
    </section>
  );
}

function GovernanceContent({ view, route, navigate, remote }: GovernanceProps & { readonly view: GovernanceView }): React.JSX.Element {
  const { t } = useI18n();
  if (view === 'settings') return <SettingsView project={route.project} />;
  if (view === 'permissions') return <PermissionsView />;
  if (view === 'memory') return <MemoryView project={route.project} />;
  if (view === 'mcp') {
    return (
      <McpView
        project={route.project}
        remote={remote}
        onAuthenticate={() => navigate({ ...route, view: 'terminal', item: 'mcp-authenticate' })}
      />
    );
  }
  if (view === 'hooks') return <HooksView project={route.project} />;
  if (view === 'subagents') return <CatalogView resource="subagents" project={route.project} />;
  if (view === 'skills') return <CatalogView resource="skills" project={route.project} />;
  if (view === 'plugins') return <PluginsView project={route.project} />;
  if (view === 'system') return <section aria-labelledby="governance-system-heading"><h2 id="governance-system-heading">{t('governanceSystem')}</h2><SystemPanel /></section>;
  return <RetentionView project={route.project} />;
}

export function Governance(props: GovernanceProps): React.JSX.Element {
  const { t } = useI18n();
  const view = governanceView(props.route.item);
  return (
    <section className="governance-control-center" aria-labelledby="governance-heading">
      <h1 id="governance-heading">{t('governanceHeading')}</h1>
      <nav className="governance-nav" aria-label={t('governanceViewsAria')}>
        <ul>{GOVERNANCE_VIEWS.map((candidate) => {
          const next = { ...props.route, item: candidate };
          return (
            <li key={candidate}>
              <a
                href={encodeRoute(next)}
                aria-current={candidate === view ? 'page' : undefined}
                onClick={(event) => {
                  if (!plainClick(event)) return;
                  event.preventDefault();
                  props.navigate(next);
                }}
              >
                {t(VIEW_LABELS[candidate])}
              </a>
            </li>
          );
        })}</ul>
      </nav>
      <div className="governance-view" key={`${view}:${props.route.project ?? ''}`}>
        <GovernanceContent {...props} view={view} />
      </div>
    </section>
  );
}
