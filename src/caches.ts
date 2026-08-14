import { MiddlewareHandler } from 'hono';
import { Constants } from './constants';

/**
 * Query parameter used to scope a cache entry to the family of client it was built for.
 *
 * The cache key is a synthetic `Request` that is only ever handed to `cache.match`/`cache.put`; it
 * is never dispatched anywhere, so this parameter lives purely inside the edge cache and no handler
 * or upstream ever sees it. The previous implementation appended `&telegram` to the raw URL string,
 * which lands in the *path* when the URL has no query string (`/user/status/1&telegram`). That did
 * produce a distinct key, but not an honest one.
 */
const CACHE_CLIENT_PARAM = '__fxcacheclient';

/**
 * Families of client whose responses differ enough that they must not share a cache entry.
 *
 * `telegram` and `discord` each get platform-specific markup; `multibot` is the other clients that
 * render several images natively; `bot` is every other crawler, all of which get the same generic
 * embed; `human` is a non-crawler, which gets a redirect rather than an embed. Under the old code
 * `human` was the one bucket with no suffix at all, which made it both invisible and the bucket a
 * key would silently fall into if a suffix were ever dropped.
 */
type CacheClientFamily = 'telegram' | 'discord' | 'multibot' | 'bot' | 'human';

/** Freshness handed to cacheable responses that do not state their own. */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=300';

/**
 * Freshness for pages that report a failure: an upstream outage, a private or deleted post, a
 * tombstone. Without it those inherit the success TTL, so a single transient upstream blip gets
 * stored at the edge and served to everyone who embeds that link until eviction. Short enough that
 * a retry a moment later gets the real post, long enough to blunt a stampede on a failing upstream.
 */
export const ERROR_CACHE_CONTROL = 'public, max-age=30';

/** Statuses worth storing. Anything else is either an error or not a complete response. */
const STORABLE_STATUSES = new Set([200, 301, 302, 307, 308]);

const NO_STORE_REGEX = /(?:^|[\s,])(?:no-store|private)(?:$|[\s,;])/;
const MAX_AGE_REGEX = /(?:^|[\s,])(?:s-maxage|max-age)\s*=\s*"?(\d+)/;

/**
 * Which cache bucket a user agent belongs in, or `null` if its response must not be shared.
 */
export const cacheClientFamily = (userAgent: string): CacheClientFamily | null => {
  const isTelegram = userAgent.includes('TelegramBot');
  const isDiscord = userAgent.includes('Discordbot');

  /* A response built for a client claiming to be both carries the quirks of both platforms and is
     right for neither on its own, so it is not something to hand to anyone else later. */
  if (isTelegram && isDiscord) {
    return null;
  }
  if (isTelegram) {
    return 'telegram';
  }
  if (isDiscord) {
    return 'discord';
  }
  /* `match`, not `test`: both of these regexes are global and shared via `Constants`, and `test`
     would carry `lastIndex` from one request into the next. */
  if (userAgent.match(Constants.NATIVE_MULTI_IMAGE_UA_REGEX)) {
    return 'multibot';
  }
  if (userAgent.match(Constants.BOT_UA_REGEX)) {
    return 'bot';
  }
  return 'human';
};

/** The URL a response for `family` is stored under. */
export const cacheKeyUrl = (url: string, family: CacheClientFamily): URL => {
  const cacheUrl = new URL(url);
  cacheUrl.searchParams.set(CACHE_CLIENT_PARAM, family);
  return cacheUrl;
};

/**
 * Whether a response is one we are willing to replay to a later, different client.
 *
 * Cloudflare applies most of these rules itself, but doing it here means the decision is visible,
 * testable, and identical wherever the middleware runs.
 */
export const isStorable = (response: Response): boolean => {
  /* Set-Cookie is per-client state; storing it would hand one visitor's cookie to the next. */
  if (response.headers.has('set-cookie')) {
    return false;
  }
  if (!STORABLE_STATUSES.has(response.status)) {
    return false;
  }
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  if (NO_STORE_REGEX.test(cacheControl)) {
    return false;
  }
  /* Handlers use `max-age=0` to mean "this one is request-specific" (custom base redirects, the
     Horizon test path). Honour that rather than storing it under the plain key. */
  const maxAge = MAX_AGE_REGEX.exec(cacheControl);
  if (maxAge && Number(maxAge[1]) === 0) {
    return false;
  }
  return true;
};

/* Wrapper to handle caching */
export const cacheMiddleware = (): MiddlewareHandler => async (c, next) => {
  const request = c.req;
  const userAgent = request.header('User-Agent') ?? '';
  // https://developers.cloudflare.com/workers/examples/cache-api/
  const requestUrl = new URL(request.url);

  /* The Discordbot bypass that used to live here (FxEmbed#2025) is gone. That issue was custom
     branding leaking between requests: `getBranding` mutated the shared, module-level branding
     object when a request carried `?brandingName` and friends, so one crafted request rebranded
     every later response the isolate served, and the edge then stored the mis-branded HTML. This
     fork has no query-parameter branding override at all, and `src/helpers/branding.ts` resolves
     branding from the hostname alone against frozen zones, so nothing request-scoped can leak into
     another request's response. The hostname is part of the cache key, so branding is too. */
  const clientFamily = cacheClientFamily(userAgent);

  if (clientFamily === null) {
    console.log('User agent includes both Telegram and Discord, skipping cache');
    return await next();
  }

  const cacheUrl = cacheKeyUrl(request.url, clientFamily);

  // Ignore caching on workers.dev, localhost, and 127.0.0.1
  if (
    requestUrl.hostname.includes('workers.dev') ||
    requestUrl.hostname.includes('localhost') ||
    requestUrl.hostname.includes('127.0.0.1')
  ) {
    return await next();
  }

  let cacheKey: Request;

  /* Requests we neither read from nor write to the cache. Reads and writes have to agree: guarding
     only the read (as this used to) still filled the cache with entries nothing could ever hit, and
     stored `base_redirect` responses under the key everyone else reads.

     - `/api/v1/statuses` is the Discord activity endpoint, which carries live poll results.
     - A `base_redirect` cookie makes the response specific to the visitor who set it. */
  const skipCache =
    requestUrl.pathname.startsWith('/api/v1/statuses') ||
    (request.header('Cookie')?.includes('base_redirect') ?? false);

  /* If caching unavailable, ignore the rest of the cache middleware */
  if (typeof caches === 'undefined') {
    return await next();
  }

  try {
    cacheKey = new Request(cacheUrl.toString(), request);
  } catch (_e) {
    /* In Miniflare, you can't really create requests like this, so we ignore caching in the test environment */
    return await next();
  }

  const cache = caches.default;

  switch (request.method) {
    case 'GET':
      if (skipCache) {
        return await next();
      }

      /* cache may be undefined in tests */
      // eslint-disable-next-line no-case-declarations
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        console.log('Cache hit');
        return new Response(cachedResponse.body, cachedResponse as ResponseInit);
      }

      console.log('Cache miss');

      await next();

      /* Embeds shipped without any `Cache-Control`, which left their lifetime at the edge to
         heuristics. State it instead; handlers that care (errors, polls, per-visitor redirects)
         have already set their own by this point and are left alone. */
      if (!c.res.headers.has('cache-control')) {
        c.header('cache-control', DEFAULT_CACHE_CONTROL);
      }

      // eslint-disable-next-line no-case-declarations
      const response = c.res.clone();

      /* Store the fetched response as cacheKey
         Use waitUntil so you can return the response without blocking on
         writing to cache */
      try {
        if (c.executionCtx && isStorable(response)) {
          c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
        }
      } catch (error) {
        console.error((error as Error).stack);
      }

      return response;
    /* PURGE and DELETE used to evict any cache entry, with no authentication of any kind: anyone
       could clear the cache for any URL, repeatedly, and force us back to the upstream API. Cache
       invalidation belongs to the Cloudflare API, which is authenticated; there is no reason to
       expose it as an unauthenticated HTTP verb. */
    /* yes, we do give HEAD */
    case 'HEAD':
      return c.html('');
    /* We properly state our OPTIONS when asked */
    case 'OPTIONS':
      console.log('OPTIONS!!!');
      c.header('Allow', Constants.RESPONSE_HEADERS.allow);
      c.header('Access-Control-Allow-Origin', '*');
      c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      c.header('Access-Control-Allow-Headers', '*');
      c.status(200);
      return c.body('');
    default:
      return c.html('', 405);
  }
};
