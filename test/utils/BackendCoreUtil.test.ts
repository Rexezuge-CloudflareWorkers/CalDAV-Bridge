import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoUtil, TimestampUtil, UUIDUtil } from '@caldav-bridge/shared/utils';
import { decryptData, encryptData } from '@/crypto';
import { BaseUrlUtil, ConfigurationUtil, HttpError, OAuth2StateUtil, errorResponse, jsonResponse, textResponse } from '@/utils';

describe('backend core utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives base URLs from requests and trusted forwarding headers', () => {
    expect(BaseUrlUtil.getBaseUrl(new Request('http://worker.internal/user/me'))).toBe('http://worker.internal');
    expect(
      BaseUrlUtil.getBaseUrl(
        new Request('http://worker.internal/user/me', {
          headers: {
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'caldav.example.test',
          },
        }),
      ),
    ).toBe('https://caldav.example.test');
  });

  it('reads positive integer and SPA-serving configuration safely', () => {
    expect(ConfigurationUtil.getPositiveInteger('12', '7')).toBe(12);
    expect(ConfigurationUtil.getPositiveInteger('0', '7')).toBe(7);
    expect(ConfigurationUtil.getPositiveInteger('-1', '7')).toBe(7);
    expect(ConfigurationUtil.getPositiveInteger('not-a-number', '7')).toBe(7);
    expect(ConfigurationUtil.getPositiveInteger(undefined, '7')).toBe(7);
    expect(ConfigurationUtil.getServeSpaFromWorker({ SERVE_SPA_FROM_WORKER: 'true' })).toBe(true);
    expect(ConfigurationUtil.getServeSpaFromWorker({ SERVE_SPA_FROM_WORKER: 'TRUE' })).toBe(false);
  });

  it('creates JSON, text, and error responses with expected status and headers', async () => {
    const json = jsonResponse({ ok: true }, 201, { 'X-Test': 'yes' });
    expect(json.status).toBe(201);
    expect(json.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(json.headers.get('X-Test')).toBe('yes');
    await expect(json.json()).resolves.toEqual({ ok: true });

    const text = textResponse('plain', 202, { 'X-Test': 'yes' });
    expect(text.status).toBe(202);
    expect(text.headers.get('X-Test')).toBe('yes');
    await expect(text.text()).resolves.toBe('plain');

    const error = errorResponse(new HttpError(429, 'Slow down', { 'Retry-After': '5' }));
    expect(error.status).toBe(429);
    expect(error.headers.get('Retry-After')).toBe('5');
    await expect(error.json()).resolves.toEqual({ error: 'Slow down' });
  });

  it('generates OAuth2 state values, hashes state, and computes RFC 7636 PKCE challenges', async () => {
    expect(OAuth2StateUtil.generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(OAuth2StateUtil.generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await expect(OAuth2StateUtil.getStateHash('state-value')).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(OAuth2StateUtil.getCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('provides shared cryptographic and timestamp helpers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:34:56Z'));

    expect(CryptoUtil.base64UrlEncode(new Uint8Array([251, 255, 238]))).toBe('-__u');
    expect(CryptoUtil.randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(CryptoUtil.sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(TimestampUtil.getCurrentUnixTimestampInSeconds()).toBe(1779366896);
    expect(TimestampUtil.addMinutes(100, 2)).toBe(220);
    expect(TimestampUtil.addDays(100, 2)).toBe(172900);
    expect(UUIDUtil.getRandomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('encrypts and decrypts API secrets with AES-GCM', async () => {
    const encrypted = await encryptData('client-secret', 'master-key');

    expect(encrypted.encrypted).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    await expect(decryptData(encrypted.encrypted, encrypted.iv, 'master-key')).resolves.toBe('client-secret');
    await expect(decryptData(encrypted.encrypted, encrypted.iv, 'wrong-key')).rejects.toThrow();
  });
});
