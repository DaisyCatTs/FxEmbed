import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  cacheClientFamily,
  cacheKeyUrl,
  cacheMiddleware,
  isStorable,
  DEFAULT_CACHE_CONTROL,
  ERROR_CACHE_CONTROL
} from '../src/caches';
import { app as worker } from '../src/worker';
import harness from './helpers/harness';

/**
 * The middleware talks to `caches.default`. Standing an in-memory cache in its place makes the
 * decisions it takes observable: what it stored, under which key, and with what freshness. The real
 * `caches.default` works under the Workers test pool, but it is shared across the whole isolate and
 * its entries cannot be inspected, so it can only ever answer "hit or miss".
 */
class MemoryCache {
  readonly entries = new Map<string, Response>();
  readonly putKeys: string[] = [];
  readonly matchKeys: string[] = [];

  async match(request: Request): Promise<Response | undefined> {
    this.matchKeys.push(request.url);
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putKeys.push(request.url);
    this.entries.set(request.url, response);
  }
}

let cache: MemoryCache;
let pending: Promise<unknown>[];

const executionCtx = {
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
  passThroughOnException: () => undefined
};

/** Let anything the middleware handed to `waitUntil` finish before asserting on the cache. */
const flush = async () => {
  await Promise.all(pending);
  pending = [];
};

beforeEach(() => {
  cache = new MemoryCache();
  pending = [];
  vi.stubGlobal('caches', { default: cache });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A worker whose handler is counted, so a cache hit is visible as the handler *not* running. */
const buildApp = (handler: (c: Context) => Response | Promise<Response>) => {
  const app = new Hono();
  let calls = 0;
  app.use('*', cacheMiddleware());
  app.all('*', c => {
    calls += 1;
    return handler(c);
  });
  return {
    calls: () => calls,
    request: (url: string, init?: RequestInit) =>
      app.request(new Request(url, init), undefined, {}, executionCtx)
  };
};

const echoHandler = (c: Context) =>
  c.html(`<p>${c.req.header('User-Agent') ?? 'none'}</p>`) as Response;

const botHeaders = { 'User-Agent': 'Discordbot/2.0' };
const statusUrl = 'https://fxtwitter.com/user/status/1';

test('a miss runs the handler and stores the response; the next request is a hit', async () => {
  const app = buildApp(echoHandler);

  const miss = await app.request(statusUrl, { headers: botHeaders });
  expect(miss.status).toEqual(200);
  expect(app.calls()).toEqual(1);
  await flush();
  expect(cache.putKeys).toHaveLength(1);

  const hit = await app.request(statusUrl, { headers: botHeaders });
  expect(hit.status).toEqual(200);
  /* The handler did not run a second time: the response came out of the cache. */
  expect(app.calls()).toEqual(1);
  expect(await hit.text()).toEqual('<p>Discordbot/2.0</p>');
});

test('Discordbot is cached rather than bypassed', async () => {
  /* The bypass this replaced (FxEmbed#2025) made the cache a no-op for the one client this
     deployment exists to serve. */
  const app = buildApp(echoHandler);

  await app.request(statusUrl, { headers: botHeaders });
  await flush();

  expect(cache.putKeys).toHaveLength(1);
  expect(cache.putKeys[0]).toContain('__fxcacheclient=discord');
});

test('an embed without its own Cache-Control gets an explicit one', async () => {
  const app = buildApp(echoHandler);

  const response = await app.request(statusUrl, { headers: botHeaders });
  await flush();

  expect(response.headers.get('cache-control')).toEqual(DEFAULT_CACHE_CONTROL);
  expect(cache.entries.get(cache.putKeys[0])?.headers.get('cache-control')).toEqual(
    DEFAULT_CACHE_CONTROL
  );
});

test('an error response is not stored under the freshness a real embed gets', async () => {
  const app = buildApp(c => {
    c.header('cache-control', ERROR_CACHE_CONTROL);
    return c.html('<p>failed to load</p>') as Response;
  });

  const response = await app.request(statusUrl, { headers: botHeaders });
  await flush();

  expect(response.headers.get('cache-control')).toEqual(ERROR_CACHE_CONTROL);
  expect(response.headers.get('cache-control')).not.toEqual(DEFAULT_CACHE_CONTROL);

  /* Stored, but with a lifetime measured in seconds rather than minutes, so a transient upstream
     failure cannot be served to everyone who embeds that link until eviction. */
  const stored = cache.entries.get(cache.putKeys[0]);
  const maxAge = Number(/max-age=(\d+)/.exec(stored?.headers.get('cache-control') ?? '')?.[1]);
  expect(maxAge).toBeGreaterThan(0);
  expect(maxAge).toBeLessThanOrEqual(60);
});

test('a response that forbids storage is not written to the cache', async () => {
  const app = buildApp(c => {
    c.header('cache-control', 'max-age=0, no-cache, no-store, must-revalidate');
    return c.html('<p>never store me</p>') as Response;
  });

  await app.request(statusUrl, { headers: botHeaders });
  await flush();

  expect(cache.putKeys).toEqual([]);
});

test('a response carrying Set-Cookie is not written to the cache', async () => {
  const app = buildApp(c => {
    c.header('set-cookie', 'base_redirect=https://example.com; path=/');
    return c.html('<p>per visitor</p>') as Response;
  });

  await app.request(statusUrl, { headers: botHeaders });
  await flush();

  expect(cache.putKeys).toEqual([]);
});

test('each client family gets its own key, and none of them share one', async () => {
  const app = buildApp(echoHandler);
  const agents = {
    discord: 'Discordbot/2.0',
    telegram: 'TelegramBot (like TwitterBot)',
    multibot: 'matrixpreviewbot/1.0',
    bot: 'facebookexternalhit/1.1',
    human:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36'
  };

  for (const userAgent of Object.values(agents)) {
    await app.request(statusUrl, { headers: { 'User-Agent': userAgent } });
    await flush();
  }

  /* Five requests to one URL, five distinct entries: nothing was shared between families. */
  expect(app.calls()).toEqual(5);
  expect(new Set(cache.putKeys).size).toEqual(5);

  for (const family of Object.keys(agents)) {
    expect(cache.putKeys).toContain(`${statusUrl}?__fxcacheclient=${family}`);
  }
});

test('a bot response is never served to a human, and vice versa', async () => {
  const app = buildApp(echoHandler);

  await app.request(statusUrl, { headers: botHeaders });
  await flush();

  const human = await app.request(statusUrl, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome' } });
  expect(app.calls()).toEqual(2);
  expect(await human.text()).toEqual('<p>Mozilla/5.0 Chrome</p>');
});

test('the cache key is a real query parameter, not something glued onto the path', async () => {
  const withoutQuery = cacheKeyUrl('https://fxtwitter.com/user/status/1', 'telegram');
  expect(withoutQuery.pathname).toEqual('/user/status/1');
  expect(withoutQuery.searchParams.get('__fxcacheclient')).toEqual('telegram');

  const withQuery = cacheKeyUrl('https://fxtwitter.com/user/status/1?lang=ja', 'discord');
  expect(withQuery.pathname).toEqual('/user/status/1');
  expect(withQuery.searchParams.get('lang')).toEqual('ja');
  expect(withQuery.searchParams.get('__fxcacheclient')).toEqual('discord');
});

test('a user agent claiming to be both Telegram and Discord is never cached', async () => {
  expect(cacheClientFamily('TelegramBot (like TwitterBot) Discordbot/2.0')).toBeNull();

  const app = buildApp(echoHandler);
  await app.request(statusUrl, {
    headers: { 'User-Agent': 'TelegramBot (like TwitterBot) Discordbot/2.0' }
  });
  await flush();

  expect(cache.matchKeys).toEqual([]);
  expect(cache.putKeys).toEqual([]);
});

test('requests that skip the read also skip the write', async () => {
  /* Guarding only the read is what the old middleware did: it filled the cache with entries that
     nothing could ever hit, and stored per-visitor `base_redirect` responses under the plain key. */
  const cases: { name: string; url: string; init: RequestInit }[] = [
    {
      name: 'API realm host',
      url: 'https://api.fxtwitter.com/user/status/1',
      init: { headers: botHeaders }
    },
    {
      name: 'Bluesky API realm host',
      url: 'https://api.fxbsky.app/user/status/1',
      init: { headers: botHeaders }
    },
    {
      name: 'Discord activity endpoint',
      url: 'https://fxtwitter.com/api/v1/statuses/abc123',
      init: { headers: botHeaders }
    },
    {
      name: 'custom base redirect cookie',
      url: statusUrl,
      init: { headers: { ...botHeaders, Cookie: 'base_redirect=https://nitter.example' } }
    }
  ];

  for (const { name, url, init } of cases) {
    cache = new MemoryCache();
    pending = [];
    vi.stubGlobal('caches', { default: cache });

    const app = buildApp(echoHandler);
    const response = await app.request(url, init);
    await flush();

    expect(response.status, name).toEqual(200);
    expect(app.calls(), name).toEqual(1);
    expect(cache.matchKeys, name).toEqual([]);
    expect(cache.putKeys, name).toEqual([]);
  }
});

test('development hostnames are left out of the cache entirely', async () => {
  const app = buildApp(echoHandler);

  await app.request('https://fxembed.workers.dev/user/status/1', { headers: botHeaders });
  await app.request('http://localhost:8787/user/status/1', { headers: botHeaders });
  await flush();

  expect(app.calls()).toEqual(2);
  expect(cache.matchKeys).toEqual([]);
  expect(cache.putKeys).toEqual([]);
});

test('isStorable refuses what must not be replayed to another client', () => {
  const html = (init?: ResponseInit) => new Response('<p>hi</p>', init);

  expect(isStorable(html({ headers: { 'cache-control': DEFAULT_CACHE_CONTROL } }))).toBe(true);
  expect(isStorable(html({ headers: { 'cache-control': ERROR_CACHE_CONTROL } }))).toBe(true);
  expect(isStorable(html({ status: 302, headers: { location: '/x' } }))).toBe(true);

  expect(isStorable(html({ headers: { 'cache-control': 'max-age=0' } }))).toBe(false);
  expect(isStorable(html({ headers: { 'cache-control': 'private, max-age=600' } }))).toBe(false);
  expect(isStorable(html({ headers: { 'cache-control': 'no-store' } }))).toBe(false);
  expect(isStorable(html({ status: 500 }))).toBe(false);
  expect(isStorable(html({ headers: { 'set-cookie': 'a=b' } }))).toBe(false);
});

test('the real status embed error page carries the short error freshness', async () => {
  /* End to end, through the actual worker: an upstream lookup with no data behind it produces the
     "failed to load" page, and that page must not inherit an embed's freshness. */
  const response = await worker.request(
    new Request('https://fxtwitter.com/i/status/1900000000000000099', {
      method: 'GET',
      headers: botHeaders
    }),
    undefined,
    harness
  );

  expect(response.headers.get('cache-control')).toEqual(ERROR_CACHE_CONTROL);
});
