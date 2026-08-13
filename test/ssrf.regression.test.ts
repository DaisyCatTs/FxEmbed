import { describe, expect, test } from 'vitest';
import { isShortCode } from '@fxembed/atmosphere/providers/tiktok/conversation';
import { assertSafeMastodonDomain } from '@fxembed/atmosphere/providers/mastodon/client';

/**
 * These pin two specific vulnerabilities found during the audit. Both were reachable from a
 * request path, and both are pure functions, so they can be asserted directly.
 */

describe('TikTok short code validation', () => {
  test('accepts a real short code', () => {
    expect(isShortCode('ZP8yxgATu')).toBe(true);
    expect(isShortCode('ZMhkwCtqT')).toBe(true);
  });

  test('rejects a numeric video id', () => {
    /* A numeric id is a video id, handled by a different path. */
    expect(isShortCode('7234567890123456789')).toBe(false);
  });

  test('does not treat a URL as a short code', () => {
    /* This is the bug: `isShortCode` returned true for any non-numeric string, so a whole URL
       counted as a short code and `resolveShortUrl` then fetched it verbatim. `/t/:id` is a
       request path and Hono percent-decodes path params, so `%2F` was enough to reach this. */
    const attacks = [
      'https://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      'https://localhost/',
      '//evil.example/',
      '/t/ZP8yxgATu/',
      'https://vm.tiktok.com/ZP8yxgATu',
      'file:///etc/passwd'
    ];

    attacks.forEach(attack => expect(isShortCode(attack)).toBe(false));
  });

  test('rejects shapes that are not plain alphanumeric tokens', () => {
    expect(isShortCode('')).toBe(false);
    expect(isShortCode('abc')).toBe(false); // too short
    expect(isShortCode('a'.repeat(33))).toBe(false); // too long
    expect(isShortCode('ZP8yxg-ATu')).toBe(false);
    expect(isShortCode('ZP8yxg.ATu')).toBe(false);
    expect(isShortCode('ZP8yxg/ATu')).toBe(false);
  });
});

describe('Mastodon instance validation', () => {
  test('accepts a real instance', () => {
    expect(assertSafeMastodonDomain('mastodon.social')).toEqual('mastodon.social');
    expect(assertSafeMastodonDomain('  Mastodon.Social  ')).toEqual('mastodon.social');
  });

  test('rejects internal and loopback targets', () => {
    /* The previous guard only rejected slashes, backslashes, `..` and characters outside
       [a-z0-9.-], so every one of these passed and was then fetched. The instance host comes
       straight from the request path, making this the sharpest SSRF edge in the codebase. */
    const attacks = [
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '192.168.1.1',
      '2130706433',
      '0x7f000001',
      'metadata.internal',
      'printer.local',
      'vault',
      'something.home.arpa'
    ];

    attacks.forEach(attack =>
      expect(() => assertSafeMastodonDomain(attack), attack).toThrow('invalid_domain')
    );
  });

  test('rejects junk input', () => {
    expect(() => assertSafeMastodonDomain('')).toThrow('invalid_domain');
    expect(() => assertSafeMastodonDomain('a'.repeat(254))).toThrow('invalid_domain');
    expect(() => assertSafeMastodonDomain('evil.example/../admin')).toThrow('invalid_domain');
    expect(() => assertSafeMastodonDomain('evil.example:8080')).toThrow('invalid_domain');
    expect(() => assertSafeMastodonDomain('user:pass@evil.example')).toThrow('invalid_domain');
  });

  test('normalises a fully-qualified name so it cannot slip past a later host comparison', () => {
    expect(assertSafeMastodonDomain('mastodon.social.')).toEqual('mastodon.social');
  });
});
