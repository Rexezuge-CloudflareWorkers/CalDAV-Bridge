import { ErrorCode, ServiceError } from './IServiceError';

class PreconditionFailedError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'A precondition supplied with the request evaluated to false.');
  }

  public getErrorCode(): ErrorCode {
    return 412;
  }

  public getErrorType(): string {
    return 'PreconditionFailed';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { PreconditionFailedError };
