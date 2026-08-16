export const CONSOLE_VIEWS = [
  'projects',
  'sessions',
  'terminal',
  'chat',
  'runs',
  'scheduler',
  'issues',
  'pr-quality',
  'governance',
  'system',
  'usage',
] as const;

export type ConsoleView = (typeof CONSOLE_VIEWS)[number];

export function consoleView(value: string | null): ConsoleView {
  return value !== null && (CONSOLE_VIEWS as readonly string[]).includes(value)
    ? value as ConsoleView
    : 'projects';
}

export function mergeNamedRecords<T>(
  current: readonly T[],
  incoming: readonly T[],
  nameOf: (record: T) => string,
): readonly T[] {
  const records = new Map(current.map((record) => [nameOf(record), record]));
  for (const record of incoming) records.set(nameOf(record), record);
  return [...records.values()].sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
}
