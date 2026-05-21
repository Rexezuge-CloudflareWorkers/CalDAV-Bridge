class ConfigurationUtil {
  public static getPositiveInteger(value: string | undefined, fallback: string): number {
    const parsed = Number(value || fallback);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : Number(fallback);
  }

  public static getServeSpaFromWorker(env: { SERVE_SPA_FROM_WORKER?: string | undefined }): boolean {
    return env.SERVE_SPA_FROM_WORKER === 'true';
  }
}

export { ConfigurationUtil };
