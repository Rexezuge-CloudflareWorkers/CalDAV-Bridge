class BaseUrlUtil {
  public static getBaseUrl(request: Request): string {
    const url = new URL(request.url);
    const forwardedProto = request.headers.get('X-Forwarded-Proto');
    const forwardedHost = request.headers.get('X-Forwarded-Host');
    return `${forwardedProto || url.protocol.replace(':', '')}://${forwardedHost || url.host}`;
  }
}

export { BaseUrlUtil };
