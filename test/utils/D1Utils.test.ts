import { describe, expect, it, vi } from 'vitest';
import { DatabaseError } from '@caldav-bridge/backend-errors';
import { executeD1WithRetry, isD1ErrorRetryable } from '@caldav-bridge/backend-data/utils';

const success = (): D1Result => ({ success: true }) as D1Result;
const failure = (error: string): D1Result => ({ success: false, error }) as unknown as D1Result;

describe('isD1ErrorRetryable', () => {
  it('classifies transient failures as worth retrying', () => {
    // These are the ones a second attempt resolves, so giving up on them turns a
    // momentary contention into a user-visible failure.
    for (const message of ['database is locked', 'D1_ERROR: network timeout', 'SQLITE_BUSY', 'temporarily unavailable']) {
      expect(isD1ErrorRetryable(message)).toBe(true);
    }
  });

  it('classifies permanent failures as not worth retrying', () => {
    // Retrying a constraint violation only delays the error and repeats the
    // write, so these must be raised on the first attempt.
    for (const message of ['UNIQUE constraint failed: users.email', 'no such table: missing', 'NOT NULL constraint failed']) {
      expect(isD1ErrorRetryable(message)).toBe(false);
    }
  });
});

describe('executeD1WithRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue(success());

    await expect(executeD1WithRetry(operation, 'write row')).resolves.toMatchObject({ success: true });
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retries a thrown transient failure until it succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(success());

    await expect(executeD1WithRetry(operation, 'write row', { baseDelayMs: 1 })).resolves.toMatchObject({ success: true });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  /**
   * D1 reports a failure by resolving the result, not by throwing. A retry loop
   * that only inspected rejections would treat a `success: false` as success and
   * report a write that never happened.
   */
  it('treats a `success: false` result as a failure', async () => {
    const operation = vi.fn().mockResolvedValue(failure('UNIQUE constraint failed: users.email'));

    const error = await executeD1WithRetry(operation, 'insert row', { baseDelayMs: 1 }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DatabaseError);
    // Not retried: a constraint violation is permanent.
    expect(operation).toHaveBeenCalledOnce();
  });

  it('retries a `success: false` result that looks transient', async () => {
    const operation = vi.fn().mockResolvedValueOnce(failure('database is locked')).mockResolvedValue(success());

    await expect(executeD1WithRetry(operation, 'write row', { baseDelayMs: 1 })).resolves.toMatchObject({ success: true });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('marks a permanent failure as not retryable and names the operation', async () => {
    const error = await executeD1WithRetry(() => Promise.resolve(failure('UNIQUE constraint failed: users.email')), 'insert row', {
      baseDelayMs: 1,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).retryable).toBe(false);
    expect((error as Error).message).toContain('insert row');
  });

  it('gives up after exhausting its retries', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('database is locked'));

    const error = await executeD1WithRetry(operation, 'write row', { maxRetries: 2, baseDelayMs: 1 }).catch((failure: unknown) => failure);

    // The first attempt plus two retries.
    expect(operation).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).retryable).toBe(true);
  });

  it('waits longer between successive attempts', async () => {
    const delays: number[] = [];
    const realSleep = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      handler();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    try {
      await executeD1WithRetry(() => Promise.reject(new Error('database is locked')), 'write row', { maxRetries: 2 }).catch(
        () => undefined,
      );

      // The cause of a busy database is the contention that produced it, so
      // retrying immediately would collide again.
      expect(delays).toEqual([100, 200]);
    } finally {
      vi.restoreAllMocks();
      globalThis.setTimeout = realSleep;
    }
  });
});
