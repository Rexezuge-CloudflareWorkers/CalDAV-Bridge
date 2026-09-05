import { ErrorCode, ServiceError } from './IServiceError';

class ServiceUnavailableError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'The server is temporarily unable to handle the request.');
  }

  public getErrorCode(): ErrorCode {
    return 503;
  }

  public getErrorType(): string {
    return 'ServiceUnavailable';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { ServiceUnavailableError };
