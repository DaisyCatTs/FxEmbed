import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../src/worker';
import { importMediaSigningKey, signMediaToken, type MediaTokenPayload } from '../src/media/token';
import { mediaSigningKey } from '../src/media/key';
import { mintMediaUrl } from '../src/media/mint';

/**
 * The signed media endpoint.
 *
 * These exercise the gates rather than TikTok itself — there is no live CDN here, so the upstream
 * is a stub. What is actually pinned is that nothing reaches an upstream without a token we minted,
 * and that what comes back is filtered rather than relayed.
 */

const SECRET = 'media-endpoint-test-secret-key-0123456789';
const ENV = { MEDIA_SIGNING_KEY: SECRET };

/* localhost so `cacheMiddleware` sits out: a cached 200 would let a later request skip the fetch
   these tests are counting. */
const HOST = 'https://localhost:8787';

const VIDEO_URL = 'https://v16-webapp.tiktokcdn.com/video/regular.mp4';

let key: CryptoKey;
let calls: { url: string; headers: Record<string, string> }[];

const install = (handler: (url: string) => Response) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return handler(url);
    })
  );
};

const tokenFor = async (overrides: Partial<MediaTokenPayload> = {}, signingKey = key) =>
  await signMediaToken(
    {
      p: 'tiktok',
      u: VIDEO_URL,
      m: 's',
      x: Math.floor(Date.now() / 1000) + 3600,
      ...overrides
    },
    signingKey
  );

const request = async (token: string, init: RequestInit = {}, env: object = ENV) =>
  await app.request(new Request(`${HOST}/_/m/${token}/video.mp4`, init), undefined, env);

beforeAll(async () => {
  key = await importMediaSigningKey(SECRET);
});

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signed media endpoint', () => {
  test('a token we minted streams the media', async () => {
    install(() => new Response('MP4BYTES', { headers: { 'content-type': 'video/mp4' } }));

    const result = await request(await tokenFor());

    expect(result.status).toEqual(200);
    expect(await result.text()).toEqual('MP4BYTES');
    expect(result.headers.get('content-type')).toEqual('video/mp4');
    expect(result.headers.get('x-content-type-options')).toEqual('nosniff');
    expect(result.headers.get('content-disposition')).toEqual('inline');
    expect(result.headers.get('cache-control')).toEqual('public, max-age=3600');
    expect(result.headers.get('access-control-allow-origin')).toEqual('*');
    expect(calls.map(call => call.url)).toEqual([VIDEO_URL]);
  });

  test('the outbound request carries the cookies from the token, not from the URL', async () => {
    install(() => new Response('MP4BYTES', { headers: { 'content-type': 'video/mp4' } }));

    await request(await tokenFor({ c: 'tt_chain_token=abc; ttwid=def' }));

    expect(calls[0].headers['Cookie']).toEqual('tt_chain_token=abc; ttwid=def');
    /* The whole point of the token: none of this is visible in, or settable from, the request URL. */
    expect(calls[0].headers['Referer']).toContain('tiktok.com');
  });

  test('a forged token is refused and nothing is fetched', async () => {
    install(() => new Response('should not happen'));

    const forged = await tokenFor(
      {},
      await importMediaSigningKey('a-completely-different-secret-key')
    );
    const result = await request(forged);

    expect(result.status).toEqual(403);
    expect(result.headers.get('cache-control')).toEqual('no-store');
    expect(calls).toEqual([]);
  });

  test('a token with a mangled signature is refused and nothing is fetched', async () => {
    install(() => new Response('should not happen'));

    const token = await tokenFor();
    const [body, signature] = token.split('.');
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    const result = await request(`${body}.${flipped}`);

    expect(result.status).toEqual(403);
    expect(calls).toEqual([]);
  });

  test('an expired token is refused and nothing is fetched', async () => {
    install(() => new Response('should not happen'));

    const result = await request(await tokenFor({ x: Math.floor(Date.now() / 1000) - 1 }));

    expect(result.status).toEqual(403);
    expect(calls).toEqual([]);
  });

  test('a token whose URL is off the allowlist is refused, signature or not', async () => {
    install(() => new Response('should not happen'));

    /* Signed with the real key, so only the request-time allowlist re-check stops it. */
    const result = await request(await tokenFor({ u: 'https://evil.example/video.mp4' }));

    expect(result.status).toEqual(403);
    expect(calls).toEqual([]);
  });

  test('a token pointing at link-local metadata is refused', async () => {
    install(() => new Response('should not happen'));

    const result = await request(
      await tokenFor({ u: 'https://169.254.169.254/latest/meta-data/' })
    );

    expect(result.status).toEqual(403);
    expect(calls).toEqual([]);
  });

  test('upstream Set-Cookie is never forwarded', async () => {
    install(
      () =>
        new Response('MP4BYTES', {
          headers: {
            'content-type': 'video/mp4',
            'set-cookie': 'sessionid=leaked; Path=/',
            'x-upstream-debug': 'chatty'
          }
        })
    );

    const result = await request(await tokenFor());

    expect(result.status).toEqual(200);
    expect(result.headers.get('set-cookie')).toBeNull();
    /* Allowlist, not denylist: anything unlisted is dropped too. */
    expect(result.headers.get('x-upstream-debug')).toBeNull();
  });

  test('a well-formed Range is forwarded and 206 passes through', async () => {
    install(
      () =>
        new Response('PARTIAL', {
          status: 206,
          headers: {
            'content-type': 'video/mp4',
            'content-range': 'bytes 0-6/1000',
            'accept-ranges': 'bytes'
          }
        })
    );

    const result = await request(await tokenFor(), { headers: { Range: 'bytes=0-6' } });

    expect(calls[0].headers['Range']).toEqual('bytes=0-6');
    expect(result.status).toEqual(206);
    expect(result.headers.get('content-range')).toEqual('bytes 0-6/1000');
    expect(result.headers.get('accept-ranges')).toEqual('bytes');
  });

  test('a malformed Range is dropped rather than forwarded', async () => {
    install(() => new Response('MP4BYTES', { headers: { 'content-type': 'video/mp4' } }));

    const result = await request(await tokenFor(), {
      headers: { Range: 'bytes=0-6, 8-12; injected' }
    });

    expect(result.status).toEqual(200);
    expect(calls[0].headers['Range']).toBeUndefined();
  });

  test('an HTML body is treated as a failure, not as media', async () => {
    /* A media CDN answering with HTML is a login wall or an error page. Relaying it embeds that
       page as though it were the video. */
    install(
      () =>
        new Response('<html>Log in to continue</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
    );

    const result = await request(await tokenFor());

    expect(result.status).toEqual(502);
    expect(result.headers.get('cache-control')).toEqual('no-store');
  });

  test('a 403 from the CDN escalates through the header profiles, then gives up', async () => {
    install(() => new Response('nope', { status: 403 }));

    const result = await request(await tokenFor({ c: 'ttwid=def' }));

    expect(result.status).toEqual(502);
    expect(result.headers.get('cache-control')).toEqual('no-store');
    /* Four profiles: minimal, +Accept-Encoding, +Origin, and one without the cookies. */
    expect(calls.length).toEqual(4);
    expect(calls[3].headers['Cookie']).toBeUndefined();
  });

  test('a non-403 upstream failure is not retried', async () => {
    install(() => new Response('gone', { status: 404 }));

    const result = await request(await tokenFor());

    expect(result.status).toEqual(502);
    expect(calls.length).toEqual(1);
  });

  test('a redirect-mode token 302s instead of streaming', async () => {
    install(() => new Response('should not happen'));

    const result = await request(
      await tokenFor({ m: 'r', p: 'twitter', u: 'https://pbs.twimg.com/media/a.jpg' })
    );

    expect(result.status).toEqual(302);
    expect(result.headers.get('location')).toEqual('https://pbs.twimg.com/media/a.jpg');
    expect(calls).toEqual([]);
  });

  test('a direct-delivery provider is never streamed through us', async () => {
    install(() => new Response('should not happen'));

    /* X's CDN serves embedding clients fine; relaying it would only cost us latency and egress. */
    const result = await request(
      await tokenFor({ p: 'twitter', u: 'https://pbs.twimg.com/media/a.jpg', m: 's' })
    );

    expect(result.status).toEqual(403);
    expect(calls).toEqual([]);
  });

  test('a link minted by the provider processor is one this endpoint serves', async () => {
    /* The half that cannot be exercised against a live TikTok: what the processor puts in an embed
       has to be exactly what the endpoint accepts back. */
    install(() => new Response('MP4BYTES', { headers: { 'content-type': 'video/mp4' } }));
    mediaSigningKey(SECRET);

    const minted = await mintMediaUrl({
      provider: 'tiktok',
      url: VIDEO_URL,
      base: HOST,
      /* Includes a cookie TikTok's CDN does not use, which minting drops. */
      credentials: 'tt_chain_token=abc; sessionid=private; ttwid=def',
      name: 'video.mp4'
    });

    expect(minted).toMatch(new RegExp(`^${HOST}/_/m/[\\w.-]+/video\\.mp4$`));
    /* The URL and the cookies are no longer readable from, or writable in, the link itself. */
    expect(minted).not.toContain('tiktokcdn');
    expect(minted).not.toContain('sessionid');

    const result = await app.request(new Request(minted!), undefined, ENV);

    expect(result.status).toEqual(200);
    expect(calls[0].url).toEqual(VIDEO_URL);
    expect(calls[0].headers['Cookie']).toEqual('tt_chain_token=abc; ttwid=def');
  });

  test('minting refuses a URL the endpoint would refuse to fetch', async () => {
    mediaSigningKey(SECRET);

    expect(
      await mintMediaUrl({ provider: 'tiktok', url: 'https://evil.example/a.mp4', base: HOST })
    ).toBeNull();
    /* X media is minted as null so the caller keeps the CDN URL and Discord fetches it directly. */
    expect(
      await mintMediaUrl({
        provider: 'twitter',
        url: 'https://pbs.twimg.com/media/a.jpg',
        base: HOST
      })
    ).toBeNull();
  });

  test('with no signing key configured the endpoint fails closed', async () => {
    install(() => new Response('should not happen'));

    const result = await app.request(
      new Request(`${HOST}/_/m/${await tokenFor()}/video.mp4`),
      undefined,
      {}
    );

    expect(result.status).toEqual(503);
    expect(result.headers.get('cache-control')).toEqual('no-store');
    expect(calls).toEqual([]);
  });
});
