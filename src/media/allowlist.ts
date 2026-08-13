import { NetPolicies, type HostPolicy } from '@fxembed/atmosphere/net';
import { generateUserAgent } from '../helpers/useragent';

/**
 * What each provider's media needs from us.
 *
 * `direct` is the default and the one to prefer. X, Bluesky and Instagram serve their CDN media to
 * Discord perfectly well on their own, so putting the Worker in front of it would only add a hop of
 * latency, bill us for the egress, and make us the thing that breaks when the Worker is degraded.
 * TikTok is the exception: its CDN answers 403 to anything that does not look like the browser that
 * loaded the page, so its video bytes have to come through us with the right headers attached.
 *
 * This table is also the allowlist the signed media endpoint verifies against, so adding a provider
 * here is what makes tokens for it fetchable — and removing one retroactively invalidates every
 * token already in the wild, because the policy is re-checked at request time.
 */

export type MediaDelivery = 'direct' | 'proxy';

export type MediaFetchContext = {
  url: URL;
  /** The token's credential blob, if it carried one. */
  credentials?: string;
};

export type MediaProvider = {
  readonly policy: HostPolicy;
  readonly delivery: MediaDelivery;
  /**
   * Header sets to try, in order, when streaming this provider's media.
   *
   * A list rather than one set because TikTok's CDN is inconsistent about which shape it accepts:
   * the old proxy escalated through several profiles on a 403 and that is what made it work often
   * enough to be worth having. Providers with a well-behaved CDN return a single entry.
   */
  readonly outboundHeaders?: (context: MediaFetchContext) => ReadonlyArray<Record<string, string>>;
  /**
   * Reduce a credential blob to what the CDN actually needs, applied when the token is minted.
   *
   * The blob is server-minted now, so it is no longer caller-controlled — but it is still copied
   * out of a third party's `Set-Cookie` headers, and there is no reason to hand any of it back
   * beyond the names that are load-bearing.
   */
  readonly filterCredentials?: (raw: string) => string;
};

/** Cookie names TikTok's CDN actually consults. Everything else it sets is session noise. */
const TIKTOK_FORWARDABLE_COOKIES = new Set(['tt_chain_token', 'ttwid', 'msToken', 'odin_tt']);

const tiktokCredentials = (raw: string): string =>
  raw
    .split(';')
    .map(part => part.trim())
    .filter(part => {
      const name = part.split('=')[0]?.trim();
      return name ? TIKTOK_FORWARDABLE_COOKIES.has(name) : false;
    })
    .join('; ');

/**
 * TikTok's CDN header profile.
 *
 * Notes carried over from the endpoint this replaces, all of them learned the hard way:
 *  1. `Sec-Fetch-*` headers trip bot detection, so they are absent.
 *  2. The cookies must go to the CDN hostname, not just the page.
 *  3. Keep the set small — TikTok fails *more* often with a full browser header set.
 *
 * The `Referer` is the site root rather than the specific video page. The old proxy took the video
 * id from a query parameter to build a per-video referer; the signed token carries a URL and a
 * credential blob and nothing else, and widening the token's payload to restore a cosmetic header
 * is not worth it. TikTok accepts the root referer.
 */
const tiktokHeaders = (context: MediaFetchContext): ReadonlyArray<Record<string, string>> => {
  const [userAgent, secChUa] = generateUserAgent();

  const base: Record<string, string> = {
    'User-Agent': userAgent,
    'sec-ch-ua': secChUa,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.tiktok.com/'
  };

  if (context.credentials) {
    base['Cookie'] = context.credentials;
  }

  const escalations: Record<string, string>[] = [
    base,
    { ...base, 'Accept-Encoding': 'identity;q=1, *;q=0' },
    { ...base, Origin: 'https://www.tiktok.com' }
  ];

  /* Last resort: the cookies themselves are sometimes what the edge objects to, typically when
     they were minted in a different region to the one serving the bytes. */
  if (context.credentials) {
    const withoutCookies = { ...base };
    delete withoutCookies['Cookie'];
    escalations.push(withoutCookies);
  }

  return escalations;
};

export const MEDIA_PROVIDERS: Readonly<Record<string, MediaProvider>> = {
  tiktok: {
    policy: NetPolicies.tiktokMedia,
    delivery: 'proxy',
    outboundHeaders: tiktokHeaders,
    filterCredentials: tiktokCredentials
  },
  twitter: { policy: NetPolicies.twitterMedia, delivery: 'direct' },
  bluesky: { policy: NetPolicies.blueskyMedia, delivery: 'direct' },
  instagram: { policy: NetPolicies.instagram, delivery: 'direct' },
  threads: { policy: NetPolicies.threads, delivery: 'direct' }
};

export const mediaProviderFor = (provider: string): MediaProvider | null =>
  Object.prototype.hasOwnProperty.call(MEDIA_PROVIDERS, provider)
    ? MEDIA_PROVIDERS[provider]
    : null;

/** The policy lookup `verifyMediaToken` re-validates a token's URL against. */
export const mediaPolicyFor = (provider: string): HostPolicy | null =>
  mediaProviderFor(provider)?.policy ?? null;
