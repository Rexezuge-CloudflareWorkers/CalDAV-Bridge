import { DatabaseError } from '@caldav-bridge/backend-errors';
import { isD1ErrorRetryable } from './D1ErrorClassifier';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve: (value: void) => void): unknown => setTimeout(resolve, ms));
}

/**
 * Whether a failure is worth another attempt.
 *
 * A `DatabaseError` from `BaseDAO` carries this on `retryable`; a driver-level
 * throw is classified from its message, since the `success: false` form never
 * reaches the caller.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof DatabaseError) return error.retryable;
  return isD1ErrorRetryable(error instanceof Error ? error.message : String(error));
}

/**
 * Run a statement, retrying while the failure looks transient.
 *
 * D1's transient failures -- a locked database, a busy replica, a dropped
 * network hop -- are resolved by trying again, and a request that gives up on
 * the first one surfaces to the user as an error that would have succeeded a
 * moment later. A non-retryable failure is raised immediately: retrying a
 * `UNIQUE` violation only delays the error and repeats the write.
 *
 * The delay grows exponentially, because the cause of a busy database is the
 * contention that produced it.
 */
async function executeD1WithRetry(
  operation: () => Promise<D1Result>,
  context: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): Promise<D1Result> {
  const maxRetries: number = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs: number = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const result: D1Result = await operation();
      // The generated bindings type `success` as the literal `true`, but D1 does
      // resolve a failed statement with `success: false` and a message rather
      // than by throwing. Reading it through a widened type is what lets a failed
      // statement be treated as a failure here instead of as a success.
      if ((result as { success?: boolean }).success !== false) return result;
      const message = (result as { error?: string }).error ?? 'unknown database error';
      throw new DatabaseError(`Failed to ${context}: ${message}`, isD1ErrorRetryable(message));
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw toDatabaseError(error, context);
      await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
}

/**
 * Normalise a failure to a `DatabaseError` that still says whether it was worth
 * retrying. A driver-level throw carries no such flag, so it is classified from
 * the message -- losing that would tell a caller deciding whether to surface
 * "please try again" that a transient failure was permanent.
 */
function toDatabaseError(error: unknown, context: string): DatabaseError {
  if (error instanceof DatabaseError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DatabaseError(`Failed to ${context}: ${message}`, isD1ErrorRetryable(message));
}

export { executeD1WithRetry, sleep };
