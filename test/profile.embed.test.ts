import { expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import { app } from '../src/worker';
import harness from './helpers/harness';
import { botHeaders, brandingFor, twitterBaseUrl } from './helpers/data';

/**
 * Profile embed card.
 *
 * Pasting a profile link used to render as a bare link everywhere: `handleProfile` emitted
 * `twitter:site` and two feed `<link>`s and nothing else, so Discord had no title, description or
 * image to build a preview from. These cover the card it emits now, and the escaping it has to
 * hold up under — a display name and a bio are upstream text, and go into `content="..."`.
 */

/* Closes content="..." and opens a script element — the same payload render.escape.test.ts uses. */
const NAME_PAYLOAD = '"><script>alert(1)</script>';
/* Closes content="..." and injects an event handler onto the <meta> itself, then a script. */
const BIO_PAYLOAD = '" onerror=alert(1) x="<script>alert(2)</script>';

const fetchProfile = async (handle: string) => {
  const result = await app.request(
    new Request(`https://fxtwitter.com/${handle}`, {
      method: 'GET',
      headers: botHeaders
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(200);
  return await result.text();
};

test('a profile emits a complete card: title, description, image and canonical URL', async () => {
  const body = await fetchProfile('cardprofile');
  const $ = cheerio.load(body);

  /* The gap this closes: zero `og:` tags meant no preview at all. */
  expect($('meta[property^="og:"]').length).toBeGreaterThan(0);

  expect($('meta[property="og:title"]').attr('content')).toBe('Card Profile 🏢 (@cardprofile)');
  expect($('meta[property="twitter:title"]').attr('content')).toBe(
    'Card Profile 🏢 (@cardprofile)'
  );

  /* Bio first, then the counts, so a client that clips the description leads with the bio. */
  expect($('meta[property="og:description"]').attr('content')).toBe(
    'a bio with a & an <angle bracket>\n\n👥 1.23M Followers   ➡️ 250 Following   📝 4.2K Posts'
  );

  /* The avatar is the card image, upscaled off the 48px `_normal` variant X hands out. */
  const image = 'https://pbs.twimg.com/profile_images/2000000002/card_400x400.jpg';
  expect($('meta[property="og:image"]').attr('content')).toBe(image);
  expect($('meta[property="twitter:image"]').attr('content')).toBe(image);
  expect($('link[rel="apple-touch-icon"]').attr('href')).toBe(image);

  expect($('meta[property="twitter:card"]').attr('content')).toBe('summary');
  expect($('meta[property="twitter:site"]').attr('content')).toBe('@cardprofile');
  expect($('meta[property="twitter:creator"]').attr('content')).toBe('@cardprofile');

  expect($('meta[property="og:url"]').attr('content')).toBe(`${twitterBaseUrl}/cardprofile`);
  expect($('link[rel="canonical"]').attr('href')).toBe(`${twitterBaseUrl}/cardprofile`);
  expect($('meta[property="og:site_name"]').attr('content')).toBe(
    brandingFor('fxtwitter.com').name
  );

  /* The feed links the profile page already carried are still there. */
  expect($('link[type="application/rss+xml"]').length).toBe(1);
  expect($('link[type="application/atom+xml"]').length).toBe(1);
});

test('an unverified profile gets no verification badge in its title', async () => {
  const $ = cheerio.load(await fetchProfile('nobioprofile'));
  expect($('meta[property="og:title"]').attr('content')).toBe('No Bio Here (@nobioprofile)');
});

test('injection payloads in a display name and bio are escaped and produce no elements', async () => {
  const body = await fetchProfile('evilprofile');
  const $ = cheerio.load(body);

  /* The whole point: nothing broke out of `content="..."`. */
  expect($('script').length).toBe(0);
  expect(body).not.toContain('<script');
  expect(body).not.toContain('" onerror=');

  /* Both values round-trip back to exactly what upstream sent, which they only can if they were
     escaped rather than truncated or stripped. */
  expect($('meta[property="og:title"]').attr('content')).toBe(`${NAME_PAYLOAD} (@evilprofile)`);
  expect($('meta[property="og:description"]').attr('content')).toBe(
    `${BIO_PAYLOAD}\n\n👥 1.3K Followers   ➡️ 42 Following   📝 100 Posts`
  );

  /* An attribute break would have changed how many elements the parser sees, or added an
     attribute of its own to one of them. */
  expect($('meta[property="og:title"]').length).toBe(1);
  expect($('meta[property="og:description"]').length).toBe(1);
  const allowedMetaAttrs = new Set(['property', 'name', 'http-equiv', 'content', 'charset']);
  $('meta').each((_i, el) => {
    Object.keys((el as { attribs: Record<string, string> }).attribs).forEach(attr => {
      expect(allowedMetaAttrs.has(attr)).toBe(true);
    });
  });
  const allowedLinkAttrs = new Set(['rel', 'href', 'type', 'title', 'sizes']);
  $('link').each((_i, el) => {
    Object.keys((el as { attribs: Record<string, string> }).attribs).forEach(attr => {
      expect(allowedLinkAttrs.has(attr)).toBe(true);
    });
  });
});

test('a profile with no bio and no banner degrades without emitting empty tags', async () => {
  const $ = cheerio.load(await fetchProfile('nobioprofile'));

  /* No bio: the description is the counts alone, with no leading blank line left behind by the
     missing bio. */
  const description = $('meta[property="og:description"]').attr('content');
  expect(description).toBe('👥 7 Followers   ➡️ 0 Following   📝 0 Posts');

  /* No banner, but an avatar: exactly one image, and it is the avatar. */
  expect($('meta[property="og:image"]').length).toBe(1);
  expect($('meta[property="og:image"]').attr('content')).toBe(
    'https://pbs.twimg.com/profile_images/2000000000/plain_400x400.jpg'
  );

  /* Nothing was emitted with an empty value. */
  $('meta').each((_i, el) => {
    expect($(el).attr('content')).not.toBe('');
  });
  $('link').each((_i, el) => {
    expect($(el).attr('href')).not.toBe('');
  });
});

test('a profile with no avatar, banner or post count emits no image and drops absent counts', async () => {
  const $ = cheerio.load(await fetchProfile('barestprofile'));

  expect($('meta[property="og:title"]').attr('content')).toBe('Barest (@barestprofile)');
  expect($('meta[property="og:image"]').length).toBe(0);
  expect($('meta[property="twitter:image"]').length).toBe(0);
  expect($('link[rel="apple-touch-icon"]').length).toBe(0);
  /* The post count is genuinely absent upstream, so it is left out rather than shown as 0. */
  expect($('meta[property="og:description"]').attr('content')).toBe(
    '👥 0 Followers   ➡️ 0 Following'
  );
});

test('a profile that does not exist still returns an error card, not a bare page', async () => {
  const result = await app.request(
    new Request('https://fxtwitter.com/notfound3842342', {
      method: 'GET',
      headers: botHeaders
    }),
    undefined,
    harness
  );
  const $ = cheerio.load(await result.text());
  expect($('meta[property="og:title"]').length).toBe(1);
  expect($('meta[property="og:description"]').attr('content')).toContain(`doesn't exist`);
});
