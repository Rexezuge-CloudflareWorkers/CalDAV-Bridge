class CryptoUtil {
  public static randomBase64Url(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return CryptoUtil.base64UrlEncode(bytes);
  }

  public static async sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest))
      .map((byte: number): string => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  public static base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
}

export { CryptoUtil };
