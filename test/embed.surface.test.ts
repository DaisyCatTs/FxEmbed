import { test, expect, vi, afterEach } from 'vitest';
import { app } from '../src/worker';
import { botHeaders, humanHeaders } from './helpers/data';
import harness from './helpers/harness';
import threadSingle from './fixtures/bluesky/thread-single.json';

/**
 * The surface this deployment actually serves, pinned after the JSON API, Telegram Instant View
 * and the RSS/Atom feeds were removed.
 *
 * Those three subsystems had most of the test coverage in this repo, and their handlers ran
 * through the same `handleStatus` pipeline every embed uses. These tests assert the pipeline still
 * produces a complete Discord embed for X and for a non-X provider, that the oEmbed attribution
 * line Discord fetches still answers, and that the removed routes are genuinely gone rather than
 * quietly answering with something else.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const fetchText = async (url: string, headers = botHeaders): Promise<Response> =>
  app.request(new Request(url, { method: 'GET', headers }), undefined, harness);

test('an X status embeds with the full Discord tag set', async () => {
  const res = await fetchText('https://fxtwitter.com/jack/status/20');
  expect(res.status).toEqual(200);

  const html = await res.text();
  expect(html).toContain('<meta property="og:title" content="jack (@jack)"/>');
  expect(html).toContain('<meta property="og:description" content="just setting up my twttr"/>');
  expect(html).toContain('<meta property="og:url" content="https://x.com/jack/status/20"/>');
  expect(html).toContain('<meta property="twitter:card" content="summary"/>');

  /* The attribution line: Discord follows this link to /owoembed. */
  expect(html).toContain('type="application/json+oembed"');
  expect(html).toMatch(/href="https:\/\/[^"]+\/owoembed\?text=[^"]*status=20/);

  /* Instant View is gone, so the body stays empty and no reader-view markup is emitted. */
  expect(html).toContain('<body></body>');
});

test('a Bluesky post embeds through the same pipeline', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u.includes('app.bsky.feed.getPostThread')) {
      return new Response(JSON.stringify(threadSingle), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (u.includes('app.bsky.actor.getProfiles')) {
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });

  const res = await fetchText('https://fxbsky.app/profile/author.test/post/rkey1');
  expect(res.status).toEqual(200);

  const html = await res.text();
  expect(html).toContain('og:title');
  expect(html).toContain('og:description');
  expect(html).toContain('type="application/json+oembed"');
});

test('the activity endpoint Discord reads for media still answers', async () => {
  const res = await fetchText('https://fxtwitter.com/api/v1/statuses/6608666766545266');
  expect(res.status).toEqual(200);
  expect(res.headers.get('content-type')).toContain('application/json');

  const body = (await res.json()) as { id: string; account: { username: string } };
  expect(body.id).toEqual('20');
  expect(body.account.username).toEqual('jack');
});

test('oEmbed answers for X, and shows the provider param as the byline', async () => {
  const res = await fetchText(
    'https://fxtwitter.com/owoembed?text=hello&status=20&author=jack&provider=GIF'
  );
  expect(res.status).toEqual(200);

  const body = (await res.json()) as Record<string, string>;
  expect(body.version).toEqual('1.0');
  expect(body.type).toEqual('rich');
  expect(body.author_name).toEqual('hello');
  expect(body.author_url).toEqual('https://x.com/jack/status/20');
  /* X is the one realm that renders `provider` as a name — see src/render/oembed.ts. */
  expect(body.provider_name).toEqual('GIF');
  expect(body.provider_url).toEqual('https://x.com/jack/status/20');
});

test('oEmbed routes by its provider param to the realm that generated it', async () => {
  const res = await fetchText(
    'https://fxbsky.app/owoembed?text=hello&status=rkey1&author=author.test&provider=bluesky'
  );
  expect(res.status).toEqual(200);

  const body = (await res.json()) as Record<string, string>;
  expect(body.author_url).toEqual('https://bsky.app/profile/author.test/post/rkey1');
});

test('the removed JSON API, feeds and Instant View no longer answer', async () => {
  /* Each of these used to return its own content type. They now fall through to the embed realm,
     which is the point: nothing is left listening on them. */
  const api = await fetchText('https://fxtwitter.com/_/api/2/status/20');
  expect(api.headers.get('content-type')).not.toContain('application/json');

  const feed = await fetchText('https://fxtwitter.com/jack/feed.xml', humanHeaders);
  expect(feed.status).toEqual(302);
  expect(feed.headers.get('content-type')).not.toContain('xml');
});
