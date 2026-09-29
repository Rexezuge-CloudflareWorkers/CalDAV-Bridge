import { ErrorCode, ServiceError } from './IServiceError';

class NotImplementedError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'The requested operation is not supported.');
  }

  public getErrorCode(): ErrorCode {
    return 501;
  }

  public getErrorType(): string {
    return 'NotImplemented';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { NotImplementedError };
