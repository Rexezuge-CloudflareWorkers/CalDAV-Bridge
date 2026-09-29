import { describe, expect, it } from 'vitest';
import { EnvParser } from '@caldav-bridge/backend-runtime/config';

/**
 * Every one of these readers is the only thing standing between a mistyped
 * environment variable and a silently wrong deployment, so the rules are about
 * what happens when the value is absent or unusable -- not just when it is
 * correct.
 */
describe('EnvParser.positiveInt', () => {
  it('reads a valid positive integer', () => {
    expect(EnvParser.positiveInt({ COUNT: '12' }, 'COUNT', '99')).toBe(12);
  });

  it('falls back when the value is absent', () => {
    expect(EnvParser.positiveInt({}, 'COUNT', '99')).toBe(99);
  });

  // A limit of zero would read as "no limit" to a `>=` check, or as "allow
  // none" to a `>` check, so it is never accepted silently.
  it('falls back for zero, a negative number, or anything unparseable', () => {
    for (const value of ['0', '-1', 'not-a-number', '1.5', 'Infinity', 'NaN', '1e3']) {
      expect(EnvParser.positiveInt({ COUNT: value }, 'COUNT', '99')).toBe(99);
    }
  });

  it('falls back rather than reading a value beyond safe integer precision', () => {
    // Beyond 2^53 a number silently loses digits, so a configured limit would
    // not be the limit that was configured.
    expect(EnvParser.positiveInt({ COUNT: '9007199254740993' }, 'COUNT', '99')).toBe(99);
  });
});

describe('EnvParser.nonNegativeInt', () => {
  it('accepts zero, which is meaningful for a retention period', () => {
    // `DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS` defaults to '0': reaping
    // disabled rather than reaping immediately.
    expect(EnvParser.nonNegativeInt({ DAYS: '0' }, 'DAYS', '30')).toBe(0);
  });

  it('still rejects negatives and unparseable values', () => {
    for (const value of ['-1', 'not-a-number', '', '1.5']) {
      expect(EnvParser.nonNegativeInt({ DAYS: value }, 'DAYS', '30')).toBe(30);
    }
  });
});

describe('EnvParser.boolean', () => {
  it('reads exactly "true" as true', () => {
    expect(EnvParser.boolean({ FLAG: 'true' }, 'FLAG', 'false')).toBe(true);
  });

  it('treats anything else as false, including a truthy-looking value', () => {
    // A permissive parse here would enable a feature on a typo, such as
    // `SERVE_SPA_FROM_WORKER=1` silently turning the worker into a web server.
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', '']) {
      expect(EnvParser.boolean({ FLAG: value }, 'FLAG', 'false')).toBe(false);
    }
  });

  it('uses the default when the variable is absent', () => {
    expect(EnvParser.boolean({}, 'FLAG', 'true')).toBe(true);
  });
});

describe('EnvParser.string', () => {
  it('reads a value and falls back when absent or empty', () => {
    expect(EnvParser.string({ KEY: 'value' }, 'KEY', 'fallback')).toBe('value');
    expect(EnvParser.string({ KEY: '' }, 'KEY', 'fallback')).toBe('');
    expect(EnvParser.string({}, 'KEY', 'fallback')).toBe('fallback');
  });
});

describe('EnvParser against a hostile environment', () => {
  /**
   * Reading the prototype chain would let anything grafted onto the environment
   * object -- or a standard property like `toString` -- be returned as a
   * configured value.
   */
  it('ignores inherited properties rather than reading them as configuration', () => {
    const env = Object.create({ COUNT: '5' }) as Record<string, string>;

    expect(EnvParser.positiveInt(env, 'COUNT', '99')).toBe(99);
    expect(EnvParser.boolean(env, 'SERVE_SPA_FROM_WORKER', 'false')).toBe(false);
    expect(EnvParser.string(env, 'toString', 'fallback')).toBe('fallback');
  });

  it('ignores a property that is present but not a string', () => {
    // Wrangler's generated bindings are not all strings, and a value that is
    // not one cannot be meaningfully coerced.
    const env = { COUNT: 5, FLAG: true } as unknown as Record<string, string>;

    expect(EnvParser.positiveInt(env, 'COUNT', '99')).toBe(99);
    expect(EnvParser.boolean(env, 'FLAG', 'false')).toBe(false);
  });

  /**
   * `Number('')` is `0`, so an unset-but-present variable used to read as a
   * deliberate zero. For a retention period that is the opposite of the default:
   * `DB_CLEANUP_CALDAV_CREDENTIAL_RETENTION_DAYS` defaults to `0` meaning
   * "reaping off", and an empty value would instead have meant "reap now".
   */
  it('treats an empty or whitespace-only value as unset', () => {
    for (const value of ['', ' ', '\t']) {
      expect(EnvParser.nonNegativeInt({ DAYS: value }, 'DAYS', '30')).toBe(30);
      expect(EnvParser.positiveInt({ COUNT: value }, 'COUNT', '99')).toBe(99);
    }
  });

  it('does not read a hexadecimal, octal or binary literal as decimal', () => {
    // `Number('0x10')` is 16, so a hex value would have silently configured a
    // limit of sixteen rather than being rejected as malformed.
    for (const value of ['0x10', '0b101', '0o17']) {
      expect(EnvParser.positiveInt({ COUNT: value }, 'COUNT', '99')).toBe(99);
    }
  });

  it('reads a value defined on the object itself', () => {
    expect(EnvParser.positiveInt({ COUNT: '5' }, 'COUNT', '99')).toBe(5);
  });

  it('tolerates a null or undefined environment', () => {
    // The signature says `unknown`, so the runtime value is not guaranteed to
    // be an object at all.
    for (const env of [null, undefined, 'not-an-object', 42]) {
      expect(EnvParser.positiveInt(env, 'COUNT', '99')).toBe(99);
      expect(EnvParser.string(env, 'KEY', 'fallback')).toBe('fallback');
    }
  });
});
