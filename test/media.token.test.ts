import { beforeAll, describe, expect, test } from 'vitest';
import { NetPolicies, type HostPolicy } from '@fxembed/atmosphere/net';
import {
  importMediaSigningKey,
  signMediaToken,
  verifyMediaToken,
  type MediaTokenPayload
} from '../src/media/token';

const SECRET = 'a'.repeat(32);
const NOW = 1_800_000_000;

const policyFor = (provider: string): HostPolicy | null =>
  provider === 'tiktok'
    ? NetPolicies.tiktokMedia
    : provider === 'twitter'
      ? NetPolicies.twitterMedia
      : null;

const payload: MediaTokenPayload = {
  p: 'tiktok',
  u: 'https://v16.tiktokcdn.com/video/abc.mp4',
  m: 's',
  x: NOW + 3600
};

let key: CryptoKey;

beforeAll(async () => {
  key = await importMediaSigningKey(SECRET);
});

describe('media tokens', () => {
  test('a token we minted round-trips', async () => {
    const token = await signMediaToken(payload, key);
    const result = await verifyMediaToken(token, key, policyFor, NOW);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.url.href).toEqual(payload.u);
    expect(result.ok === true && result.payload.m).toEqual('s');
  });

  test('a tampered payload is rejected', async () => {
    /* Swap the URL for one that is still on the allowlist — only the signature stops this. */
    const token = await signMediaToken(payload, key);
    const forged = await signMediaToken(
      { ...payload, u: 'https://v16.tiktokcdn.com/video/other.mp4' },
      await importMediaSigningKey('b'.repeat(32))
    );

    expect(
      (
        await verifyMediaToken(
          forged.split('.')[0] + '.' + token.split('.')[1],
          key,
          policyFor,
          NOW
        )
      ).ok
    ).toBe(false);
  });

  test('a flipped signature byte is rejected', async () => {
    const token = await signMediaToken(payload, key);
    const [body, signature] = token.split('.');
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    const result = await verifyMediaToken(`${body}.${flipped}`, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('bad_signature');
  });

  test('a token signed with a different key is rejected', async () => {
    const otherKey = await importMediaSigningKey('z'.repeat(32));
    const token = await signMediaToken(payload, otherKey);

    const result = await verifyMediaToken(token, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('bad_signature');
  });

  test('an expired token is rejected', async () => {
    const token = await signMediaToken({ ...payload, x: NOW - 1 }, key);

    const result = await verifyMediaToken(token, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('expired');
  });

  test('a valid signature is not authorisation on its own', async () => {
    /* The allowlist is re-checked at request time, so tightening it retroactively invalidates
       tokens already handed out. Here the URL was legitimate for TikTok but the token claims
       Twitter, whose allowlist excludes it. */
    const token = await signMediaToken({ ...payload, p: 'twitter' }, key);

    const result = await verifyMediaToken(token, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('url_not_allowed');
  });

  test('a retired provider cannot be fetched even with a valid signature', async () => {
    const token = await signMediaToken({ ...payload, p: 'myspace' }, key);

    const result = await verifyMediaToken(token, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('unknown_provider');
  });

  test('a signed token pointing at a private address is still rejected', async () => {
    /* Defence in depth: even if minting were ever tricked into signing this, the URL validator
       rejects it at verification time. */
    const token = await signMediaToken({ ...payload, u: 'https://169.254.169.254/' }, key);

    const result = await verifyMediaToken(token, key, policyFor, NOW);
    expect(result.ok === false && result.reason).toEqual('url_not_allowed');
  });

  test.each(['', '.', 'noseparator', 'a.b', '....'])(
    'malformed token %s is rejected',
    async input => {
      const result = await verifyMediaToken(input, key, policyFor, NOW);
      expect(result.ok).toBe(false);
    }
  );

  test('a weak signing key is refused outright', async () => {
    await expect(importMediaSigningKey('tooshort')).rejects.toThrow(/at least 32 bytes/);
  });
});
