class HttpError extends Error {
  public readonly status: number;
  public readonly headers?: HeadersInit | undefined;

  constructor(status: number, message: string, headers?: HeadersInit | undefined) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export { HttpError };
