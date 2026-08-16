// Phase-2 governance surfaces — minimal read views (F-MCP/F-Hook/F-Sub/F-Skill/
// F-Sys). Thin by design: display shaping lives in logic/surfaces.ts. Writes are
// governed by the backend (consent gate + writeSafe) and covered by API tests;
// these pages surface the current state and the operator's entry points.

import { useState } from 'react';

import { statsRows, mcpAuthenticateState, type SysStats } from './logic/surfaces.ts';
import { useI18n } from './I18nContext.tsx';
import { useFetch, useRead } from './useFetch.ts';

const box: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.75rem',
  marginBottom: '0.75rem',
  overflowWrap: 'anywhere',
};
const pre: React.CSSProperties = {
  overflowX: 'auto',
  maxWidth: '100%',
  background: 'var(--color-bg-subtle)',
  padding: '0.5rem',
  borderRadius: 4,
};

export function SystemPanel(): React.JSX.Element {
  const { t, locale } = useI18n();
  const stats = useRead<SysStats>('/api/system/stats');
  const [doctorRequest, setDoctorRequest] = useState(0);
  const [statusRequest, setStatusRequest] = useState(0);
  const doctor = useRead<{ available: boolean; degraded?: boolean; output?: string; hint?: string }>(
    doctorRequest > 0 ? `/api/system/doctor?request=${doctorRequest}` : null,
  );
  const cli = useRead<{ cli: { available: boolean; version?: string; hint?: string } }>(
    statusRequest > 0 ? `/api/status?request=${statusRequest}` : null,
  );
  const statsData = stats.state.kind === 'data' ? stats.state.value : stats.state.previous;

  return (
    <section aria-label={t('surfacesSystemHeading')}>
      <h2>{t('surfacesSystemHeading')}</h2>
      {statsData === null && stats.state.kind !== 'error' && <p role="status">{t('loading')}</p>}
      {statsData !== null && (
        <ul>{statsRows(statsData, locale).map((row) => <li key={row}>{row}</li>)}</ul>
      )}
      {stats.state.kind === 'error' && statsData === null && (
        <p role="alert">{t('fetchUnavailable')} <button type="button" onClick={stats.retry}>{t('shellRetry')}</button></p>
      )}
      {stats.state.kind === 'error' && stats.state.previous !== null && (
        <p role="alert">{t('consoleStaleAt', { time: stats.state.readAt ?? 'unknown' })}{' '}
          <button type="button" onClick={stats.retry}>{t('shellRetry')}</button>
        </p>
      )}
      <button type="button" onClick={() => setStatusRequest((value) => value + 1)}>{t('surfacesCheckCliButton')}</button>{' '}
      <button type="button" onClick={() => setDoctorRequest((value) => value + 1)}>{t('surfacesRunDoctorButton')}</button>
      {statusRequest > 0 && cli.state.kind === 'loading' && <p role="status">{t('loading')}</p>}
      {cli.state.kind === 'error' && <p role="alert">{t('fetchUnavailable')} <button type="button" onClick={cli.retry}>{t('shellRetry')}</button></p>}
      {cli.state.kind === 'data' && (
        <p>{cli.state.value.cli.available
          ? `${t('appCliVersionPrefix')} ${cli.state.value.cli.version ?? 'unknown'}`
          : cli.state.value.cli.hint ?? t('fetchUnavailable')}</p>
      )}
      {doctorRequest > 0 && doctor.state.kind === 'loading' && <p role="status">{t('loading')}</p>}
      {doctor.state.kind === 'error' && <p role="alert">{t('fetchUnavailable')} <button type="button" onClick={doctor.retry}>{t('shellRetry')}</button></p>}
      {doctor.state.kind === 'data' && (
        <>
          <p role={doctor.state.value.degraded === true ? 'status' : undefined}>
            {t('surfacesDoctorPrefix')}{' '}
            {doctor.state.value.available ? t('surfacesDoctorOk') : (doctor.state.value.hint ?? t('surfacesDoctorUnavailable'))}
          </p>
          {doctor.state.value.output !== undefined && <pre style={pre}>{doctor.state.value.output}</pre>}
        </>
      )}
    </section>
  );
}

export function Surfaces({
  project,
  remote,
  onMcpAuthenticate,
}: {
  project: string | null;
  remote: boolean;
  onMcpAuthenticate?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const subs = useFetch<{ subagents: string[] }>('/api/subagents?scope=user&limit=50');
  const skills = useFetch<{ skills: string[] }>('/api/skills?scope=user&limit=50');
  const hooks = useFetch<{ content: string; hash: string | null }>('/api/hooks/user');
  const mcp = useFetch<{ content: string; hash: string | null }>(
    project !== null ? `/api/mcp/project?project=${encodeURIComponent(project)}` : null,
  );
  const mcpAuth = mcpAuthenticateState(remote);

  return (
    <section aria-label={t('surfacesAriaLabel')}>
      <h2>{t('surfacesHeading')}</h2>

      <div style={box} aria-label={t('surfacesSystemHeading')}>
        <SystemPanel />
      </div>

      <div style={box} aria-label={t('surfacesMcpAriaLabel')}>
        <h3>{t('surfacesMcpHeading')}</h3>
        {project === null ? (
          <p>
            {t('surfacesSelectProjectHint')} <code>.mcp.json</code>
          </p>
        ) : mcp.kind === 'loading' ? (
          <p role="status">{t('loading')}</p>
        ) : mcp.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <pre style={pre}>{mcp.value.content === '' ? t('surfacesNoMcpYet') : mcp.value.content}</pre>
        )}
        {project !== null && (
          <p>
            <button
              type="button"
              disabled={!mcpAuth.enabled || onMcpAuthenticate === undefined}
              onClick={onMcpAuthenticate}
            >
              {t('surfacesAuthenticateButton')}
            </button>
            {mcpAuth.hint !== null && (
              <>
                {' '}
                <small>{t('surfacesLocalTerminalHint')}</small>
              </>
            )}
          </p>
        )}
      </div>

      <div style={box} aria-label={t('surfacesHooksAriaLabel')}>
        <h3>{t('surfacesHooksHeading')}</h3>
        <p><small>{t('surfacesHooksConsentNote')}</small></p>
        {hooks.kind === 'loading' ? (
          <p role="status">{t('loading')}</p>
        ) : hooks.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <pre style={pre}>{hooks.value.content === '' ? t('surfacesNoUserSettings') : hooks.value.content}</pre>
        )}
      </div>

      <div style={box} aria-label={t('surfacesSubagentsAriaLabel')}>
        <h3>{t('surfacesSubagentsHeading')}</h3>
        <p>
          {subs.kind === 'loading' ? t('loading') : subs.kind === 'error' ? t('fetchUnavailable') : subs.value.subagents.join(', ') || t('surfacesNoSubagents')}
        </p>
      </div>

      <div style={box} aria-label={t('surfacesSkillsAriaLabel')}>
        <h3>{t('surfacesSkillsHeading')}</h3>
        <p>
          {skills.kind === 'loading' ? t('loading') : skills.kind === 'error' ? t('fetchUnavailable') : skills.value.skills.join(', ') || t('surfacesNoSkills')}
        </p>
      </div>
    </section>
  );
}
