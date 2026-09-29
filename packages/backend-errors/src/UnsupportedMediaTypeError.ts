import { ErrorCode, ServiceError } from './IServiceError';

class UnsupportedMediaTypeError extends ServiceError {
  constructor(message?: string) {
    super(message ?? 'The request body media type is not supported by this resource.');
  }

  public getErrorCode(): ErrorCode {
    return 415;
  }

  public getErrorType(): string {
    return 'UnsupportedMediaType';
  }

  public getErrorMessage(): string {
    return this.message;
  }
}

export { UnsupportedMediaTypeError };
