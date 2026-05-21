import { CryptoUtil } from './CryptoUtil';

const USERNAME_ANIMALS = [
  'alpaca',
  'badger',
  'beaver',
  'bobcat',
  'buffalo',
  'camel',
  'cheetah',
  'cougar',
  'coyote',
  'dolphin',
  'eagle',
  'falcon',
  'ferret',
  'fox',
  'gazelle',
  'giraffe',
  'gorilla',
  'hamster',
  'heron',
  'jaguar',
  'koala',
  'lemur',
  'leopard',
  'llama',
  'lynx',
  'meerkat',
  'moose',
  'otter',
  'panda',
  'panther',
  'penguin',
  'puma',
  'rabbit',
  'raccoon',
  'raven',
  'seal',
  'tiger',
  'walrus',
  'weasel',
  'zebra',
] as const;

class CalDavCredentialUtil {
  public static generatePassword(): string {
    return `cb_${CryptoUtil.randomBase64Url(32)}`;
  }

  public static generateUsername(): string {
    const animal = USERNAME_ANIMALS[CalDavCredentialUtil.randomInteger(USERNAME_ANIMALS.length)]!;
    const digits = CalDavCredentialUtil.randomInteger(10000).toString().padStart(4, '0');
    return `${animal}${digits}`;
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

  private static randomInteger(maxExclusive: number): number {
    const values = new Uint32Array(1);
    const limit = Math.floor(0xffffffff / maxExclusive) * maxExclusive;
    do {
      crypto.getRandomValues(values);
    } while (values[0]! >= limit);
    return values[0]! % maxExclusive;
  }
}

export { CalDavCredentialUtil };
