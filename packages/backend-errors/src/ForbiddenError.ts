import { ErrorCode, ServiceError } from './IServiceError';

class ForbiddenError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'The authenticated identity is not allowed to perform this action.');
  }

  public getErrorCode(): ErrorCode {
    return 403;
  }

  public getErrorType(): string {
    return 'Forbidden';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { ForbiddenError };
