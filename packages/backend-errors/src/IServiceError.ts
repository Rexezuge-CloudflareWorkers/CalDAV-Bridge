import { ContentfulStatusCode } from 'hono/utils/http-status';

abstract class ServiceError extends Error {
  public retryable: boolean = false;
  public headers?: HeadersInit | undefined;

  public abstract getErrorCode(): ErrorCode;

  public abstract getErrorType(): string;

  public abstract getErrorMessage(): string;
}

type ErrorCode = ContentfulStatusCode;

export { ServiceError };
export type { ErrorCode };
