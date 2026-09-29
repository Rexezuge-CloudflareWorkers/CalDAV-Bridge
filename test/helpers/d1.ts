import type { DatabaseSync } from 'node:sqlite';

/** The slice of the D1 prepared-statement surface the DAOs rely on. */
interface D1LikeStatement {
  bind(...bindings: unknown[]): D1LikeStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | undefined>;
  all<T>(): Promise<{ results: T[] }>;
}

/**
 * Minimal D1 adapter over `node:sqlite`.
 *
 * DAO tests use this so they exercise the real SQL against a real SQLite engine
 * instead of a hand-written fake, which is free to drift from the schema -- and a
 * fake that has drifted will happily pass a query the database would reject.
 *
 * `changes()` in `node:sqlite` reports the *previous* statement, so it is read
 * from a separate statement immediately after the mutation. The cleanup reapers
 * branch on it, and the split is why `run()` (mutating) and `first()`/`all()`
 * (reading) are handled separately rather than sharing one code path.
 */
function asD1Queryable(database: DatabaseSync): never {
  const changes = (): number => (database.prepare('SELECT changes() AS changes').get() as { changes: number } | undefined)?.changes ?? 0;

  const statement = (sql: string, bindings: unknown[]): D1LikeStatement => {
    const args = bindings as never[];
    const shared: D1LikeStatement = {
      bind: (...next: unknown[]) => statement(sql, next),
      run: async () => {
        database.prepare(sql).run(...args);
        return { meta: { changes: changes() } };
      },
      first: async <T>() => database.prepare(sql).get(...args) as T | undefined,
      all: async <T>() => ({ results: database.prepare(sql).all(...args) as T[] }),
    };
    return shared;
  };

  return { prepare: (sql: string) => statement(sql, []) } as never;
}

export { asD1Queryable };
