import { ServiceUnavailableError } from '@rexezuge/errors';

/**
 * Transport decoration for an error response.
 *
 * The kit's taxonomy deliberately carries no response headers: a status code
 * and a message are the taxonomy's whole job, and header policy belongs to the
 * route. This repo has exactly one case that needs one — a `429`-adjacent
 * `ServiceUnavailableError` from a provider throttle, whose `Retry-After` has
 * to reach the *client* that retries, not just the internal retry loop — so
 * the capability lives here as a named subclass rather than as a header bag on
 * the base error.
 */
class RetryAfterError extends ServiceUnavailableError {
  public readonly headers: Record<string, string>;

  public constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.headers = { 'Retry-After': String(retryAfterSeconds) };
  }
}

export { RetryAfterError };
