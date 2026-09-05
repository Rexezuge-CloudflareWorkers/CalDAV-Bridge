import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  DatabaseError,
  DefaultInternalServerError,
  ForbiddenError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  PreconditionFailedError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@caldav-bridge/backend-errors';

describe('error classes', () => {
  it('exposes HTTP status codes, types, and messages', () => {
    const cases = [
      { error: new BadRequestError('bad'), code: 400, type: 'BadRequest' },
      { error: new UnauthorizedError('unauthorized'), code: 401, type: 'Unauthorized' },
      { error: new ForbiddenError('forbidden'), code: 403, type: 'Forbidden' },
      { error: new NotFoundError('missing'), code: 404, type: 'NotFound' },
      { error: new MethodNotAllowedError('nope'), code: 405, type: 'MethodNotAllowed' },
      { error: new PreconditionFailedError('stale'), code: 412, type: 'PreconditionFailed' },
      { error: new InternalServerError('broken'), code: 500, type: 'InternalServerError' },
      { error: new ServiceUnavailableError('busy'), code: 503, type: 'ServiceUnavailable' },
    ] as const;

    for (const { error, code, type } of cases) {
      expect(error.getErrorCode()).toBe(code);
      expect(error.getErrorType()).toBe(type);
      expect(error.getErrorMessage()).toBe(error.message);
      expect(error.retryable).toBe(false);
      expect(error.headers).toBeUndefined();
    }
  });

  it('provides default messages and a shared default internal error', () => {
    expect(new BadRequestError().message).toContain('request');
    expect(new UnauthorizedError().message).toContain('Authentication');
    expect(DefaultInternalServerError).toBeInstanceOf(InternalServerError);
    expect(DefaultInternalServerError.getErrorCode()).toBe(500);
  });

  it('marks database errors retryable on demand', () => {
    expect(new DatabaseError('locked', true)).toMatchObject({ retryable: true });
    expect(new DatabaseError('locked', true).getErrorType()).toBe('DatabaseError');
    expect(new DatabaseError('locked', true).getErrorCode()).toBe(500);
    expect(new DatabaseError('plain').retryable).toBe(false);
  });

  it('carries optional transport headers', () => {
    const error = new ServiceUnavailableError('throttled');
    error.headers = { 'Retry-After': '5' };
    expect(error.headers).toEqual({ 'Retry-After': '5' });
  });
});
