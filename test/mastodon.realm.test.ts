import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../src/worker';
import { botHeaders, humanHeaders } from './helpers/data';
import harness from './helpers/harness';
import { decodeSnowcode, encodeSnowcode } from '../src/helpers/snowcode';
import { identifyRealm } from '../src/routing/identify';

const HOST = 'https://e.puppygirl.city';
const INSTANCE = 'mastodon.social';
const STATUS_ID = '109327927044751780';

type MastodonStatusFixture = Record<string, unknown>;

const account = (overrides: Record<string, unknown> = {}) => ({
  id: '1',
  username: 'Gargron',
  acct: 'Gargron',
  display_name: 'Eugen Rochko',
  note: '<p>Founder of Mastodon.</p>',
  url: `https://${INSTANCE}/@Gargron`,
  avatar: `https://${INSTANCE}/avatar.png`,
  avatar_static: `https://${INSTANCE}/avatar.png`,
  header: `https://${INSTANCE}/header.png`,
  header_static: `https://${INSTANCE}/header.png`,
  locked: false,
  followers_count: 100,
  following_count: 10,
  statuses_count: 5,
  created_at: '2016-03-16T14:34:26.392Z',
  emojis: [],
  ...overrides
});

const status = (overrides: Record<string, unknown> = {}): MastodonStatusFixture => ({
  id: STATUS_ID,
  created_at: '2022-11-10T18:00:00.000Z',
  url: `https://${INSTANCE}/@Gargron/${STATUS_ID}`,
  content: '<p>Hello from the fediverse</p>',
  language: 'en',
  sensitive: false,
  favourites_count: 12,
  reblogs_count: 3,
  replies_count: 1,
  in_reply_to_id: null,
  in_reply_to_account_id: null,
  media_attachments: [],
  mentions: [],
  tags: [],
  emojis: [],
  account: account(),
  ...overrides
});

/* `vi.stubGlobal` rather than assigning `globalThis.fetch`: this suite shares a Workers runtime
   with every other test file, so a replacement that outlived the test would break unrelated ones. */
let fetched: string[] = [];

const installUpstream = (body: unknown, init: ResponseInit = {}) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init
      });
    })
  );
};

beforeEach(() => {
  fetched = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const embedFor = async (path: string) => {
  const res = await app.request(
    new Request(`${HOST}${path}`, { method: 'GET', headers: botHeaders }),
    undefined,
    harness
  );
  return { res, html: await res.text() };
};

/** Pull a meta tag's content out of the rendered head. Deliberately regex-free of escaping help. */
const metaContent = (html: string, property: string): string | null => {
  const match = html.match(new RegExp(`<meta property="${property}" content="([^"]*)"/>`));
  return match?.[1] ?? null;
};

describe('Mastodon embeds', () => {
  test('a status renders og:title and og:description', async () => {
    installUpstream(status());

    const { res, html } = await embedFor(`/mastodon/${INSTANCE}/${STATUS_ID}`);

    expect(res.status).toBe(200);
    expect(metaContent(html, 'og:title')).toBe('Eugen Rochko (@Gargron@mastodon.social)');
    expect(metaContent(html, 'og:description')).toBe('Hello from the fediverse');
    /* The canonical URL can only come from upstream — a fediverse permalink lives on whichever
       instance served it, so there is nothing for us to reconstruct. */
    expect(html).toContain(`https://${INSTANCE}/@Gargron/${STATUS_ID}`);
    expect(fetched).toEqual([`https://${INSTANCE}/api/v1/statuses/${STATUS_ID}`]);
  });

  test('the pasted permalink shape works with the author segment left in', async () => {
    installUpstream(status());

    const { res, html } = await embedFor(`/mastodon/${INSTANCE}/@Gargron/${STATUS_ID}`);

    expect(res.status).toBe(200);
    expect(metaContent(html, 'og:description')).toBe('Hello from the fediverse');
  });

  test('an invalid instance is rejected without any fetch at all', async () => {
    /* This is the sharpest SSRF edge in the worker: the instance is supplied by whoever pasted the
       link. Asserting on `fetched` rather than on the response is the point — the failure mode
       that matters is a request leaving the worker, not the wording that comes back. */
    installUpstream(status());

    for (const hostile of [
      'localhost',
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '[::1]',
      'metadata.google.internal'
    ]) {
      const res = await app.request(
        new Request(`${HOST}/_/mastodon/${encodeURIComponent(hostile)}/${STATUS_ID}`, {
          method: 'GET',
          headers: botHeaders
        }),
        undefined,
        harness
      );
      /* Errors are served as embeddable HTML so the client can show the reason. */
      expect(res.status).toBe(200);
    }

    expect(fetched).toEqual([]);
  });

  test('a hostile display name and bio cannot inject markup', async () => {
    const hostile = '"><script>alert(1)</script>';
    installUpstream(
      status({
        content: `<p>${hostile}</p>`,
        account: account({
          display_name: hostile,
          note: `<p>${hostile}</p>`
        })
      })
    );

    const { html } = await embedFor(`/mastodon/${INSTANCE}/${STATUS_ID}`);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    /* Escaped, not merely stripped: the text still reaches the reader intact. */
    expect(html).toContain('&lt;script&gt;');
    expect(metaContent(html, 'og:title')).toContain('&quot;&gt;&lt;script&gt;');
  });

  test('a hostile avatar URL never becomes a tag', async () => {
    /* `safeMetaUrl` drops anything that is not a well-formed https URL rather than emitting a
       half-built tag, so a javascript: avatar leaves no trace. */
    installUpstream(
      status({
        account: account({
          avatar: 'javascript:alert(1)',
          avatar_static: 'javascript:alert(1)'
        })
      })
    );

    const { html } = await embedFor(`/mastodon/${INSTANCE}/${STATUS_ID}`);

    expect(html).not.toContain('javascript:');
  });

  test('a human is redirected to the instance, not shown an embed', async () => {
    installUpstream(status());

    const res = await app.request(
      new Request(`${HOST}/mastodon/${INSTANCE}/@Gargron/${STATUS_ID}`, {
        method: 'GET',
        headers: humanHeaders
      }),
      undefined,
      harness
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://${INSTANCE}/@Gargron/${STATUS_ID}`);
    /* The destination was in the URL already, so nothing had to be asked of the instance. */
    expect(fetched).toEqual([]);
  });

  test('the activity JSON carries the provider marker, the instance and the media', async () => {
    installUpstream(
      status({
        media_attachments: [
          {
            id: '22345792',
            type: 'image',
            url: `https://${INSTANCE}/media/original.jpg`,
            preview_url: `https://${INSTANCE}/media/small.jpg`,
            description: 'A photo',
            meta: { original: { width: 1200, height: 800 } }
          }
        ]
      })
    );

    /* `m` is Mastodon's marker and `h` carries the instance — a status id alone does not identify
       a fediverse post, so the activity endpoint would have nothing to fetch without it. */
    const snowcode = encodeSnowcode({ i: STATUS_ID, v: 'm', h: INSTANCE });
    const res = await app.request(
      new Request(`${HOST}/api/v1/statuses/${snowcode}`, {
        method: 'GET',
        headers: botHeaders
      }),
      undefined,
      harness
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      media_attachments: { type: string; url: string }[];
      account: { username: string };
    };

    expect(body.content).toContain('Hello from the fediverse');
    expect(body.account.username).toBe('Gargron@mastodon.social');
    expect(body.media_attachments).toHaveLength(1);
    expect(body.media_attachments[0].type).toBe('image');
    expect(body.media_attachments[0].url).toBe(`https://${INSTANCE}/media/original.jpg`);
    expect(fetched).toEqual([`https://${INSTANCE}/api/v1/statuses/${STATUS_ID}`]);
  });

  test('the embed mints an activity link that routes back to this realm', async () => {
    /* Discord follows the activity link rather than reading the OpenGraph tags, and that link is a
       bare snowcode on a path every provider shares. Round-tripping it through `identifyRealm` is
       the only assertion that proves the marker was stamped *and* is read back correctly. */
    installUpstream(status());

    const { html } = await embedFor(`/mastodon/${INSTANCE}/${STATUS_ID}`);

    const activity = html.match(
      /<link rel="alternate" href="https:\/\/[^/]+\/users\/[^/]+\/statuses\/([^"]+)" type="application\/activity\+json"\/>/
    );
    expect(activity).not.toBeNull();

    const decoded = decodeSnowcode(activity![1]) as Record<string, unknown>;
    expect(decoded.v).toBe('m');
    expect(decoded.h).toBe(INSTANCE);
    expect(decoded.i).toBe(STATUS_ID);

    expect(identifyRealm(new URL(`${HOST}/api/v1/statuses/${activity![1]}`)).realm).toBe(
      'mastodon'
    );
  });

  test('an activity snowcode with no instance does not reach the network', async () => {
    installUpstream(status());

    const snowcode = encodeSnowcode({ i: STATUS_ID, v: 'm' });
    const res = await app.request(
      new Request(`${HOST}/api/v1/statuses/${snowcode}`, {
        method: 'GET',
        headers: botHeaders
      }),
      undefined,
      harness
    );

    expect(res.status).toBe(200);
    expect(fetched).toEqual([]);
  });

  test('the realm serves oEmbed and derives the profile URL from the acct', async () => {
    const res = await app.request(
      new Request(
        `${HOST}/owoembed?text=hello&status=${STATUS_ID}&author=Gargron%40mastodon.social&provider=mastodon`,
        { method: 'GET', headers: botHeaders }
      ),
      undefined,
      harness
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { author_name: string; author_url: string };
    expect(data.author_name).toBe('hello');
    expect(data.author_url).toBe(`https://${INSTANCE}/@Gargron`);
  });

  test('oEmbed does not invent a profile URL from a hostile acct', async () => {
    const res = await app.request(
      new Request(`${HOST}/owoembed?text=hello&author=admin%40127.0.0.1&provider=mastodon`, {
        method: 'GET',
        headers: botHeaders
      }),
      undefined,
      harness
    );

    const data = (await res.json()) as { author_url: string };
    expect(data.author_url).not.toContain('127.0.0.1');
  });
});
