// Pure display logic for the Phase-2 governance surfaces (F-MCP/F-Hook/F-Sub/
// F-Skill/F-Sys). Testable without a DOM — the views stay thin (ARCHITECTURE).

export interface SysStats {
  platform: string;
  arch: string;
  cpus: number;
  totalMem: number;
  freeMem: number;
  loadAvg: number[];
  uptimeS: number;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/** One line per host stat for the F-Sys card. */
export function statsRows(s: SysStats): string[] {
  return [
    `host: ${s.platform}/${s.arch} · ${s.cpus} CPUs`,
    `memory: ${gib(s.freeMem)} free of ${gib(s.totalMem)}`,
    `load (1m): ${(s.loadAvg[0] ?? 0).toFixed(2)}`,
    `uptime: ${Math.floor(s.uptimeS / 3600)}h`,
  ];
}

/** Render a validate-step diff as prefixed lines the way the consent card shows it. */
export function diffLines(diff: { removed: string[]; added: string[] }): string[] {
  return [...diff.removed.map((l) => `- ${l}`), ...diff.added.map((l) => `+ ${l}`)];
}

/** Empty-state text for a list surface, so a scope with no entries still reads clearly. */
export function listOrEmpty(items: string[], noun: string): string {
  return items.length === 0 ? `no ${noun} in this scope` : items.join(', ');
}
