import { describe, expect, test } from 'vitest';
import { identifyRealm, type RealmName } from '../src/routing/identify';
import { encodeSnowcode } from '../src/helpers/snowcode';

const HOST = 'https://e.puppygirl.city';

const realmOf = (path: string): RealmName => identifyRealm(new URL(`${HOST}${path}`)).realm;
const pathOf = (path: string): string => identifyRealm(new URL(`${HOST}${path}`)).path;

describe('mirror shapes (paste the post URL, swap the domain)', () => {
  const cases: ReadonlyArray<[string, RealmName]> = [
    /* X */
    ['/jack/status/20', 'twitter'],
    ['/jack/statuses/20', 'twitter'],
    ['/i/status/20', 'twitter'],
    ['/i/web/status/20', 'twitter'],
    ['/jack/status/20/photo/1', 'twitter'],
    ['/jack/status/20/en', 'twitter'],
    ['/jack', 'twitter'],
    ['/jack/article/20', 'twitter'],

    /* Bluesky */
    ['/profile/alice.bsky.social/post/3kabcdefghij', 'bluesky'],
    ['/profile/did:plc:abc123/post/3kabcdefghij', 'bluesky'],

    /* TikTok */
    ['/@someuser/video/7234567890123456789', 'tiktok'],
    ['/@some.user/video/7234567890123456789', 'tiktok'],
    ['/t/ZP8yxgATu', 'tiktok'],

    /* Instagram */
    ['/p/CexampleShort', 'instagram'],
    ['/reel/CexampleShort', 'instagram'],
    ['/reels/CexampleShort', 'instagram'],
    ['/tv/CexampleShort', 'instagram']
  ];

  test.each(cases)('%s -> %s', (path, realm) => {
    expect(realmOf(path)).toEqual(realm);
  });
});

describe('explicit prefixes', () => {
  const cases: ReadonlyArray<[string, RealmName, string]> = [
    ['/_/x/jack/status/20', 'twitter', '/jack/status/20'],
    ['/_/twitter/jack/status/20', 'twitter', '/jack/status/20'],
    ['/_/bsky/profile/alice/post/xyz', 'bluesky', '/profile/alice/post/xyz'],
    ['/_/bluesky/profile/alice/post/xyz', 'bluesky', '/profile/alice/post/xyz'],
    ['/_/tiktok/@user/video/123', 'tiktok', '/@user/video/123'],
    ['/_/ig/p/Cexample', 'instagram', '/p/Cexample'],
    ['/_/instagram/p/Cexample', 'instagram', '/p/Cexample'],
    ['/_/api/2/status/20', 'api', '/2/status/20'],
    ['/_/blueskyapi/2/status/a/b', 'blueskyapi', '/2/status/a/b'],
    ['/_/atmosphere/2/openapi.json', 'atmosphere', '/2/openapi.json'],
    ['/_/m/sometoken/video.mp4', 'media', '/sometoken/video.mp4'],
    ['/_/m/sometoken', 'media', '/sometoken']
  ];

  test.each(cases)('%s -> %s %s', (path, realm, rest) => {
    expect(realmOf(path)).toEqual(realm);
    expect(pathOf(path)).toEqual(rest);
  });

  test('a bare prefix resolves to the realm root', () => {
    expect(identifyRealm(new URL(`${HOST}/_/bsky`))).toEqual({ realm: 'bluesky', path: '/' });
  });

  test('the reserved namespace does not swallow the X account @_', () => {
    /* `_` is a legal X handle on its own, and the reserved root is only consumed when it is
       followed by a known realm name. */
    expect(realmOf('/_')).toEqual('twitter');
    expect(pathOf('/_')).toEqual('/_');
    expect(realmOf('/_/status/20')).toEqual('twitter');
    expect(pathOf('/_/status/20')).toEqual('/_/status/20');
  });

  test('the media namespace does not swallow neighbouring paths', () => {
    /* `/_/m` is exact; `/_/media` and `/_/mastodon` are not the media endpoint, and neither is a
       handle beginning with m. */
    expect(realmOf('/_/mastodon/@a/1')).toEqual('twitter');
    expect(realmOf('/_/media/token')).toEqual('twitter');
  });

  test('an explicit prefix reaches a handle that a mirror shape shadows', () => {
    /* `/p/...` and `/t/...` belong to Instagram and TikTok, so @p and @t profiles need the
       explicit form. This is the one accepted collision of the single-domain design. */
    expect(realmOf('/_/x/p')).toEqual('twitter');
    expect(realmOf('/_/x/t')).toEqual('twitter');
  });
});

describe('collisions resolve to the right provider', () => {
  test('an X account called "profile" can still post', () => {
    /* `profile` is a legal X handle, so @profile's own statuses must not be read as Bluesky
       URLs. Everything else under /profile/ belongs to Bluesky, which is the far more common
       paste. */
    expect(realmOf('/profile/status/20')).toEqual('twitter');
    expect(realmOf('/profile/statuses/20')).toEqual('twitter');
    expect(realmOf('/profile')).toEqual('twitter');
  });

  test('Bluesky owns the rest of /profile, including feeds', () => {
    expect(realmOf('/profile/author.test/feed.xml')).toEqual('bluesky');
    expect(realmOf('/profile/author.test/feed.atom.xml')).toEqual('bluesky');
    expect(realmOf('/profile/author.test/media.xml')).toEqual('bluesky');
    expect(realmOf('/profile/alice.bsky.social')).toEqual('bluesky');
    expect(realmOf('/profile/alice/post/anything-at-all')).toEqual('bluesky');
  });

  test('an X feed for the account @x is not mistaken for a realm prefix', () => {
    /* @x is X's own account. This is exactly why explicit prefixes live under /_/. */
    expect(realmOf('/x/feed.xml')).toEqual('twitter');
    expect(pathOf('/x/feed.xml')).toEqual('/x/feed.xml');
    expect(realmOf('/x/status/20')).toEqual('twitter');
  });

  test('oEmbed routes by the provider its link carries', () => {
    expect(realmOf('/owoembed?text=a&provider=instagram')).toEqual('instagram');
    expect(realmOf('/owoembed?text=a&provider=bluesky')).toEqual('bluesky');
    expect(realmOf('/oembed?text=a&provider=tiktok')).toEqual('tiktok');
    expect(realmOf('/owoembed?text=a')).toEqual('twitter');
    expect(realmOf('/owoembed?text=a&provider=nonsense')).toEqual('twitter');
  });

  test('a three-segment path beginning /p or /t stays with X', () => {
    /* Only the exact two-segment form is Instagram/TikTok, so @p and @t can still post. */
    expect(realmOf('/p/status/20')).toEqual('twitter');
    expect(realmOf('/t/status/20')).toEqual('twitter');
  });

  test('a bare TikTok share code is TikTok, not an X handle', () => {
    /* vm.tiktok.com links carry no prefix — the code is the entire path — so shape is the only
       discriminator. It is rewritten onto the router's existing /t/:id route. */
    expect(realmOf('/ZN88mCDeg')).toEqual('tiktok');
    expect(pathOf('/ZN88mCDeg')).toEqual('/t/ZN88mCDeg');
    expect(realmOf('/ZP8yxgATu')).toEqual('tiktok');
    expect(realmOf('/ZM6h1a2Bc3')).toEqual('tiktok');
  });

  test('ordinary X handles are not mistaken for TikTok share codes', () => {
    /* The digit requirement is what saves handles like @ZachBraff; without it the Z-prefix and
       mixed case alone would claim them. */
    expect(realmOf('/ZachBraff')).toEqual('twitter');
    expect(realmOf('/Zoe')).toEqual('twitter');
    expect(realmOf('/zerocool')).toEqual('twitter');
    expect(realmOf('/ZZZZZZZZ')).toEqual('twitter');
    expect(realmOf('/jack')).toEqual('twitter');
    expect(realmOf('/elonmusk')).toEqual('twitter');
    /* All-lowercase or no leading Z, however code-like otherwise. */
    expect(realmOf('/zn88mcdeg')).toEqual('twitter');
    expect(realmOf('/AN88mCDeg')).toEqual('twitter');
  });

  test('an @-prefixed handle is never an X handle', () => {
    /* X handles are [0-9A-Za-z_] and can never contain @, so the literal @ is a safe marker. */
    expect(realmOf('/@someuser/video/7234567890123456789')).toEqual('tiktok');
  });

  test('a TikTok path without a numeric id is not TikTok', () => {
    expect(realmOf('/@someuser/video/notanid')).toEqual('twitter');
  });

  test('site-wide paths stay on the default realm', () => {
    expect(realmOf('/robots.txt')).toEqual('twitter');
    expect(realmOf('/favicon.ico')).toEqual('twitter');
    expect(realmOf('/owoembed')).toEqual('twitter');
    expect(realmOf('/')).toEqual('twitter');
  });
});

describe('activity endpoint carries its provider', () => {
  const activityPath = (data: object) => `/api/v1/statuses/${encodeSnowcode(data)}`;

  test.each([
    ['b', 'bluesky'],
    ['k', 'tiktok'],
    ['i', 'instagram'],
    ['t', 'twitter']
  ] as ReadonlyArray<[string, RealmName]>)('marker %s -> %s', (marker, realm) => {
    expect(realmOf(activityPath({ i: '20', v: marker }))).toEqual(realm);
  });

  test('a snowcode with no marker is treated as X', () => {
    /* Snowcodes minted before the marker existed are already cached and embedded in live pages,
       so they must keep resolving. */
    expect(realmOf(activityPath({ i: '20' }))).toEqual('twitter');
  });

  test('an unreadable snowcode falls back to X rather than erroring', () => {
    expect(realmOf('/api/v1/statuses/not-a-snowcode')).toEqual('twitter');
    expect(realmOf('/api/v1/statuses/999999')).toEqual('twitter');
  });

  test('the activity path is not captured by the JSON API prefix', () => {
    /* `/api/...` is the JSON API, but `/api/v1/statuses/...` is the activity endpoint. */
    expect(pathOf(activityPath({ i: '20', v: 'b' }))).toContain('/api/v1/statuses/');
  });
});

describe('hostname no longer decides anything', () => {
  test('the same path resolves identically across hostnames', () => {
    const paths = ['/jack/status/20', '/profile/alice/post/3kabcdefghij', '/p/Cexample'];
    const hosts = ['https://e.puppygirl.city', 'https://localhost:8787', 'https://foo.workers.dev'];

    paths.forEach(path => {
      const realms = hosts.map(host => identifyRealm(new URL(`${host}${path}`)).realm);
      expect(new Set(realms).size).toEqual(1);
    });
  });

  test('a three-label host works, which the old suffix matcher could not do', () => {
    /* The previous implementation compared the last two labels, so `e.puppygirl.city` became
       `puppygirl.city`, matched no configured domain, and every request fell through to X. */
    expect(identifyRealm(new URL('https://e.puppygirl.city/p/Cexample')).realm).toEqual(
      'instagram'
    );
  });
});
