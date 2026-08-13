/**
 * Which hosts each provider is allowed to reach.
 *
 * Entries are matched exactly or as a parent domain, so `twimg.com` would cover every subdomain.
 * They are kept deliberately narrow instead: listing the specific CDN hostnames means a
 * compromised or mistaken URL elsewhere in a provider's payload cannot redirect us somewhere
 * unrelated. Corporate-wide domains (`bytedance.com`) are intentionally absent for that reason.
 */
import type { HostPolicy } from './host-validation.js';

/** Build an allowlist policy. */
export const allowHosts = (...hosts: readonly string[]): HostPolicy => ({
  mode: 'allowlist',
  hosts
});

/**
 * Any public host. Only for providers whose host is inherently unbounded — a Mastodon instance or
 * a Bluesky PDS is named by the user or discovered from a DID, so no fixed list can exist.
 * Loopback, private, link-local and reserved names are still rejected.
 */
export const ANY_PUBLIC_HOST: HostPolicy = { mode: 'public' };

export const TWITTER_API_HOSTS = [
  'x.com',
  'api.x.com',
  'twitter.com',
  'api.twitter.com',
  'abs.twimg.com'
] as const;

export const TWITTER_MEDIA_HOSTS = [
  'pbs.twimg.com',
  'video.twimg.com',
  'abs.twimg.com',
  'ton.twimg.com'
] as const;

/** The t.co shortener itself. Its destination is validated separately and may be any public host. */
export const TWITTER_SHORTENER_HOSTS = ['t.co'] as const;

export const BLUESKY_APPVIEW_HOSTS = ['public.api.bsky.app', 'bsky.app'] as const;

export const BLUESKY_MEDIA_HOSTS = [
  'cdn.bsky.app',
  'video.bsky.app',
  'video.cdn.bsky.app'
] as const;

export const TIKTOK_API_HOSTS = ['tiktok.com', 'tiktokv.com'] as const;

export const TIKTOK_MEDIA_HOSTS = [
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'tiktokv.com',
  'byteimg.com',
  'musical.ly'
] as const;

export const INSTAGRAM_HOSTS = ['instagram.com', 'cdninstagram.com', 'fbcdn.net'] as const;

export const THREADS_HOSTS = [
  'threads.com',
  'threads.net',
  'instagram.com',
  'cdninstagram.com',
  'fbcdn.net'
] as const;

export const NetPolicies = {
  twitterApi: allowHosts(...TWITTER_API_HOSTS),
  twitterMedia: allowHosts(...TWITTER_MEDIA_HOSTS),
  twitterShortener: allowHosts(...TWITTER_SHORTENER_HOSTS),
  blueskyAppView: allowHosts(...BLUESKY_APPVIEW_HOSTS),
  blueskyMedia: allowHosts(...BLUESKY_MEDIA_HOSTS),
  /** A PDS is discovered from the user's DID document and can be self-hosted anywhere. */
  blueskyPds: ANY_PUBLIC_HOST,
  tiktokApi: allowHosts(...TIKTOK_API_HOSTS),
  tiktokMedia: allowHosts(...TIKTOK_MEDIA_HOSTS),
  /** Short links land on either the site or a CDN host, so resolution needs both. */
  tiktokMediaAndSite: allowHosts(...TIKTOK_API_HOSTS, ...TIKTOK_MEDIA_HOSTS),
  instagram: allowHosts(...INSTAGRAM_HOSTS),
  threads: allowHosts(...THREADS_HOSTS),
  /** The instance hostname comes straight from the request path. */
  mastodonInstance: ANY_PUBLIC_HOST
} as const;
