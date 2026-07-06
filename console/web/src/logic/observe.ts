// Observability display logic (pure, unit-tested) for F-Usage / F-Act / F-Sess.

export interface UsageIndexView {
  interactive: number;
  autonomous: number;
  byModel: Record<string, number>;
  label: string;
}

/** One-line usage summary, always flagged as an estimate (INV-13). */
export function usageSummary(idx: UsageIndexView): string {
  const total = idx.interactive + idx.autonomous;
  return `${total} runs (${idx.interactive} interactive · ${idx.autonomous} autonomous) — ${idx.label}`;
}

/** Sorted model rows for the usage table. */
export function modelRows(idx: UsageIndexView): { model: string; count: number }[] {
  return Object.entries(idx.byModel)
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}
