import { Env, Hono } from 'hono';
import { timing } from 'hono/timing';
import { sentry } from '@hono/sentry';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { rewriteFramesIntegration } from 'toucan-js';

import { interpolate, Strings } from './strings';
import { Constants } from './constants';
import {
  setBlueskyProviderEnv,
  setBlueskyProxyRuntime
} from '@fxembed/atmosphere/providers/bluesky-runtime';
import { setMastodonProviderEnv } from '@fxembed/atmosphere/providers/mastodon-runtime';
import {
  setTwitterProviderEnv,
  setTwitterProxyRuntime
} from '@fxembed/atmosphere/providers/twitter-runtime';
import * as proxyCreds from './providers/twitter/proxy/credentials';

setBlueskyProviderEnv({
  apiRoot: Constants.BLUESKY_API_ROOT,
  webRoot: Constants.BLUESKY_ROOT,
  videoBase: Constants.BLUESKY_VIDEO_BASE,
  mosaicBskyDomainList: Constants.MOSAIC_BSKY_DOMAIN_LIST,
  polyglotDomainList: Constants.POLYGLOT_DOMAIN_LIST
});

setBlueskyProxyRuntime({
  initCredentials: proxyCreds.initCredentials,
  hasBundledEncryptedCredentials: proxyCreds.hasBundledEncryptedCredentials,
  hasBlueskyProxyAccounts: proxyCreds.hasBlueskyProxyAccounts,
  getShuffledBlueskyAccounts: proxyCreds.getShuffledBlueskyAccounts,
  blueskyProxyServiceHostname: proxyCreds.blueskyProxyServiceHostname
});

setMastodonProviderEnv({
  userAgent: Constants.FRIENDLY_USER_AGENT,
  mosaicDomainList: Constants.MOSAIC_DOMAIN_LIST,
  polyglotDomainList: Constants.POLYGLOT_DOMAIN_LIST
});

setTwitterProviderEnv({
  apiRoot: Constants.TWITTER_API_ROOT,
  webRoot: Constants.TWITTER_ROOT,
  friendlyUserAgent: Constants.FRIENDLY_USER_AGENT,
  guestBearerToken: Constants.GUEST_BEARER_TOKEN,
  baseHeaders: Constants.BASE_HEADERS,
  guestTokenMaxAge: Constants.GUEST_TOKEN_MAX_AGE,
  mosaicDomainList: Constants.MOSAIC_DOMAIN_LIST,
  mosaicBskyDomainList: Constants.MOSAIC_BSKY_DOMAIN_LIST,
  polyglotDomainList: Constants.POLYGLOT_DOMAIN_LIST,
  apiHostList: Constants.API_HOST_LIST,
  videoBase: Constants.TWITTER_VIDEO_BASE,
  gifTranscodeDomainList: Constants.GIF_TRANSCODE_DOMAIN_LIST,
  oldEmbedDomains: Constants.OLD_EMBED_DOMAINS,
  blueskyApiHostList: Constants.BLUESKY_API_HOST_LIST
});

setTwitterProxyRuntime({
  initCredentials: proxyCreds.initCredentials,
  hasBundledEncryptedCredentials: proxyCreds.hasBundledEncryptedCredentials,
  hasDecryptedCredentials: proxyCreds.hasDecryptedCredentials,
  getRandomTwitterAccount: proxyCreds.getRandomTwitterAccount
});
import { api } from './realms/api/router';
import { twitter } from './realms/twitter/router';
import { cacheMiddleware } from './caches';
import { bluesky } from './realms/bluesky/router';
import { blueskyApi } from './realms/bluesky-api/router';
import { atmosphere } from './realms/atmosphere/router';
import { getBranding } from './helpers/branding';
import { tiktok } from './realms/tiktok/router';
import { instagram } from './realms/instagram/router';
import { mastodon } from './realms/mastodon/router';
import { threads } from './realms/threads/router';
import { identifyRealm } from './routing/identify';
import { createRequestLogger, redactUrl, type RequestLogger } from './observability';
import { mediaOptions, mediaRequest } from './media/endpoint';
import { mediaSigningKey } from './media/key';
import { mintMediaUrl } from './media/mint';
import { setMediaLinkRuntime } from '@fxembed/atmosphere/providers/media-runtime';

setMediaLinkRuntime({ mint: mintMediaUrl });

const noCache = 'max-age=0, no-cache, no-store, must-revalidate';
const embeddingClientRegex =
  /(discordbot|telegrambot|facebook|whatsapp|firefox\/92|vkshare|revoltchat|preview|iframely)/gi;

/* This is the root app which contains route trees for multiple "realms".

   We use the term "realms" rather than domains because of the way FxEmbed is structured.
   fxtwitter.com and fixupx.com both contain the exact same content, but api.fxtwitter.com does not*, despite technically
   being the same domain as fxtwitter.com. Similarly, d.fxtwitter.com and other subdomain flags, etc. 
   And of course, fxbsky.app runs on the separate FxBluesky realm.
   This allows us to connect a single FxEmbed worker to tons of domains and still route them to the correct content.
   

   * Under the old system with itty-router, this was not the case, but it is since adopting Hono. This will be necessary for FxTwitter API v2. */
export const app = new Hono<{
  Variables: { log: RequestLogger };
  Bindings: {
    /** Optional: tests use a Fetcher mock; production uses in-process proxy + CREDENTIAL_KEY. */
    TwitterProxy?: Fetcher;
    CREDENTIAL_KEY?: string;
    /** HMAC secret for signed media links. A Wrangler secret — never `.env`, which is inlined. */
    MEDIA_SIGNING_KEY?: string;
    EXCEPTION_DISCORD_WEBHOOK?: string;
    AnalyticsEngine: AnalyticsEngineDataset;
  };
}>({
  getPath: req => {
    let url: URL;

    try {
      url = new URL(req.url);
    } catch (_e) {
      return '/error';
    }

    /* Operators who route a dedicated hostname to the JSON APIs keep that behaviour. These lists
       are empty by default, in which case the APIs are reached by path prefix like everything
       else. Matched on the full hostname, not a suffix. */
    if (Constants.API_HOST_LIST.includes(url.hostname)) {
      return `/api${url.pathname}`;
    }
    if (Constants.BLUESKY_API_HOST_LIST.includes(url.hostname)) {
      return `/blueskyapi${url.pathname}`;
    }
    if (Constants.ATMOSPHERE_API_HOST_LIST.includes(url.hostname)) {
      return `/atmosphere${url.pathname}`;
    }

    /* Otherwise the URL shape decides. See src/routing/identify.ts for why hostname-based realms
       cannot work on a single-domain deployment. */
    const { realm, path } = identifyRealm(url);
    console.log(`${realm} realm: /${realm}${path}`);
    return `/${realm}${path}`;
  }
});

if (process.env.SENTRY_DSN) {
  app.use(
    '*',
    sentry({
      dsn: process.env.SENTRY_DSN,
      requestDataOptions: {
        allowedHeaders: /(.*)/,
        allowedSearchParams: /(.*)/
      },

      integrations: [rewriteFramesIntegration({ root: '/' })],
      release: Constants.RELEASE_NAME
    })
  );
}

app.use('*', async (c, next) => {
  /* Import the media signing key once per isolate. Minting happens inside the provider processors,
     which never see the Worker env, so the pipeline primes it here on the way in. */
  mediaSigningKey(c.env?.MEDIA_SIGNING_KEY);
  await next();
});

app.use('*', async (c, next) => {
  /* Apply all headers from Constants.RESPONSE_HEADERS */
  for (const [header, value] of Object.entries(Constants.RESPONSE_HEADERS)) {
    c.header(header, value);
  }
  await next();
});

app.onError((err, c) => {
  c.get('sentry')?.captureException?.(err);
  console.error(err.stack);
  let errorCode = 500;
  if (err.name === 'AbortError') {
    errorCode = 504;
  }
  /* We return it as a 200 so embedded applications can display the error */
  if (c.req.header('User-Agent')?.match(embeddingClientRegex)) {
    errorCode = 200;
  }
  c.header('cache-control', noCache);

  const branding = getBranding(c);

  return c.html(
    interpolate(Strings.ERROR_HTML, { brandingName: branding.name }),
    errorCode as ContentfulStatusCode
  );
});

/**
 * One structured summary line per request.
 *
 * This replaces a block of prose logging — colo banners, emoji, the client IP and full user agent
 * on every request — which read well live in `wrangler tail` and was unusable afterwards. With no
 * Sentry DSN and no exception webhook configured, these logs are the only account of what
 * production actually did, so they are emitted as single-line JSON that Logpush and
 * `wrangler tail --format json` can filter on.
 *
 * The client IP and raw user agent are deliberately not logged: they identify visitors, they were
 * never used to debug anything, and an embed service has no reason to retain them. The client
 * *family* (discord/telegram/bot/human) is kept, which is the part that ever mattered.
 */
app.use('*', async (c, next) => {
  const log = createRequestLogger(c.req.raw);
  c.set('log', log);

  /* Correlate a user-reported broken embed with its log line. */
  c.header('x-request-id', log.rid);

  const cf = c.req.raw.cf;
  log.set({
    colo: typeof cf?.colo === 'string' ? cf.colo : undefined,
    country: typeof cf?.country === 'string' ? cf.country : undefined
  });

  try {
    await next();
    log.finish({
      status: c.res?.status,
      outcome: (c.res?.status ?? 500) < 400 ? 'ok' : 'upstream_error',
      path: redactUrl(c.req.url)
    });
  } catch (error) {
    /* Re-thrown so app.onError still renders the error page; this only records it. */
    log.error('unhandled', {
      outcome: 'error',
      path: redactUrl(c.req.url),
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
});

app.use('*', cacheMiddleware());
app.use('*', timing({ enabled: false }));

app.route(`/api`, api);
app.route(`/blueskyapi`, blueskyApi);
app.route(`/atmosphere`, atmosphere);
app.route(`/twitter`, twitter);
app.route(`/bluesky`, bluesky);
app.route(`/tiktok`, tiktok);
app.route(`/instagram`, instagram);
app.route(`/mastodon`, mastodon);
app.route(`/threads`, threads);

/* Signed media, reached as /_/m/:token/:name — see src/routing/identify.ts for the rewrite. */
app.get(`/media/:token`, mediaRequest);
app.get(`/media/:token/:name`, mediaRequest);
app.options(`/media/:token`, mediaOptions);
app.options(`/media/:token/:name`, mediaOptions);

app.all('/error', async c => {
  c.header('cache-control', noCache);

  /* We return it as a 200 so embedded applications can display the error */
  if (c.req.header('User-Agent')?.match(embeddingClientRegex)) {
    const branding = getBranding(c);
    return c.html(interpolate(Strings.ERROR_HTML, { brandingName: branding.name }), 200);
  }
  return c.body('', 400);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    try {
      return await app.fetch(request, env, ctx);
    } catch (err) {
      console.error(err);
      const e = err as Error;
      console.log(`Ouch, that error hurt so much Sentry couldn't catch it`);
      console.log(e.stack);
      let errorCode = 500;
      if (e.name === 'AbortError') {
        errorCode = 504;
      }
      /* We return it as a 200 so embedded applications can display the error */
      if (request.headers.get('user-agent')?.match(embeddingClientRegex)) {
        errorCode = 200;
      }
      const branding = getBranding(request);

      return new Response(
        e.name === 'AbortError'
          ? interpolate(Strings.TIMEOUT_ERROR_HTML, { brandingName: branding.name })
          : interpolate(Strings.ERROR_HTML, { brandingName: branding.name }),
        {
          headers: {
            ...Constants.RESPONSE_HEADERS,
            'content-type': 'text/html;charset=utf-8',
            'cache-control': noCache
          },
          status: errorCode
        }
      );
    }
  }
};
