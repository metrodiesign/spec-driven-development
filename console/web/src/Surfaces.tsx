// Phase-2 governance surfaces — minimal read views (F-MCP/F-Hook/F-Sub/F-Skill/
// F-Sys). Thin by design: display shaping lives in logic/surfaces.ts. Writes are
// governed by the backend (consent gate + writeSafe) and covered by API tests;
// these pages surface the current state and the operator's entry points.

import { statsRows, listOrEmpty, mcpAuthenticateState, type SysStats } from './logic/surfaces.ts';
import { useI18n } from './I18nContext.tsx';
import { useFetch } from './useFetch.ts';

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

export function Surfaces({ project, remote }: { project: string | null; remote: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const stats = useFetch<SysStats>('/api/system/stats');
  const doctor = useFetch<{ available: boolean; degraded?: boolean; output?: string; hint?: string }>('/api/system/doctor');
  const subs = useFetch<{ subagents: string[] }>('/api/subagents?scope=user');
  const skills = useFetch<{ skills: string[] }>('/api/skills?scope=user');
  const hooks = useFetch<{ content: string; hash: string | null }>('/api/hooks/user');
  const mcp = useFetch<{ content: string; hash: string | null }>(
    project !== null ? `/api/mcp/project?project=${encodeURIComponent(project)}` : null,
  );
  const mcpAuth = mcpAuthenticateState(remote);

  return (
    <section aria-label={t('surfacesAriaLabel')}>
      <h2>{t('surfacesHeading')}</h2>

      <div style={box} aria-label={t('surfacesSystemHeading')}>
        <h3>{t('surfacesSystemHeading')}</h3>
        {stats.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : stats.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <ul>{statsRows(stats.value).map((r) => <li key={r}>{r}</li>)}</ul>
        )}
        {doctor.kind === 'data' && (
          <p role={doctor.value.degraded === true ? 'status' : undefined}>
            {t('surfacesDoctorPrefix')}{' '}
            {doctor.value.available ? t('surfacesDoctorOk') : (doctor.value.hint ?? t('surfacesDoctorUnavailable'))}
          </p>
        )}
      </div>

      <div style={box} aria-label={t('surfacesMcpAriaLabel')}>
        <h3>{t('surfacesMcpHeading')}</h3>
        {project === null ? (
          <p>
            {t('surfacesSelectProjectHint')} <code>.mcp.json</code>
          </p>
        ) : mcp.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : mcp.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <pre style={pre}>{mcp.value.content === '' ? t('surfacesNoMcpYet') : mcp.value.content}</pre>
        )}
        {project !== null && (
          <p>
            <button
              type="button"
              disabled={!mcpAuth.enabled}
              onClick={() => {
                window.location.search = `?project=${encodeURIComponent(project)}&cmd=mcp`;
              }}
            >
              {t('surfacesAuthenticateButton')}
            </button>
            {mcpAuth.hint !== null && (
              <>
                {' '}
                <small>{mcpAuth.hint}</small>
              </>
            )}
          </p>
        )}
      </div>

      <div style={box} aria-label={t('surfacesHooksAriaLabel')}>
        <h3>{t('surfacesHooksHeading')}</h3>
        <p><small>{t('surfacesHooksConsentNote')}</small></p>
        {hooks.kind === 'loading' ? (
          <p>{t('loading')}</p>
        ) : hooks.kind === 'error' ? (
          <p role="status">{t('fetchUnavailable')}</p>
        ) : (
          <pre style={pre}>{hooks.value.content === '' ? t('surfacesNoUserSettings') : hooks.value.content}</pre>
        )}
      </div>

      <div style={box} aria-label={t('surfacesSubagentsAriaLabel')}>
        <h3>{t('surfacesSubagentsHeading')}</h3>
        <p>
          {subs.kind === 'loading' ? t('loading') : subs.kind === 'error' ? t('fetchUnavailable') : listOrEmpty(subs.value.subagents, 'subagents')}
        </p>
      </div>

      <div style={box} aria-label={t('surfacesSkillsAriaLabel')}>
        <h3>{t('surfacesSkillsHeading')}</h3>
        <p>
          {skills.kind === 'loading' ? t('loading') : skills.kind === 'error' ? t('fetchUnavailable') : listOrEmpty(skills.value.skills, 'skills')}
        </p>
      </div>
    </section>
  );
}
