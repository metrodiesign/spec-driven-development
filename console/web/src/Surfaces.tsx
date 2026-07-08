// Phase-2 governance surfaces — minimal read views (F-MCP/F-Hook/F-Sub/F-Skill/
// F-Sys). Thin by design: display shaping lives in logic/surfaces.ts. Writes are
// governed by the backend (consent gate + writeSafe) and covered by API tests;
// these pages surface the current state and the operator's entry points.

import { useEffect, useState } from 'react';

import { statsRows, listOrEmpty, mcpAuthenticateState, type SysStats } from './logic/surfaces.ts';

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
const pre: React.CSSProperties = { overflowX: 'auto', maxWidth: '100%', background: '#8881', padding: '0.5rem', borderRadius: 4 };

export function Surfaces({ project, remote }: { project: string | null; remote: boolean }): React.JSX.Element {
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
    <section aria-label="Governance surfaces">
      <h2>Governance</h2>

      <div style={box} aria-label="System">
        <h3>System</h3>
        {stats === null ? <p>loading…</p> : <ul>{statsRows(stats).map((r) => <li key={r}>{r}</li>)}</ul>}
        {doctor !== null && (
          <p role={doctor.degraded === true ? 'status' : undefined}>
            doctor: {doctor.available ? 'ok' : (doctor.hint ?? 'unavailable')}
          </p>
        )}
      </div>

      <div style={box} aria-label="MCP servers">
        <h3>MCP (project)</h3>
        {project === null ? (
          <p>select a project to view its <code>.mcp.json</code></p>
        ) : mcp === null ? (
          <p>loading…</p>
        ) : (
          <pre style={pre}>{mcp.content === '' ? 'no .mcp.json yet' : mcp.content}</pre>
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
              Authenticate
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

      <div style={box} aria-label="Hooks">
        <h3>Hooks (user)</h3>
        <p><small>Edits require two-step consent (preview + confirm token) — see the CLI or the hook editor.</small></p>
        {hooks === null ? <p>loading…</p> : <pre style={pre}>{hooks.content === '' ? 'no user settings.json' : hooks.content}</pre>}
      </div>

      <div style={box} aria-label="Subagents">
        <h3>Subagents (user)</h3>
        <p>{subs === null ? 'loading…' : listOrEmpty(subs.subagents, 'subagents')}</p>
      </div>

      <div style={box} aria-label="Skills">
        <h3>Skills (user)</h3>
        <p>{skills === null ? 'loading…' : listOrEmpty(skills.skills, 'skills')}</p>
      </div>
    </section>
  );
}
