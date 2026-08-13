import { Context } from 'hono';
import { guardedFetch, NET_DEFAULTS } from '@fxembed/atmosphere/net';
import { mediaPolicyFor, mediaProviderFor } from './allowlist';
import { mediaSigningKey } from './key';
import { verifyMediaToken } from './token';

/**
 * `GET /_/m/:token/:name?`
 *
 * The one endpoint that delivers provider media through the Worker. The URL to fetch lives inside
 * a signed token rather than a query parameter, so there is no caller-supplied `?url=` to abuse;
 * see `src/media/token.ts` for the three gates a token has to pass. The optional trailing `:name`
 * is cosmetic — clients that guess a file type from the path get `video.mp4` instead of a token.
 */

/** `bytes=0-`, `bytes=100-200`, `bytes=-500`. Anything else is dropped rather than forwarded. */
const RANGE_PATTERN = /^bytes=\d{0,15}-\d{0,15}$/;

/**
 * Upstream headers allowed through.
 *
 * An allowlist, not a denylist: a CDN sends plenty we have no business relaying, and `Set-Cookie`
 * in particular would land on our own origin for every viewer of the embed.
 */
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified'
] as const;

const SUCCESS_CACHE = 'public, max-age=3600';

/** Failures are never stored: a transient upstream 403 must not become the answer for an hour. */
const FAILURE_CACHE = 'no-store';

/**
 * CORS, scoped to this route.
 *
 * Media is meant to be pulled cross-origin by embedding clients, which nothing else here is, so
 * these headers are set on the response rather than by a global middleware.
 */
const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range'
};

/** No body and no detail: the reason goes to the log, not to whoever is probing. */
const failure = (status: number): Response =>
  new Response(null, {
    status,
    headers: { 'cache-control': FAILURE_CACHE, ...CORS_HEADERS }
  });

/** Release an upstream body we are not going to use, rather than leaving it pinned open. */
const discard = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    /* Already errored or closed; nothing to release. */
  }
};

export const mediaRequest = async (c: Context) => {
  const env = c.env as { MEDIA_SIGNING_KEY?: string } | undefined;

  /* Fail closed. Without a key we cannot tell a token we minted from one someone wrote, and the
     only other option — serving unverified URLs — is the open proxy this endpoint exists to
     replace. 503 rather than 403 because this is our misconfiguration, not the caller's fault. */
  const keyPromise = mediaSigningKey(env?.MEDIA_SIGNING_KEY);
  if (!keyPromise) {
    console.error('MEDIA_SIGNING_KEY is not set; refusing to serve media');
    return failure(503);
  }

  let key: CryptoKey;
  try {
    key = await keyPromise;
  } catch (error) {
    console.error('MEDIA_SIGNING_KEY could not be imported:', error);
    return failure(503);
  }

  const verified = await verifyMediaToken(c.req.param('token') ?? '', key, mediaPolicyFor);
  if (!verified.ok) {
    /* Logged, never returned: a caller told which gate they failed can use this to map the
       allowlist and the expiry window. */
    console.log(`Rejected media token (${verified.reason})`);
    return failure(403);
  }

  const { payload, url } = verified;
  const provider = mediaProviderFor(payload.p);
  if (!provider) {
    /* Unreachable — verification already resolved a policy for this provider — but the endpoint
       must not fetch on the strength of an assumption. */
    return failure(403);
  }

  if (payload.m === 'r') {
    return new Response(null, {
      status: 302,
      headers: { 'location': url.href, 'cache-control': SUCCESS_CACHE, ...CORS_HEADERS }
    });
  }

  /* Only providers whose CDN refuses embedding clients are streamed. Everything else was minted to
     be fetched directly, and a token asking us to relay it is not something we honour. */
  if (provider.delivery !== 'proxy') {
    console.log(`Refusing to stream ${payload.p} media; it is configured for direct delivery`);
    return failure(403);
  }

  const requestedRange = c.req.header('Range');
  const range = requestedRange && RANGE_PATTERN.test(requestedRange) ? requestedRange : undefined;
  if (requestedRange && !range) {
    console.log('Dropping unrecognised Range header rather than forwarding it');
  }

  const profiles = provider.outboundHeaders?.({ url, credentials: payload.c }) ?? [{}];

  let streamed: Response | null = null;
  let lastStatus = 0;

  try {
    for (const profile of profiles) {
      const headers = range ? { ...profile, Range: range } : { ...profile };
      const attempt = await guardedFetch(
        url.href,
        { headers },
        { hostPolicy: provider.policy, maxBytes: NET_DEFAULTS.maxMediaBytes }
      );

      lastStatus = attempt.status;
      if (attempt.ok || attempt.status === 206) {
        streamed = attempt;
        break;
      }

      await discard(attempt);
      /* A 403 is the CDN objecting to how we asked, which the next header profile may fix. Any
         other status is a real answer and retrying it just wastes a subrequest. */
      if (attempt.status !== 403) {
        break;
      }
    }
  } catch (error) {
    console.error(`Media fetch failed for ${url.hostname}:`, error);
    return failure(502);
  }

  if (!streamed) {
    console.log(`Upstream ${url.hostname} returned ${lastStatus} for media`);
    return failure(502);
  }

  const upstream = streamed;

  /* HTML from a media CDN is a login wall or an error page, never media. Relaying it would embed
     that page as though it were the video, which is how a 403 turns into a silently broken embed. */
  if ((upstream.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
    console.log(`Upstream ${url.hostname} answered with HTML instead of media`);
    await discard(upstream);
    return failure(502);
  }

  const headers = new Headers();
  PASSTHROUGH_HEADERS.forEach(name => {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  });

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', 'inline');
  headers.set('Cache-Control', SUCCESS_CACHE);
  Object.entries(CORS_HEADERS).forEach(([name, value]) => headers.set(name, value));

  /* 206 and its Content-Range are passed through untouched so clients can seek. */
  return new Response(upstream.body, { status: upstream.status, headers });
};

/** Preflight, for the same reason the CORS headers above exist. */
export const mediaOptions = async (_c: Context) =>
  new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' }
  });
