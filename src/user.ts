import { Context } from 'hono';
import i18next from 'i18next';
import icu from 'i18next-icu';
import { Constants } from './constants';
import { interpolate, Strings } from './strings';
import { MetaTag, safeMetaUrl, serializeMeta } from './render/meta';
import { userAPI } from '@fxembed/atmosphere/providers/twitter/profile';
import { twitterBuildHostFromContext } from './providers/twitter/build-host-adapter';
import { ContentfulStatusCode } from 'hono/utils/http-status';
import { getBranding } from './helpers/branding';
import { InputFlags } from './types/types';
import { formatRuntime } from './helpers/runtime';
import { ERROR_CACHE_CONTROL } from './caches';
import { formatNumber, truncateWithEllipsis } from './helpers/utils';
import translationResources from '../i18n/resources';

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

/**
 * X stores one avatar URL with the requested size baked into the filename (`..._normal.jpg` is
 * 48x48). Embedding that verbatim gives clients a thumbnail too small to be recognisable, so ask
 * for the 400px variant — the same trick the Instant View renderer uses.
 *
 * The lookahead keeps a query string (if one ever appears) intact, and `$2` collapses to an empty
 * string when the URL carries no file extension.
 */
const upscaleAvatarUrl = (url: string): string =>
  url.replace(/_(normal|bigger|mini|200x200)(\.\w+)?(?=$|\?)/, '_400x400$2');

/**
 * A short marker for a verified account, by verification kind.
 *
 * Discord renders no badge of its own, so without this the card cannot distinguish a verified
 * account from an impersonator with the same display name.
 */
const verificationBadge = (user: APIUser): string => {
  if (!user.verification?.verified) {
    return '';
  }
  switch (user.verification.type) {
    case 'government':
      return ' 🏛️';
    case 'organization':
      return ' 🏢';
    default:
      return ' ☑️';
  }
};

/**
 * `followers / following / posts`, formatted the way social proof is formatted on a status embed.
 *
 * A count is dropped only when it is genuinely absent from the API response. Zero is a real
 * answer — an account with no followers should say so rather than silently lose the line.
 */
const buildProfileStats = (user: APIUser): string => {
  /* `handleProfile` asks for legacy user counts (the v1 JSON API contract), and in that mode the
     provider writes the post count to `tweets` instead of `statuses`. Read both so the card is
     populated regardless of which shape produced this user. */
  const statuses = user.statuses ?? (user as unknown as { tweets?: number }).tweets;

  const stats: string[] = [];
  if (typeof user.followers === 'number') {
    stats.push(
      `👥 ${formatNumber(user.followers)} ${i18next.t('ivProfileFollowers', {
        numFollowers: user.followers
      })}`
    );
  }
  if (typeof user.following === 'number') {
    stats.push(
      `➡️ ${formatNumber(user.following)} ${i18next.t('ivProfileFollowing', {
        numFollowing: user.following
      })}`
    );
  }
  if (typeof statuses === 'number') {
    stats.push(
      `📝 ${formatNumber(statuses)} ${i18next.t('ivProfileStatuses', { numStatuses: statuses })}`
    );
  }
  return stats.join('   ');
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

  /* `convertToApiUser` falls back to an empty screen name when upstream returns a `User` node with
     neither `core.screen_name` nor `legacy.screen_name`. That used to reach the page as a bare
     `@`; the requested handle is always a better answer than nothing. */
  const screenName = user.screen_name || username;
  const displayName = user.name?.trim() || `@${screenName}`;

  /* Base headers included in all responses */
  const headers: MetaTag[] = [
    { property: 'twitter:site', content: `@${screenName}` },
    { property: 'twitter:creator', content: `@${screenName}` }
  ];

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

  /* The profile card.
     Everything below is pushed as data and escaped once by `serializeMeta`. Display names and bios
     are attacker-controlled, so nothing here may be spliced into markup by hand. */

  /* Profile routes carry no language segment, so the card is built in English and falls back to it
     for any key a locale is missing. The counts labels come from the same resources the Instant
     View author box uses. */
  await i18next.use(icu).init({
    lng: 'en',
    resources: translationResources,
    fallbackLng: 'en'
  });

  const publicProfileUrl = flags?.horizon
    ? `${Constants.HORIZON_WEB_ROOT}/${encodeURIComponent(screenName)}`
    : user.url || `${Constants.TWITTER_ROOT}/${encodeURIComponent(screenName)}`;
  const safeProfileUrl = safeMetaUrl(publicProfileUrl);
  if (safeProfileUrl) {
    headers.push(
      { link: { rel: 'canonical', href: safeProfileUrl } },
      { property: 'og:url', content: safeProfileUrl }
    );
  }

  headers.push(
    { property: 'theme-color', content: String(branding.color) },
    { property: 'og:site_name', content: branding.name }
  );

  const title = `${displayName}${verificationBadge(user)} (@${screenName})`;
  headers.push(
    { property: 'og:title', content: title },
    { property: 'twitter:title', content: title }
  );

  /* Bio first, then the counts, separated by a blank line so clients that collapse the description
     to a couple of lines still lead with what the account says about itself. A profile with neither
     (a brand-new or wiped account) gets no `og:description` at all rather than an empty one. */
  const bio = truncateWithEllipsis((user.description ?? '').trim(), 400);
  const stats = buildProfileStats(user);
  const description = [bio, stats].filter(Boolean).join('\n\n');
  if (description) {
    headers.push({ property: 'og:description', content: description });
  }

  /* The avatar is the card image: at `summary` size a client renders it as a square thumbnail
     beside the text, which is exactly the shape a profile picture wants. The banner is the
     fallback — a card can only carry one image, and an account without an avatar is far rarer than
     one without a banner, so spending the single slot on the banner would be a downgrade in every
     other case. */
  const avatarUrl = safeMetaUrl(user.avatar_url ? upscaleAvatarUrl(user.avatar_url) : null);
  const bannerUrl = safeMetaUrl(user.banner_url);
  const cardImage = avatarUrl ?? bannerUrl;

  headers.push({ property: 'twitter:card', content: 'summary' });
  if (cardImage) {
    headers.push(
      { property: 'og:image', content: cardImage },
      { property: 'twitter:image', content: cardImage }
    );
  }
  if (avatarUrl) {
    headers.push({ link: { rel: 'apple-touch-icon', href: avatarUrl } });
  }

  /* Same reasoning as the status embed: if a real browser somehow lands here it should end up on
     the profile rather than staring at a blank page. Telegram gets stuck on this tag, so it is
     never sent one. */
  if (!(c.req.header('user-agent') ?? '').includes('TelegramBot') && safeProfileUrl) {
    headers.push({ httpEquiv: 'refresh', content: `0;url=${safeProfileUrl}` });
  }

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
