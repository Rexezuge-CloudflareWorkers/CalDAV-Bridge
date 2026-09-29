import { ErrorCode, ServiceError } from './IServiceError';

class RequestEntityTooLargeError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'The request body is larger than this server accepts.');
  }

  public getErrorCode(): ErrorCode {
    return 413;
  }

  public getErrorType(): string {
    return 'RequestEntityTooLarge';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { RequestEntityTooLargeError };
