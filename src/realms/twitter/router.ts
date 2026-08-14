import { Context, Hono } from 'hono';
import { ANY_PUBLIC_HOST, guardedFetch } from '@fxembed/atmosphere/net';
// import { cache } from "hono/cache";
import { versionRoute } from '../common/version';
import { logoRoute } from './routes/logo';
import { Strings } from '../../strings';
import { Constants } from '../../constants';
import { genericTwitterRedirect, setRedirectRequest } from './routes/redirects';
import { profileRequest } from './routes/profile';
import { statusRequest } from './routes/status';
import { oembed } from './routes/oembed';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { activityRequest } from './routes/activity';
import { getBranding } from '../../helpers/branding';

export const twitter = new Hono();

/** `?horizon` (empty,1, true, yes, or any value except 0/false/no) uses Horizon web instead of x.com / bsky.app */
export const isHorizonEmbedParam = (url: URL): boolean => {
  if (!url.searchParams.has('horizon')) return false;
  const v = (url.searchParams.get('horizon') ?? '').toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
};

export const getBaseRedirectUrl = (c: Context) => {
  const baseRedirect = c.req.header('cookie')?.match(/(?<=base_redirect=)(.*?)(?=;|$)/)?.[0];

  if (baseRedirect) {
    console.log('Found base redirect', baseRedirect);
    try {
      new URL(baseRedirect);
    } catch (_e) {
      return Constants.TWITTER_ROOT;
    }
    return baseRedirect.endsWith('/') ? baseRedirect.slice(0, -1) : baseRedirect;
  }

  return Constants.TWITTER_ROOT;
};

/** An icon. Anything appreciably larger is not one, and we should not be relaying it. */
const MAX_FAVICON_BYTES = 1024 * 1024;

export const faviconRoute = async (c: Context) => {
  const branding = getBranding(c);
  try {
    /* The favicon URL comes from branding config rather than the request, but it is still a
       remote fetch whose body we hand straight to the client, so it goes through the guard for
       the timeout and size ceiling. Streamed rather than buffered into memory first. */
    const response = await guardedFetch(
      branding.favicon,
      {},
      {
        hostPolicy: ANY_PUBLIC_HOST,
        maxBytes: MAX_FAVICON_BYTES,
        timeoutMs: 3_000
      }
    );

    if (!response.body) {
      return c.redirect(branding.favicon, 302);
    }

    return c.body(response.body, response.status as ContentfulStatusCode, {
      'Content-Type': response.headers.get('Content-Type') || 'image/x-icon'
    });
  } catch (_e) {
    return c.redirect(branding.favicon, 302);
  }
};

/* Workaround for some dumb maybe-build time issue where statusRequest isn't ready or something because none of these trigger*/
const twitterStatusRequest = async (c: Context) => await statusRequest(c);
const _profileRequest = async (c: Context) => await profileRequest(c);

twitter.use(trimTrailingSlash());
twitter.get('/api/v1/statuses/:id', activityRequest);
twitter.get('/:endpoint{status(es)?|article}/:id', twitterStatusRequest);
twitter.get('/:endpoint{status(es)?|article}/:id/:language', twitterStatusRequest);
twitter.get('/i/web/:endpoint{status(es)?|article}/:id', twitterStatusRequest);
twitter.get('/i/web/:endpoint{status(es)?|article}/:id/:language', twitterStatusRequest);
twitter.get(
  '/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:language',
  twitterStatusRequest
);
twitter.get('/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id', twitterStatusRequest);
twitter.get(
  '/:prefix{(dir|dl)}/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:language',
  twitterStatusRequest
);
twitter.get(
  '/:prefix{(dir|dl)}/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id',
  twitterStatusRequest
);
twitter.get(
  '/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:mediaType{(photos?|videos?)}/:mediaNumber{[1-4]}',
  twitterStatusRequest
);
twitter.get(
  '/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:mediaType{(photos?|videos?)}/:mediaNumber{[1-4]}/:language',
  twitterStatusRequest
);
twitter.get(
  '/:prefix{(dir|dl)}/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:mediaType{(photos?|videos?)}/:mediaNumber{[1-4]}',
  twitterStatusRequest
);
twitter.get(
  '/:prefix{(dir|dl)}/:handle{[0-9a-zA-Z_]+}/:endpoint{status(es)?|article}/:id/:mediaType{(photos?|videos?)}/:mediaNumber{[1-4]}/:language',
  twitterStatusRequest
);
twitter.get('/:handle/:endpoint{status(es)?|article}/:id/*', twitterStatusRequest);

twitter.get('/version', c => versionRoute(c));
twitter.get('/set_base_redirect', setRedirectRequest);
/* Yes, I actually made the endpoint /owoembed. Deal with it. */
twitter.get('/owoembed', oembed);

/* Self-hosted brand assets, so branding.json never has to point at a third-party CDN. */
twitter.get('/_/logo/:name', logoRoute);

twitter.get('/robots.txt', async c => c.text(Strings.ROBOTS_TXT));
twitter.get('/favicon.ico', faviconRoute);

twitter.get('/i/events/:id', genericTwitterRedirect);
twitter.get('/i/trending/:id', genericTwitterRedirect);
twitter.get(
  '/i/broadcasts/:id',
  genericTwitterRedirect
); /* https://github.com/FxEmbed/FxEmbed/issues/730 */
twitter.get('/hashtag/:hashtag', genericTwitterRedirect);

twitter.get('/:handle', _profileRequest);
/* Redirect profile subpages in case someone links them for some reason (https://github.com/FxEmbed/FxEmbed/issues/603) */
twitter.get('/:handle/:subpage', genericTwitterRedirect);

twitter.all('*', async c => c.redirect(getBranding(c).redirect, 302));
