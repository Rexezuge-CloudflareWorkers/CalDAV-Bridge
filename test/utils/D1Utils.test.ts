import { describe, expect, it } from 'vitest';
import { DatabaseError } from '@caldav-bridge/backend-errors';
import { assertD1Success, executeD1WithRetry, isD1ErrorRetryable } from '@caldav-bridge/backend-data/utils';

describe('D1 utilities', () => {
  it('classifies retryable D1 failures', () => {
    expect(isD1ErrorRetryable('database is locked')).toBe(true);
    expect(isD1ErrorRetryable('D1_ERROR: network timeout')).toBe(true);
    expect(isD1ErrorRetryable('UNIQUE constraint failed: users.email')).toBe(false);
    expect(isD1ErrorRetryable('no such table: missing')).toBe(false);
  });

  it('asserts D1 success with retryable context', () => {
    expect(() => assertD1Success({ success: true } as D1Result, 'write row')).not.toThrow();
    try {
      assertD1Success({ success: false, error: 'database is locked' } as unknown as D1Result, 'write row');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseError);
      expect((error as DatabaseError).retryable).toBe(true);
      expect((error as Error).message).toContain('write row');
    }
  });

  it('retries retryable failures and returns the first success', async () => {
    let attempts = 0;
    const result = await executeD1WithRetry(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('database is locked'));
        return Promise.resolve({ success: true } as D1Result);
      },
      'write row',
      { baseDelayMs: 1 },
    );

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
  });

  it('wraps terminal failures in database errors', async () => {
    const error = await executeD1WithRetry(() => Promise.reject(new Error('UNIQUE constraint failed')), 'insert row', {
      baseDelayMs: 1,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).retryable).toBe(false);
  });

  it('gives up after exhausting retries', async () => {
    let attempts = 0;
    const error = await executeD1WithRetry(
      () => {
        attempts += 1;
        return Promise.reject(new Error('database is locked'));
      },
      'write row',
      { maxRetries: 1, baseDelayMs: 1 },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(attempts).toBe(2);
  });
});
