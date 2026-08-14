import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ANY_PUBLIC_HOST,
  allowHosts,
  checkUrl,
  guardedFetch,
  isIpLiteral,
  matchesHost,
  NetError,
  NetPolicies,
  resolveRedirectTarget,
  type UrlRejectionReason
} from '@fxembed/atmosphere/net';

const TWITTER_MEDIA = NetPolicies.twitterMedia;

describe('checkUrl', () => {
  const rejected: ReadonlyArray<[string, UrlRejectionReason]> = [
    /* Scheme. `javascript:` and `data:` are valid URLs, so parsing alone proves nothing. */
    ['http://pbs.twimg.com/media/a.jpg', 'scheme_not_https'],
    ['javascript:alert(1)', 'scheme_not_https'],
    ['data:text/html,<script>alert(1)</script>', 'scheme_not_https'],
    ['file:///etc/passwd', 'scheme_not_https'],

    /* Address literals, in every encoding that reaches the same place. */
    ['https://127.0.0.1/', 'ip_literal'],
    ['https://10.0.0.1/', 'ip_literal'],
    ['https://192.168.1.1/', 'ip_literal'],
    ['https://169.254.169.254/latest/meta-data/', 'ip_literal'],
    ['https://[::1]/', 'ip_literal'],
    ['https://[fd00::1]/', 'ip_literal'],
    ['https://2130706433/', 'ip_literal'],
    ['https://0x7f000001/', 'ip_literal'],
    ['https://0177.0.0.1/', 'ip_literal'],

    /* Reserved names. */
    ['https://localhost/', 'reserved_hostname'],
    ['https://api.localhost/', 'reserved_hostname'],
    ['https://metadata.internal/', 'reserved_hostname'],
    ['https://printer.local/', 'reserved_hostname'],
    ['https://something.home.arpa/', 'reserved_hostname'],
    ['https://secret.onion/', 'reserved_hostname'],
    ['https://intranet/', 'reserved_hostname'],

    /* Credentials and ports. */
    ['https://user:pass@pbs.twimg.com/a.jpg', 'embedded_credentials'],
    ['https://pbs.twimg.com:8080/a.jpg', 'port_not_allowed'],
    ['https://pbs.twimg.com:22/a.jpg', 'port_not_allowed'],

    /* Allowlist confusion: the attacker controls everything left of their own domain. */
    ['https://pbs.twimg.com.evil.example/a.jpg', 'host_not_allowed'],
    ['https://evil.example/pbs.twimg.com/a.jpg', 'host_not_allowed'],
    ['https://nottwimg.com/a.jpg', 'host_not_allowed'],

    ['not a url', 'invalid_url']
  ];

  test.each(rejected)('rejects %s', (input, reason) => {
    const result = checkUrl(input, TWITTER_MEDIA);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toEqual(reason);
  });

  const accepted = [
    'https://pbs.twimg.com/media/abc.jpg?name=orig',
    'https://video.twimg.com/tweet_video/abc.mp4',
    'https://pbs.twimg.com:443/media/abc.jpg',
    /* Fully-qualified form with the root label spelled out is the same host. */
    'https://pbs.twimg.com./media/abc.jpg'
  ];

  test.each(accepted)('accepts %s', input => {
    expect(checkUrl(input, TWITTER_MEDIA).ok).toBe(true);
  });

  test('a homograph domain does not match the real one', () => {
    /* Cyrillic "о" in "com". URL punycodes it, so it can never equal the ASCII host. */
    const result = checkUrl('https://pbs.twimg.cоm/a.jpg', TWITTER_MEDIA);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toEqual('host_not_allowed');
  });

  describe('public policy', () => {
    test('allows an arbitrary public instance', () => {
      expect(checkUrl('https://mastodon.social/api/v1/statuses/1', ANY_PUBLIC_HOST).ok).toBe(true);
    });

    test.each([
      'https://127.0.0.1/',
      'https://169.254.169.254/',
      'https://[::1]/',
      'https://localhost/',
      'https://vault.internal/'
    ])('still rejects %s', input => {
      expect(checkUrl(input, ANY_PUBLIC_HOST).ok).toBe(false);
    });
  });
});

describe('provider media policies accept the hosts those providers actually serve from', () => {
  /* Regression: the TikTok media allowlist omitted the apex, so `v16-webapp-prime.tiktok.com` was
     rejected. Minting refused its own video URL, fell back to the raw CDN link, and the video
     stopped embedding entirely — a tightened allowlist silently breaking delivery rather than
     failing loudly. */
  test.each([
    'https://v16-webapp-prime.tiktok.com/video/tos/no1a/abc.mp4',
    'https://v19-webapp-prime.tiktok.com/video/tos/useast/abc.mp4',
    'https://v16.tiktokcdn.com/video/abc.mp4',
    'https://p16-sign.tiktokcdn-us.com/thumb.jpeg'
  ])('tiktokMedia accepts %s', url => {
    expect(checkUrl(url, NetPolicies.tiktokMedia).ok).toBe(true);
  });

  test.each([
    'https://pbs.twimg.com/media/abc.jpg',
    'https://video.twimg.com/tweet_video/abc.mp4'
  ])('twitterMedia accepts %s', url => {
    expect(checkUrl(url, NetPolicies.twitterMedia).ok).toBe(true);
  });

  test('widening for TikTok did not widen anyone else', () => {
    expect(checkUrl('https://v16-webapp-prime.tiktok.com/a.mp4', NetPolicies.twitterMedia).ok).toBe(
      false
    );
    expect(checkUrl('https://evil.example/a.mp4', NetPolicies.tiktokMedia).ok).toBe(false);
    expect(checkUrl('https://tiktok.com.evil.example/a.mp4', NetPolicies.tiktokMedia).ok).toBe(
      false
    );
  });
});

describe('host helpers', () => {
  test('matchesHost is anchored on a dot boundary', () => {
    expect(matchesHost('pbs.twimg.com', 'twimg.com')).toBe(true);
    expect(matchesHost('twimg.com', 'twimg.com')).toBe(true);
    expect(matchesHost('eviltwimg.com', 'twimg.com')).toBe(false);
    expect(matchesHost('twimg.com.evil.example', 'twimg.com')).toBe(false);
  });

  test('isIpLiteral covers alternate encodings', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('2130706433')).toBe(true);
    expect(isIpLiteral('0x7f000001')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('guardedFetch', () => {
  let calls: string[];

  /* `vi.stubGlobal` + `unstubAllGlobals` rather than assigning `globalThis.fetch` directly: this
     suite shares a Workers runtime with every other test file, so a replacement that outlives the
     test would silently break unrelated ones. */
  const install = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        return await handler(url, init);
      })
    );
  };

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a blocked URL is never fetched at all', async () => {
    install(() => new Response('should not happen'));

    await expect(
      guardedFetch('https://169.254.169.254/latest/meta-data/', {}, { hostPolicy: ANY_PUBLIC_HOST })
    ).rejects.toThrow(NetError);

    expect(calls).toEqual([]);
  });

  test('follows a redirect to a permitted host', async () => {
    install(url =>
      url.includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://pbs.twimg.com/end' } })
        : new Response('done')
    );

    const response = await guardedFetch(
      'https://pbs.twimg.com/start',
      {},
      { hostPolicy: TWITTER_MEDIA }
    );

    expect(await response.text()).toEqual('done');
    expect(calls).toEqual(['https://pbs.twimg.com/start', 'https://pbs.twimg.com/end']);
  });

  test('refuses a redirect into a private address', async () => {
    /* The whole point: a permitted host must not be able to bounce us anywhere it likes. */
    install(
      () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } })
    );

    await expect(
      guardedFetch('https://pbs.twimg.com/a.jpg', {}, { hostPolicy: TWITTER_MEDIA })
    ).rejects.toMatchObject({ kind: 'blocked', reason: 'ip_literal' });

    /* Only the first hop was ever requested. */
    expect(calls).toEqual(['https://pbs.twimg.com/a.jpg']);
  });

  test('refuses a redirect off the allowlist', async () => {
    install(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
    );

    await expect(
      guardedFetch('https://pbs.twimg.com/a.jpg', {}, { hostPolicy: TWITTER_MEDIA })
    ).rejects.toMatchObject({ kind: 'blocked', reason: 'host_not_allowed' });
  });

  test('refuses a downgrade to http on redirect', async () => {
    install(
      () => new Response(null, { status: 302, headers: { location: 'http://pbs.twimg.com/' } })
    );

    await expect(
      guardedFetch('https://pbs.twimg.com/a.jpg', {}, { hostPolicy: TWITTER_MEDIA })
    ).rejects.toMatchObject({ kind: 'blocked', reason: 'scheme_not_https' });
  });

  test('gives up on a redirect loop', async () => {
    install(
      () => new Response(null, { status: 302, headers: { location: 'https://pbs.twimg.com/loop' } })
    );

    await expect(
      guardedFetch('https://pbs.twimg.com/loop', {}, { hostPolicy: TWITTER_MEDIA, maxRedirects: 2 })
    ).rejects.toMatchObject({ kind: 'too_many_redirects' });

    expect(calls.length).toEqual(3);
  });

  test('redirect: manual returns the redirect instead of following it', async () => {
    install(
      () => new Response(null, { status: 301, headers: { location: 'https://evil.example/' } })
    );

    const response = await guardedFetch(
      'https://t.co/abc123',
      {},
      { hostPolicy: NetPolicies.twitterShortener, redirect: 'manual' }
    );

    expect(response.status).toEqual(301);
    expect(calls.length).toEqual(1);
  });

  test('an oversized body errors the stream rather than being buffered', async () => {
    install(
      () =>
        new Response(new Uint8Array(4096), {
          /* A lie: the cap must be enforced by counting bytes, not by trusting this. */
          headers: { 'content-length': '1' }
        })
    );

    const response = await guardedFetch(
      'https://pbs.twimg.com/big.jpg',
      {},
      { hostPolicy: TWITTER_MEDIA, maxBytes: 1024 }
    );

    await expect(response.text()).rejects.toThrow(/exceeded 1024 bytes/i);
  });

  test('a body within the cap reads normally', async () => {
    install(() => new Response('small'));

    const response = await guardedFetch(
      'https://pbs.twimg.com/small.jpg',
      {},
      { hostPolicy: TWITTER_MEDIA, maxBytes: 1024 }
    );

    expect(await response.text()).toEqual('small');
  });

  test('preserves the final URL on the response', async () => {
    /* `new Response(...)` reports `url` as ''. Callers depend on it: TikTok parses a video id out
       of it, and Instagram uses it to detect the login wall — a lost url made a login page look
       like a valid post. */
    install(url =>
      url.includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://pbs.twimg.com/final' } })
        : new Response('done')
    );

    const response = await guardedFetch(
      'https://pbs.twimg.com/start',
      {},
      { hostPolicy: TWITTER_MEDIA }
    );

    expect(response.url).toEqual('https://pbs.twimg.com/final');
  });

  test("an abort from the caller's own signal stays an AbortError", async () => {
    /* `withTimeout` retries only on `AbortError`, and the Bluesky client treats an abort as
       grounds for falling back to an authenticated PDS. Rewrapping it as a NetError silently
       disabled both. */
    install(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );

    const caller = new AbortController();
    setTimeout(() => caller.abort(), 10);

    const error = await guardedFetch(
      'https://pbs.twimg.com/slow.jpg',
      {},
      { hostPolicy: TWITTER_MEDIA, timeoutMs: 10_000, signal: caller.signal }
    ).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toEqual('AbortError');
    expect(error).not.toBeInstanceOf(NetError);
  });

  test('the header timeout does not abort a body that is still streaming', async () => {
    /* The timeout budgets response headers, not delivery. A 64 MB video legitimately takes longer
       than any sane header timeout, and aborting mid-stream truncated it. */
    install(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode('chunk1'));
              await new Promise(resolve => setTimeout(resolve, 60));
              controller.enqueue(new TextEncoder().encode('chunk2'));
              controller.close();
            }
          })
        )
    );

    const response = await guardedFetch(
      'https://pbs.twimg.com/video.mp4',
      {},
      { hostPolicy: TWITTER_MEDIA, timeoutMs: 30 }
    );

    /* Body finishes well after the 30ms header budget has elapsed. */
    expect(await response.text()).toEqual('chunk1chunk2');
  });

  test('times out a hanging upstream', async () => {
    install(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );

    await expect(
      guardedFetch(
        'https://pbs.twimg.com/slow.jpg',
        {},
        { hostPolicy: TWITTER_MEDIA, timeoutMs: 25 }
      )
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('resolveRedirectTarget', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const install = (response: Response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
  };

  test('expands a short link to an arbitrary public destination', async () => {
    install(
      new Response(null, { status: 301, headers: { location: 'https://example.com/article' } })
    );

    const target = await resolveRedirectTarget(
      'https://t.co/abc123',
      {},
      { hostPolicy: NetPolicies.twitterShortener, targetPolicy: ANY_PUBLIC_HOST }
    );

    expect(target?.href).toEqual('https://example.com/article');
  });

  test('does not expand to a private destination', async () => {
    install(new Response(null, { status: 301, headers: { location: 'https://127.0.0.1/admin' } }));

    const target = await resolveRedirectTarget(
      'https://t.co/abc123',
      {},
      { hostPolicy: NetPolicies.twitterShortener, targetPolicy: ANY_PUBLIC_HOST }
    );

    expect(target).toBeNull();
  });

  test('returns null when the destination is off a narrow target policy', async () => {
    install(new Response(null, { status: 301, headers: { location: 'https://example.com/x' } }));

    const target = await resolveRedirectTarget(
      'https://t.co/abc123',
      {},
      {
        hostPolicy: NetPolicies.twitterShortener,
        targetPolicy: allowHosts('tiktok.com')
      }
    );

    expect(target).toBeNull();
  });
});
