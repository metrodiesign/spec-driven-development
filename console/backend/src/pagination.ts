export interface PaginationQuery {
  readonly cursor: string | null;
  readonly limit: number;
}

export class InvalidPaginationQueryError extends Error {}

type NamedCursor = { readonly version: 1; readonly sort: 'name'; readonly name: string };
type CreatedCursor = {
  readonly version: 1;
  readonly sort: 'created';
  readonly createdAt: string;
  readonly id: string;
};

export function parseOptionalPagination(query: {
  readonly cursor?: string;
  readonly limit?: string;
}): PaginationQuery | null {
  if (query.cursor === undefined && query.limit === undefined) return null;
  const rawLimit = query.limit ?? '50';
  if (!/^\d+$/u.test(rawLimit)) throw new InvalidPaginationQueryError('limit must be an integer from 1 to 100');
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidPaginationQueryError('limit must be an integer from 1 to 100');
  }
  if (query.cursor === '') throw new InvalidPaginationQueryError('cursor is malformed');
  return { cursor: query.cursor ?? null, limit };
}

function encodeCursor(value: NamedCursor | CreatedCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new InvalidPaginationQueryError('cursor is malformed');
  }
}

function namedCursor(cursor: string): NamedCursor {
  const decoded = decodeCursor(cursor);
  if (
    typeof decoded !== 'object' || decoded === null ||
    (decoded as Record<string, unknown>)['version'] !== 1 ||
    (decoded as Record<string, unknown>)['sort'] !== 'name' ||
    typeof (decoded as Record<string, unknown>)['name'] !== 'string'
  ) {
    throw new InvalidPaginationQueryError('cursor is malformed');
  }
  return decoded as NamedCursor;
}

function createdCursor(cursor: string): CreatedCursor {
  const decoded = decodeCursor(cursor);
  if (
    typeof decoded !== 'object' || decoded === null ||
    (decoded as Record<string, unknown>)['version'] !== 1 ||
    (decoded as Record<string, unknown>)['sort'] !== 'created' ||
    typeof (decoded as Record<string, unknown>)['createdAt'] !== 'string' ||
    typeof (decoded as Record<string, unknown>)['id'] !== 'string'
  ) {
    throw new InvalidPaginationQueryError('cursor is malformed');
  }
  return decoded as CreatedCursor;
}

export function paginateNamed<T>(
  records: readonly T[],
  nameOf: (record: T) => string,
  query: PaginationQuery,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const sorted = [...records].sort((left, right) => nameOf(left).localeCompare(nameOf(right)));
  const after = query.cursor === null ? null : namedCursor(query.cursor).name;
  const eligible = after === null ? sorted : sorted.filter((record) => nameOf(record).localeCompare(after) > 0);
  const items = eligible.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: eligible.length > query.limit && last !== undefined
      ? encodeCursor({ version: 1, sort: 'name', name: nameOf(last) })
      : null,
  };
}

export function paginateCreated<T>(
  records: readonly T[],
  createdAtOf: (record: T) => string,
  idOf: (record: T) => string,
  query: PaginationQuery,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const sorted = [...records].sort((left, right) => {
    const byCreated = createdAtOf(left).localeCompare(createdAtOf(right));
    return byCreated === 0 ? idOf(left).localeCompare(idOf(right)) : byCreated;
  });
  const after = query.cursor === null ? null : createdCursor(query.cursor);
  const eligible = after === null
    ? sorted
    : sorted.filter((record) => {
        const byCreated = createdAtOf(record).localeCompare(after.createdAt);
        return byCreated > 0 || (byCreated === 0 && idOf(record).localeCompare(after.id) > 0);
      });
  const items = eligible.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: eligible.length > query.limit && last !== undefined
      ? encodeCursor({ version: 1, sort: 'created', createdAt: createdAtOf(last), id: idOf(last) })
      : null,
  };
}
