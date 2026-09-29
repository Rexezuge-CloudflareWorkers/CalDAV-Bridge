/**
 * Reads a string value out of a Worker's environment.
 *
 * The environment is `unknown` at this boundary -- the type comes from generated
 * bindings that may not cover a variable at all -- so every read is defensive.
 * The value a variable holds is operator-controlled, and a silent coercion here
 * becomes a silent misconfiguration in production.
 */
class EnvParser {
  /** A positive integer, or the default. `0` is not positive. */
  public static positiveInt(env: unknown, key: string, defaultValue: string): number {
    return EnvParser.toInt(EnvParser.readString(env, key), defaultValue, (value) => value > 0);
  }

  /**
   * A non-negative integer, or the default.
   *
   * `0` is meaningful here rather than invalid: a retention period of `0` reads
   * as "reap immediately", and `DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS`
   * defaults to it. Which is exactly why an *empty* value must not become `0` --
   * see `toInt`.
   */
  public static nonNegativeInt(env: unknown, key: string, defaultValue: string): number {
    return EnvParser.toInt(EnvParser.readString(env, key), defaultValue, (value) => value >= 0);
  }

  public static string(env: unknown, key: string, defaultValue: string): string {
    return EnvParser.readString(env, key) ?? defaultValue;
  }

  /** `true` only for the exact string, so a typo cannot enable a feature. */
  public static boolean(env: unknown, key: string, defaultValue: string): boolean {
    return (EnvParser.readString(env, key) ?? defaultValue) === 'true';
  }

  /**
   * Parse a configured integer, falling back when it is absent or unusable.
   *
   * `Number` is deliberately not used directly. It accepts more than a
   * configuration value should: `''` and `'  '` become `0` (so an empty variable
   * would read as "reap immediately" rather than "unset"), `'0x10'` becomes `16`,
   * and `'Infinity'` is not a safe integer. Requiring digits before parsing makes
   * the accepted set exactly "a decimal integer, optionally negative".
   */
  private static toInt(value: string | undefined, defaultValue: string, accept: (value: number) => boolean): number {
    if (value === undefined || !/^-?\d+$/.test(value.trim())) return Number(defaultValue);
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed) || !accept(parsed)) return Number(defaultValue);
    return parsed;
  }

  /**
   * Look a variable up, or `undefined` if there is nothing to look it up in.
   *
   * Only the object's own properties are read. A prototype-chain read would let
   * `env.toString` -- or anything an attacker managed to graft onto the
   * prototype -- be returned as a configuration value.
   */
  private static readString(env: unknown, key: string): string | undefined {
    if (typeof env !== 'object' || env === null) return undefined;
    const value = Object.getOwnPropertyDescriptor(env, key)?.value;
    return typeof value === 'string' ? value : undefined;
  }
}

export { EnvParser };
