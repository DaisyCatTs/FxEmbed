import { Context } from 'hono';
import { Constants } from './constants';
import { interpolate, Strings } from './strings';
import { MetaTag, serializeMeta } from './render/meta';
import { userAPI } from '@fxembed/atmosphere/providers/twitter/profile';
import { twitterBuildHostFromContext } from './providers/twitter/build-host-adapter';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { getBranding } from './helpers/branding';
import { InputFlags } from './types/types';
import { formatRuntime } from './helpers/runtime';
import { ERROR_CACHE_CONTROL } from './caches';

export const returnError = (c: Context, error: string): Response => {
  const branding = getBranding(c);
  /* Same reasoning as the status embed's error page: a failure gets a short life at the edge. */
  c.header('cache-control', ERROR_CACHE_CONTROL);
  return c.html(
    interpolate(Strings.BASE_HTML, {
      runtime: formatRuntime(),
      lang: '',
      body: '',
      headers: serializeMeta([
        { property: 'og:title', content: branding.name },
        { property: 'og:description', content: error },
        { property: 'theme-color', content: String(branding.color) }
      ]).toString()
    })
  ) as Response;
};

/* Handler for Twitter users */
export const handleProfile = async (
  c: Context,
  username: string,
  flags: InputFlags
): Promise<Response> => {
  console.log('flags', JSON.stringify(flags));
  const api = await userAPI(username, twitterBuildHostFromContext(c), true);
  const user = api?.user as APIUser;

  /* Catch this request if it's an API response */
  // For now we just always return the API response while testing
  if (flags?.api) {
    c.status(api.code as ContentfulStatusCode);
    // Add every header from Constants.API_RESPONSE_HEADERS
    for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
      c.header(header, value);
    }
    return c.json(api);
  }

  /* If there was any errors fetching the User, we'll return it */
  switch (api.code) {
    case 401:
      return returnError(c, Strings.ERROR_PRIVATE);
    case 404:
      return returnError(
        c,
        api.reason === 'suspended' ? Strings.ERROR_USER_SUSPENDED : Strings.ERROR_USER_NOT_FOUND
      );
    case 500:
      return returnError(c, Strings.ERROR_API_FAIL);
  }

  /* Base headers included in all responses */
  const headers: MetaTag[] = [{ property: 'twitter:site', content: `@${user.screen_name}` }];

  const branding = getBranding(c);
  const feedOrigin = new URL(c.req.url).origin;
  const enc = encodeURIComponent(username);
  /* No hand-rolled quote escaping any more — serializeMeta escapes the title. */
  const linkTitle = `@${username} — ${branding.name}`;
  headers.push({
    link: {
      rel: 'alternate',
      href: `${feedOrigin}/${enc}/feed.xml`,
      type: 'application/rss+xml',
      title: linkTitle
    }
  });
  headers.push({
    link: {
      rel: 'alternate',
      href: `${feedOrigin}/${enc}/feed.atom.xml`,
      type: 'application/atom+xml',
      title: linkTitle
    }
  });

  // TODO Add card creation logic here
  /* Finally, after all that work we return the response HTML! */

  return c.html(
    interpolate(Strings.BASE_HTML, {
      runtime: formatRuntime(),
      brandingName: branding.name,
      lang: `lang="en"`,
      headers: serializeMeta(headers).toString(),
      body: ''
    })
  );
};
