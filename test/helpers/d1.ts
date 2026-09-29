import type { DatabaseSync } from 'node:sqlite';

import type { D1Queryable as ProductionD1Queryable } from '@caldav-bridge/backend-data/utils';

/**
 * The `D1Queryable` a DAO accepts, re-exported so a test can name it without
 * importing the production module directly.
 */
type D1Queryable = ProductionD1Queryable;

/** The slice of the D1 prepared-statement surface the DAOs rely on. */
interface D1LikeStatement {
  bind(...bindings: unknown[]): D1LikeStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | undefined>;
  all<T>(): Promise<{ results: T[] }>;
}

/** `prepare` plus `batch`, matching the `D1Queryable` the production DAOs accept. */
interface D1QueryableLike {
  prepare(sql: string): D1LikeStatement;
  batch(statements: Array<{ run: () => Promise<unknown> }>): Promise<unknown[]>;
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
  return buildQueryable(database, () => 0) as never;
}

/** Shared adapter body, parameterised by a hook invoked once per executed statement. */
function buildQueryable(database: DatabaseSync, onExecute: (options?: { inBatch?: boolean }) => void): D1QueryableLike {
  const changes = (): number => (database.prepare('SELECT changes() AS changes').get() as { changes: number } | undefined)?.changes ?? 0;
  let batchDepth = 0;

  const statement = (sql: string, bindings: unknown[]): D1LikeStatement => {
    const args = bindings as never[];
    const shared: D1LikeStatement = {
      bind: (...next: unknown[]) => statement(sql, next),
      run: async () => {
        onExecute({ inBatch: batchDepth > 0 });
        database.prepare(sql).run(...args);
        return { meta: { changes: changes() } };
      },
      first: async <T>() => {
        onExecute({ inBatch: batchDepth > 0 });
        return database.prepare(sql).get(...args) as T | undefined;
      },
      all: async <T>() => {
        onExecute({ inBatch: batchDepth > 0 });
        return { results: database.prepare(sql).all(...args) as T[] };
      },
    };
    return shared;
  };

  return {
    prepare: (sql: string) => statement(sql, []),
    // D1 runs a batch as one transaction. `node:sqlite` has no batch primitive,
    // so the statements are wrapped to share the one transaction -- otherwise a
    // batch that failed partway would leave earlier statements committed, which
    // is exactly the atomicity guarantee the DAOs rely on.
    batch: async (statements: Array<{ run: () => Promise<unknown> }>) => {
      onExecute();
      batchDepth += 1;
      database.exec('BEGIN');
      try {
        const results: unknown[] = [];
        for (const entry of statements) results.push(await entry.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      } finally {
        batchDepth -= 1;
      }
    },
  };
}

/**
 * Counts the D1 subrequests a caller would issue against a real database.
 *
 * Each executed statement is one subrequest, except inside a `batch`, which is
 * one subrequest however many statements it carries -- that asymmetry being the
 * entire reason to batch. This makes a subrequest-budget regression observable
 * in a test rather than in production.
 */
interface CountingQueryable {
  database: D1Queryable;
  subrequests: () => number;
}

function countingD1Queryable(database: DatabaseSync): CountingQueryable {
  let count = 0;
  const counting = buildQueryable(database, (options) => {
    // A batch is one subrequest however many statements it carries, so only the
    // batch call is charged. That asymmetry is the entire reason to batch.
    if (options?.inBatch) return;
    count += 1;
  });
  return { database: counting as unknown as D1Queryable, subrequests: () => count };
}

export { asD1Queryable, countingD1Queryable };
export type { CountingQueryable };
export type { D1Queryable };
