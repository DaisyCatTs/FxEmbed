import { checkUrl } from '@fxembed/atmosphere/net';
import type { MediaLinkRequest } from '@fxembed/atmosphere/providers/media-runtime';
import { mediaProviderFor } from './allowlist';
import { primedMediaSigningKey } from './key';
import { signMediaToken } from './token';

/**
 * How long a minted link stays usable.
 *
 * Bounded because a token is a capability: whoever holds it can make us fetch that URL. Six hours
 * is long enough for a Discord embed to be re-fetched by a client scrolling back through a channel,
 * and short enough that it expires well before the provider CDN URL inside it does.
 */
export const MEDIA_TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** The reserved namespace the media endpoint is mounted under. See `src/routing/identify.ts`. */
export const MEDIA_PATH_PREFIX = '/_/m';

/**
 * Mint a signed link for a piece of provider media, or null if it should be served straight from
 * the provider's CDN.
 *
 * Null is returned — rather than an unsigned link — whenever anything is missing or wrong, because
 * the alternative is emitting a URL that would make the media endpoint fetch on a stranger's
 * behalf. The caller falls back to the upstream URL, which for a `direct` provider is the right
 * answer anyway.
 */
export const mintMediaUrl = async (request: MediaLinkRequest): Promise<string | null> => {
  const provider = mediaProviderFor(request.provider);
  if (!provider) {
    console.error(`No media provider registered for ${request.provider}`);
    return null;
  }

  /* X, Bluesky and Instagram CDNs serve embedding clients fine on their own. Routing them through
     here would cost latency and egress and make this Worker their single point of failure. */
  if (provider.delivery === 'direct') {
    return null;
  }

  const keyPromise = primedMediaSigningKey();
  if (!keyPromise) {
    console.error('MEDIA_SIGNING_KEY is not set; media will be served without proxying');
    return null;
  }

  /* Never sign a URL the endpoint would refuse to fetch. The endpoint re-checks this anyway, but a
     token we know is dead on arrival is worse than no token. */
  const checked = checkUrl(request.url, provider.policy);
  if (!checked.ok) {
    console.error(`Refusing to sign ${request.provider} media URL (${checked.reason})`);
    return null;
  }

  const credentials = request.credentials
    ? (provider.filterCredentials?.(request.credentials) ?? request.credentials)
    : '';

  try {
    const key = await keyPromise;
    const token = await signMediaToken(
      {
        p: request.provider,
        u: checked.url.href,
        m: 's',
        x: Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_SECONDS,
        ...(credentials ? { c: credentials } : {})
      },
      key
    );

    const name = request.name ? `/${encodeURIComponent(request.name)}` : '';
    return `${request.base}${MEDIA_PATH_PREFIX}/${token}${name}`;
  } catch (error) {
    /* Most likely a key that failed to import, e.g. one shorter than 32 bytes. */
    console.error('Failed to mint media token:', error);
    return null;
  }
};
