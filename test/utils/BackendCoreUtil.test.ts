import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, DatabaseError } from '@rexezuge/errors';
import { ConfigurationManager } from '@caldav-bridge/backend-runtime/config';
import { errorResponse, jsonResponse, textResponse } from '@caldav-bridge/backend-runtime/http';
import { RetryAfterError } from '@caldav-bridge/shared';
import { decryptSecret, encryptSecret } from '@rexezuge/d1';
import {
  CryptoUtil,
  generateCodeVerifier,
  generateState,
  getCodeChallenge,
  getStateHash,
  TimestampUtil,
  UUIDUtil,
} from '@rexezuge/shared';
import { BaseUrlUtil } from '@caldav-bridge/shared';

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
    expect(ConfigurationManager.limits.getMaxApplicationsPerUser({ MAX_APPLICATIONS_PER_USER: '12' })).toBe(12);
    expect(ConfigurationManager.limits.getMaxApplicationsPerUser({ MAX_APPLICATIONS_PER_USER: '0' })).toBe(99);
    expect(ConfigurationManager.limits.getMaxApplicationsPerUser({ MAX_APPLICATIONS_PER_USER: '-1' })).toBe(99);
    expect(ConfigurationManager.limits.getMaxApplicationsPerUser({ MAX_APPLICATIONS_PER_USER: 'not-a-number' })).toBe(99);
    expect(ConfigurationManager.limits.getMaxApplicationsPerUser({})).toBe(99);
    expect(ConfigurationManager.getServeSpaFromWorker({ SERVE_SPA_FROM_WORKER: 'true' })).toBe(true);
    expect(ConfigurationManager.getServeSpaFromWorker({ SERVE_SPA_FROM_WORKER: 'TRUE' })).toBe(false);
    expect(ConfigurationManager.oauth2.getStateExpiryMinutes({})).toBe(15);
    expect(ConfigurationManager.caldav.getMaxCredentialsPerApplication({})).toBe(5);
    expect(ConfigurationManager.caldav.getDefaultCredentialExpiryDays({})).toBe(365);
    expect(ConfigurationManager.cleanup.getBatchSize({})).toBe(100);
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

    const clientError = errorResponse(new BadRequestError('Slow down'));
    expect(clientError.status).toBe(400);
    await expect(clientError.json()).resolves.toEqual({ error: 'Slow down' });

    const throttledResponse = errorResponse(new RetryAfterError('Slow down', 5));
    expect(throttledResponse.status).toBe(503);
    expect(throttledResponse.headers.get('Retry-After')).toBe('5');
    // 5xx bodies are fixed regardless of the error's own message: a throttling
    // hint from an upstream provider is not something to hand to a caller, and
    // neither is any other internal detail.
    await expect(throttledResponse.json()).resolves.toEqual({ error: 'The server encountered an internal error.' });
  });

  it('does not leak internal error detail in a 500 response body', async () => {
    const response = errorResponse(
      new DatabaseError('Failed to count applications: D1_ERROR: UNIQUE constraint failed: caldav_credentials.password_hash', false),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'The server encountered an internal error.' });
  });

  it('still returns the error message for a 4xx response', async () => {
    const response = errorResponse(new BadRequestError('applicationId is required.'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'applicationId is required.' });
  });

  it('generates OAuth2 state values, hashes state, and computes RFC 7636 PKCE challenges', async () => {
    // The kit's `@rexezuge/shared` OAuth2 PKCE helpers, which the authorization
    // service uses directly — there is no repo-local copy of these.
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await expect(getStateHash('state-value')).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(getCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('provides shared cryptographic and timestamp helpers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T12:34:56Z'));

    expect(CryptoUtil.base64UrlEncode('bytes-value')).toBe('Ynl0ZXMtdmFsdWU');
    expect(CryptoUtil.toBase64Url(new Uint8Array([251, 255, 238]))).toBe('-__u');
    expect(CryptoUtil.randomBase64Url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await expect(CryptoUtil.sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(TimestampUtil.getCurrentUnixTimestampInSeconds()).toBe(1779366896);
    expect(TimestampUtil.addMinutes(100, 2)).toBe(220);
    expect(TimestampUtil.addDays(100, 2)).toBe(172900);
    expect(UUIDUtil.getRandomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('encrypts and decrypts API secrets with AES-GCM', async () => {
    // The kit's aes-gcm contract: base64 of exactly 32 bytes.
  const MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
  const encrypted = await encryptSecret('client-secret', MASTER_KEY);

    expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encrypted.iv).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    await expect(decryptSecret({ ciphertext: encrypted.ciphertext, iv: encrypted.iv }, MASTER_KEY)).resolves.toBe('client-secret');
    await expect(decryptSecret({ ciphertext: encrypted.ciphertext, iv: encrypted.iv }, 'AAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')).rejects.toThrow();
  });
});
