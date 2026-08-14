import { decodeSnowcode } from '../helpers/snowcode';

/**
 * Realm selection by URL shape.
 *
 * FxEmbed originally picked a realm from the request hostname: fxtwitter.com served X, fxbsky.app
 * served Bluesky, and so on. This deployment has exactly one hostname, so that model cannot work
 * — and worse, it failed silently. `worker.ts` derived the realm from the last two labels of the
 * hostname, so `e.puppygirl.city` became `puppygirl.city`, matched nothing, and fell through to a
 * catch-all that assumed X. Bluesky, TikTok and Instagram were unreachable entirely.
 *
 * Each provider's URLs have a distinct enough shape to tell them apart on a single host, so the
 * realm is chosen from the path instead. Pasting a post URL with the domain swapped keeps working
 * for every provider, and an explicit prefix (`/_/x/`, `/_/bsky/`, …) is available when a URL is
 * ambiguous or you want to be certain.
 *
 * This module is pure and does no I/O, so the whole table can be asserted in unit tests.
 */

export type RealmName =
  'twitter' | 'bluesky' | 'tiktok' | 'instagram' | 'mastodon' | 'threads' | 'media';

export type RealmMatch = {
  realm: RealmName;
  /** Path to hand the realm's router, with any explicit prefix removed. */
  path: string;
};

/**
 * Provider marker carried in an activity snowcode.
 *
 * The Discord activity endpoint is a single path (`/api/v1/statuses/:snowcode`) that every realm
 * used to register separately, disambiguated by hostname. On one host it needs to say which
 * provider it belongs to, so the generator stamps this in. Snowcodes minted before this existed
 * have no marker and are treated as X, which is what they were.
 */
export const SNOWCODE_PROVIDER_KEY = 'v';

export const SNOWCODE_PROVIDER_VALUES: Record<string, RealmName> = {
  t: 'twitter',
  b: 'bluesky',
  k: 'tiktok',
  i: 'instagram',
  m: 'mastodon',
  /* `t` was already spent on Twitter when these markers were minted, so Threads takes `s`. The
     letters are opaque tokens, not initials — what matters is that they never change meaning. */
  s: 'threads'
};

/**
 * Marker to stamp when generating an activity snowcode, keyed by `DataProvider`.
 *
 * X is deliberately absent: leaving the marker off keeps snowcodes byte-identical to the ones
 * already minted and cached, and an absent marker resolves to X anyway.
 */
export const ACTIVITY_PROVIDER_MARKERS: Record<string, string> = {
  bluesky: 'b',
  tiktok: 'k',
  instagram: 'i',
  mastodon: 'm',
  threads: 's'
};

/**
 * Explicit realm selection, under a reserved namespace.
 *
 * These live under `/_/` because every bare prefix collides with a real account name: `@x` is
 * X's own account, so `/x/feed.xml` has to mean that account's feed, not "the X realm". `_` is not
 * a valid leading character for a handle on any provider we support, so the namespace is free.
 */
const EXPLICIT_PREFIX_ROOT = '/_';

const EXPLICIT_PREFIXES: ReadonlyArray<readonly [string, RealmName]> = [
  ['/_/x', 'twitter'],
  ['/_/twitter', 'twitter'],
  ['/_/bsky', 'bluesky'],
  ['/_/bluesky', 'bluesky'],
  ['/_/tiktok', 'tiktok'],
  ['/_/ig', 'instagram'],
  ['/_/instagram', 'instagram'],
  ['/_/mastodon', 'mastodon'],
  ['/_/masto', 'mastodon'],
  ['/_/threads', 'threads'],
  /* Signed media. Not a provider realm — it belongs to no single one, and the provider it serves is
     named inside the token rather than by the path. It lives here because the reserved namespace is
     exactly the place for a route that must never collide with a handle. */
  ['/_/m', 'media']
];

/**
 * Path segments that mean the request is an X status even though it starts with `/profile`.
 * `profile` is a legal X handle, so `/profile/status/20` is @profile's post, not a Bluesky URL.
 */
const X_STATUS_SEGMENTS = ['status', 'statuses', 'article'];

/** oEmbed is one path shared by every realm; the generated link carries which one it belongs to. */
const OEMBED_PROVIDER_REALMS: Record<string, RealmName> = {
  twitter: 'twitter',
  bluesky: 'bluesky',
  tiktok: 'tiktok',
  instagram: 'instagram',
  mastodon: 'mastodon',
  threads: 'threads'
};

/** A TikTok or Threads handle segment is `@`-prefixed; an X handle can never contain `@`. */
const AT_HANDLE = /^@[\w.-]{1,30}$/;

const NUMERIC_ID = /^\d{6,25}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,32}$/;

/**
 * A Mastodon-family status id: a numeric snowflake on Mastodon itself, a base62 flake on
 * Pleroma/Akkoma/GoToSocial. Deliberately loose — this only has to be tight enough to keep
 * `/mastodon/status/20` (i.e. the X account @mastodon) out, and the instance host is what
 * actually gets validated, downstream, by `assertSafeMastodonDomain`.
 */
const MASTODON_STATUS_ID = /^[A-Za-z0-9]{1,40}$/;

/**
 * A plausible instance hostname: at least two dot-separated labels.
 *
 * This is a *routing* test, not a security test. It exists so `/mastodon/status/20` stays with X
 * (`status` has no dot, so it cannot be an instance) — nothing more. Every Mastodon fetch still
 * goes through `assertSafeMastodonDomain`, which is the only thing standing between a
 * user-supplied host and an outbound request.
 */
const INSTANCE_HOST = /^(?=.{4,253}$)[a-z\d]([a-z\d-]*[a-z\d])?(\.[a-z\d]([a-z\d-]*[a-z\d])?)+$/i;

/**
 * A bare TikTok share code, as produced by `vm.tiktok.com/ZN88mCDeg`.
 *
 * These links carry no prefix — the code *is* the whole path — so the only thing separating one
 * from an X handle is its shape. TikTok codes begin with `Z`, run 8-16 characters, and mix upper
 * case, lower case and digits; the digit is what does most of the work, since it rules out
 * ordinary handles like `@ZachBraff` that would otherwise fit.
 *
 * This is a heuristic, not a guarantee. An X handle shaped exactly like a share code (`@Z3roCool`)
 * is shadowed and has to be reached via `/_/x/Z3roCool`. That trade is worth it: pasting a TikTok
 * share link is common, and an X handle in this precise shape is rare.
 */
const isTikTokShareCode = (segment: string): boolean =>
  /^Z[A-Za-z0-9]{7,15}$/.test(segment) &&
  /\d/.test(segment) &&
  /[a-z]/.test(segment) &&
  /[A-Z]/.test(segment.slice(1));

const segmentsOf = (pathname: string): string[] => pathname.split('/').filter(Boolean);

/**
 * Read the provider marker out of an activity snowcode.
 *
 * Returns null when the snowcode is unreadable; the caller then falls through to the default
 * realm rather than rejecting the request, since a malformed snowcode is a client problem and
 * the handler already reports it.
 */
const realmFromSnowcode = (snowcode: string): RealmName | null => {
  try {
    const decoded = decodeSnowcode(snowcode) as Record<string, unknown>;
    const marker = decoded[SNOWCODE_PROVIDER_KEY];
    return typeof marker === 'string' ? (SNOWCODE_PROVIDER_VALUES[marker] ?? null) : null;
  } catch {
    return null;
  }
};

/**
 * Choose a realm for a request URL.
 *
 * Order matters: explicit prefixes win, then paths that are unambiguous because of a literal
 * segment or a constrained id shape, and X last because its `/:handle/status/:id` shape is the
 * widest and would otherwise swallow the others.
 */
export const identifyRealm = (url: URL): RealmMatch => {
  const pathname = url.pathname;
  const segments = segmentsOf(pathname);

  /* --- Explicit selection, e.g. /_/x/jack/status/20 --- */
  if (pathname === EXPLICIT_PREFIX_ROOT || pathname.startsWith(`${EXPLICIT_PREFIX_ROOT}/`)) {
    for (const [prefix, realm] of EXPLICIT_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        const rest = pathname.slice(prefix.length);
        return { realm, path: rest === '' ? '/' : rest };
      }
    }
  }

  /* --- Discord activity: the provider is stamped into the snowcode --- */
  if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'statuses' && segments[3]) {
    return { realm: realmFromSnowcode(segments[3]) ?? 'twitter', path: pathname };
  }

  /* --- oEmbed: the link we generated says which realm produced it --- */
  if ((segments[0] === 'owoembed' || segments[0] === 'oembed') && segments.length === 1) {
    const provider = url.searchParams.get('provider') ?? '';
    return { realm: OEMBED_PROVIDER_REALMS[provider] ?? 'twitter', path: pathname };
  }

  /* --- Mastodon: /mastodon/:instance/:id, and the pasted form /mastodon/:instance/@user/:id ---

     Mastodon is the one provider with no safe mirror shape. Its instance is the very hostname a
     single-domain deployment collapses, and what remains — `/@user/:id` — is structurally
     identical to Threads and TikTok. So the instance has to be named in the path, and naming it
     means the literal `/mastodon/` segment has to be there to introduce it.

     That segment shadows the X handle @mastodon, so the shape is kept narrow: the instance
     segment must look like a hostname (which `status`/`statuses`/`article` cannot), leaving
     @mastodon's own posts on X. `/_/x/mastodon/status/20` reaches them regardless. */
  if (segments[0] === 'mastodon' && segments.length >= 3 && INSTANCE_HOST.test(segments[1] ?? '')) {
    const tail = segments.slice(2);
    const looksLikeStatus =
      tail.length === 1
        ? MASTODON_STATUS_ID.test(tail[0])
        : tail.length === 2 && AT_HANDLE.test(tail[0]) && MASTODON_STATUS_ID.test(tail[1]);

    if (looksLikeStatus) {
      /* Strip the introducer so the realm router sees one shape regardless of whether the
         request arrived bare or under the explicit `/_/mastodon/` prefix. */
      return { realm: 'mastodon', path: `/${segments.slice(1).join('/')}` };
    }
  }

  /* --- Threads: /@handle/post/:code. TikTok already owns /@handle/video/:id. --- */
  if (
    AT_HANDLE.test(segments[0] ?? '') &&
    segments[1] === 'post' &&
    SHORTCODE.test(segments[2] ?? '') &&
    segments.length === 3
  ) {
    return { realm: 'threads', path: pathname };
  }

  /* --- Bluesky: every /profile/… shape (posts, feeds, the profile itself) --- */
  if (
    segments[0] === 'profile' &&
    segments.length >= 2 &&
    !X_STATUS_SEGMENTS.includes(segments[1] ?? '')
  ) {
    return { realm: 'bluesky', path: pathname };
  }

  /* --- TikTok: /@handle/video/:id --- */
  if (
    AT_HANDLE.test(segments[0] ?? '') &&
    segments[1] === 'video' &&
    NUMERIC_ID.test(segments[2] ?? '')
  ) {
    return { realm: 'tiktok', path: pathname };
  }

  /* --- TikTok short link: /t/:code. Shadows the X profile @t, which /_/x/t still reaches. --- */
  if (segments[0] === 't' && segments.length === 2 && SHORTCODE.test(segments[1])) {
    return { realm: 'tiktok', path: pathname };
  }

  /* --- TikTok share link with no prefix at all: vm.tiktok.com/ZN88mCDeg --- */
  if (segments.length === 1 && isTikTokShareCode(segments[0])) {
    /* Rewrite onto the router's existing /t/:id route rather than adding a bare-code route that
       would sit alongside the X profile route and be ambiguous there instead. */
    return { realm: 'tiktok', path: `/t/${segments[0]}` };
  }

  /* --- Instagram: /p/:code, /reel/:code, /reels/:code, /tv/:code --- */
  if (
    ['p', 'reel', 'reels', 'tv'].includes(segments[0] ?? '') &&
    segments.length === 2 &&
    SHORTCODE.test(segments[1])
  ) {
    return { realm: 'instagram', path: pathname };
  }

  /* --- Everything else is X, including bare handles and the site-wide routes --- */
  return { realm: 'twitter', path: pathname };
};
