import { DatabaseError } from '@caldav-bridge/backend-errors';
import type { D1Queryable } from '../utils';

/**
 * Shared plumbing for every DAO.
 *
 * Each DAO states only its own SQL and row mapping; statement execution, the
 * bound-parameters convention, and the mapping of a driver-level failure onto a
 * `DatabaseError` live here. Before this existed each DAO reimplemented a
 * constructor, so a D1 failure surfaced as a raw `D1Error` whose message reached
 * the client -- which is how a table and column name ended up in a response
 * body.
 */
abstract class BaseDAO {
  protected constructor(protected readonly database: D1Queryable) {}

  /** A statement, bound. Bindings are always parameters, never interpolation. */
  protected statement(sql: string, bindings: unknown[] = []): D1PreparedStatement {
    return bindings.length ? this.database.prepare(sql).bind(...bindings) : this.database.prepare(sql);
  }

  /**
   * Run a statement.
   *
   * D1 reports a constraint violation or a missing table by returning
   * `success: false` rather than by throwing, so both forms are normalised to a
   * `DatabaseError` here. Ignoring the result form is what let a `UNIQUE`
   * failure reach a caller as an opaque 500 that the credential service then had
   * to identify by matching `/unique constraint/i` against an error message.
   */
  protected async run(sql: string, bindings: unknown[] = []): Promise<D1Result> {
    return BaseDAO.attempt('run statement', async () => BaseDAO.unchecked(await this.statement(sql, bindings).run(), 'run statement'));
  }

  /**
   * Read one row.
   *
   * `first()` resolves to the row, or to a result carrying `success: false` when
   * the statement failed -- the two are told apart by that flag, since a
   * successful query with no match also resolves to a nullish value.
   */
  protected async first<T>(sql: string, bindings: unknown[] = []): Promise<T | undefined> {
    const row = await BaseDAO.attempt('read a row', async () =>
      BaseDAO.unchecked(await this.statement(sql, bindings).first<T & D1Result>(), 'read a row'),
    );
    return (row as T | undefined) ?? undefined;
  }

  protected async all<T>(sql: string, bindings: unknown[] = []): Promise<T[]> {
    const result = await BaseDAO.attempt('read rows', async () =>
      BaseDAO.unchecked(await this.statement(sql, bindings).all<T>(), 'read rows'),
    );
    return result.results || [];
  }

  /**
   * A batch is one transaction and one subrequest, however many statements it
   * carries. That asymmetry is the entire reason to use one.
   */
  protected async batch(statements: D1PreparedStatement[]): Promise<void> {
    if (!statements.length) return;
    const results = await BaseDAO.attempt('run a batch', () => this.database.batch(statements));
    for (const result of results) BaseDAO.unchecked(result, 'run a batch');
  }

  /**
   * Turn a failure into a `DatabaseError`, whether it was reported or thrown.
   *
   * The driver's own message is carried on the error for the log. Nothing above
   * this layer sees it, because it names tables and columns.
   */
  private static async attempt<T>(context: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError(`Failed to ${context}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Turn a `success: false` result into the error a throw would have produced. */
  private static unchecked<T extends { success?: boolean; error?: string } | null | undefined>(result: T, context: string): T {
    if (result?.success !== false) return result;
    throw new DatabaseError(`Failed to ${context}: ${result.error ?? 'unknown database error'}`);
  }
}

/**
 * A DAO that reads or writes values encrypted at rest, and so needs the master key.
 *
 * Public so that services outside this package can construct one; the master key
 * is still a required argument, so there is no unencrypted fallback.
 */
abstract class EncryptedDAO extends BaseDAO {
  constructor(
    database: D1Queryable,
    protected readonly masterKey: string,
  ) {
    super(database);
  }
}

export { BaseDAO, EncryptedDAO };
