import { CryptoUtil } from './CryptoUtil';

class CalDavCredentialUtil {
  public static generatePassword(): string {
    return `cb_${CryptoUtil.randomBase64Url(32)}`;
  }

  public static async hashPassword(password: string): Promise<string> {
    return CryptoUtil.sha256Hex(password);
  }

  public static getPrefix(password: string): string {
    return password.slice(0, 10);
  }

  public static getLastFour(password: string): string {
    return password.slice(-4);
  }
}

export { CalDavCredentialUtil };
