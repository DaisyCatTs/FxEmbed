import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../src/worker';
import { botHeaders, humanHeaders } from './helpers/data';
import harness from './helpers/harness';
import { decodeSnowcode, encodeSnowcode } from '../src/helpers/snowcode';
import { identifyRealm } from '../src/routing/identify';

const HOST = 'https://e.puppygirl.city';
const SHORTCODE = 'DXhZAMkljvS';

const user = (overrides: Record<string, unknown> = {}) => ({
  pk: '63398805919',
  id: '63398805919',
  username: 'spiramidgareorzea',
  full_name: 'Gem',
  profile_pic_url: 'https://scontent.cdninstagram.com/avatar.jpg',
  ...overrides
});

const post = (overrides: Record<string, unknown> = {}) => ({
  pk: '3882494318431583186',
  code: SHORTCODE,
  user: user(),
  taken_at: 1777049411,
  like_count: 7,
  media_type: 19,
  image_versions2: { candidates: [] },
  text_post_app_info: {
    direct_reply_count: 0,
    quote_count: 0,
    repost_count: 0,
    text_fragments: {
      fragments: [
        {
          fragment_type: 'plaintext',
          plaintext: 'Hello from Threads',
          mention_fragment: null,
          link_fragment: null
        }
      ]
    }
  },
  ...overrides
});

const postPage = (p: Record<string, unknown>) => ({
  data: { data: { edges: [{ node: { thread_items: [{ post: p }] } }] } }
});

/* Threads needs two hops before it will answer: a homepage navigation for the LSD token and a
   csrftoken cookie, then the Barcelona GraphQL query. The stub dispatches on which one it is. */
let fetched: string[] = [];

const installUpstream = (graphqlBody: unknown) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);

      if (url.includes('/graphql/query')) {
        return new Response(JSON.stringify(graphqlBody), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }

      return new Response('<script>["LSD",[],{"token":"test-lsd-token"},1]</script>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'set-cookie': 'csrftoken=test-csrf; Path=/'
        }
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

const metaContent = (html: string, property: string): string | null =>
  html.match(new RegExp(`<meta property="${property}" content="([^"]*)"/>`))?.[1] ?? null;

const embedFor = async (path: string) => {
  const res = await app.request(
    new Request(`${HOST}${path}`, { method: 'GET', headers: botHeaders }),
    undefined,
    harness
  );
  return { res, html: await res.text() };
};

describe('Threads embeds', () => {
  test('a post renders og:title and og:description', async () => {
    installUpstream(postPage(post()));

    const { res, html } = await embedFor(`/@spiramidgareorzea/post/${SHORTCODE}`);

    expect(res.status).toBe(200);
    expect(metaContent(html, 'og:title')).toBe('Gem (@spiramidgareorzea)');
    expect(metaContent(html, 'og:description')).toBe('Hello from Threads');
    /* The permalink embeds the author's handle, so it can only come from the fetched post. */
    expect(html).toContain(`https://www.threads.com/@spiramidgareorzea/post/${SHORTCODE}`);
    expect(fetched.some(u => u.includes('/graphql/query'))).toBe(true);
  });

  test('the explicit prefix reaches the same post without an author segment', async () => {
    installUpstream(postPage(post()));

    const { res, html } = await embedFor(`/_/threads/post/${SHORTCODE}`);

    expect(res.status).toBe(200);
    expect(metaContent(html, 'og:description')).toBe('Hello from Threads');
  });

  test('a hostile display name and post body cannot inject markup', async () => {
    const hostile = '"><script>alert(1)</script>';
    installUpstream(
      postPage(
        post({
          user: user({ full_name: hostile }),
          text_post_app_info: {
            direct_reply_count: 0,
            quote_count: 0,
            repost_count: 0,
            text_fragments: {
              fragments: [
                {
                  fragment_type: 'plaintext',
                  plaintext: hostile,
                  mention_fragment: null,
                  link_fragment: null
                }
              ]
            }
          }
        })
      )
    );

    const { html } = await embedFor(`/@spiramidgareorzea/post/${SHORTCODE}`);

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('a human is redirected to Threads rather than shown an embed', async () => {
    installUpstream(postPage(post()));

    const res = await app.request(
      new Request(`${HOST}/@spiramidgareorzea/post/${SHORTCODE}`, {
        method: 'GET',
        headers: humanHeaders
      }),
      undefined,
      harness
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `https://www.threads.com/@spiramidgareorzea/post/${SHORTCODE}`
    );
    expect(fetched).toEqual([]);
  });

  test('the activity JSON carries the provider marker and the media', async () => {
    installUpstream(
      postPage(
        post({
          media_type: 1,
          display_url: 'https://scontent.cdninstagram.com/photo.jpg',
          image_versions2: {
            candidates: [
              { url: 'https://scontent.cdninstagram.com/photo.jpg', width: 1080, height: 1350 }
            ]
          }
        })
      )
    );

    /* `s` is Threads' marker — `t` was already spent on Twitter when the markers were minted. */
    const snowcode = encodeSnowcode({ i: SHORTCODE, v: 's' });
    const res = await app.request(
      new Request(`${HOST}/api/v1/statuses/${snowcode}`, { method: 'GET', headers: botHeaders }),
      undefined,
      harness
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      media_attachments: { type: string; url: string }[];
      account: { username: string };
    };

    expect(body.account.username).toBe('spiramidgareorzea');
    expect(body.content).toContain('Hello from Threads');
    expect(body.media_attachments).toHaveLength(1);
    expect(body.media_attachments[0].type).toBe('image');
    expect(body.media_attachments[0].url).toBe('https://scontent.cdninstagram.com/photo.jpg');
  });

  test('the embed mints an activity link that routes back to this realm', async () => {
    installUpstream(postPage(post()));

    const { html } = await embedFor(`/@spiramidgareorzea/post/${SHORTCODE}`);

    const activity = html.match(
      /<link rel="alternate" href="https:\/\/[^/]+\/users\/[^/]+\/statuses\/([^"]+)" type="application\/activity\+json"\/>/
    );
    expect(activity).not.toBeNull();

    const decoded = decodeSnowcode(activity![1]) as Record<string, unknown>;
    expect(decoded.v).toBe('s');
    expect(decoded.i).toBe(SHORTCODE);

    expect(identifyRealm(new URL(`${HOST}/api/v1/statuses/${activity![1]}`)).realm).toBe('threads');
  });

  test('the realm serves oEmbed', async () => {
    const res = await app.request(
      new Request(
        `${HOST}/owoembed?text=hello&status=${SHORTCODE}&author=spiramidgareorzea&provider=threads`,
        { method: 'GET', headers: botHeaders }
      ),
      undefined,
      harness
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as { author_name: string; author_url: string };
    expect(data.author_name).toBe('hello');
    expect(data.author_url).toBe('https://www.threads.com/@spiramidgareorzea/');
  });
});
