import { expect, test } from 'vitest';
import * as cheerio from 'cheerio';
import { app } from '../src/worker';
import harness from './helpers/harness';
import { escapeAttr, escapeText, raw } from '../src/render/html';
import { safeMetaUrl, serializeMeta } from '../src/render/meta';
import { interpolate } from '../src/strings';

/**
 * Escaping regression tests for the embed renderer.
 *
 * Every one of these payloads used to reach `content="..."` unescaped (or, in the `&#34;` case,
 * survived `sanitizeText` untouched and was then decoded back into a real `"` by the parser),
 * which closed the attribute and let arbitrary markup in.
 */

/* Closes content="..." and opens a script element. */
const NAME_PAYLOAD = '"><script>alert(1)</script>';
/* Closes content="..." and injects an event-handler attribute on the <meta> itself. */
const ALT_PAYLOAD = '" onerror=alert(1) x="';
/* Already-encoded quote. `sanitizeText` did not escape `&`, so this passed through verbatim and
   the HTML parser decoded it back to `"` — an attribute break with no literal quote in the input. */
const ENTITY_PAYLOAD = '&#34;';

/* Matches NATIVE_MULTI_IMAGE_UA_REGEX so both photos are emitted individually rather than being
   collapsed into a mosaic, and is not Discordbot so we get OpenGraph tags rather than an
   activity pointer. See test/media.gif.test.ts. */
const MULTI_IMAGE_BOT = 'matrixpreviewbot/1.0';

const STATUS_ID = '991777';

test('escapeAttr escapes & first so an encoded entity cannot be decoded back into a quote', () => {
  expect(escapeAttr(ENTITY_PAYLOAD)).toBe('&amp;#34;');
  expect(escapeAttr(NAME_PAYLOAD)).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(escapeAttr(ALT_PAYLOAD)).toBe('&quot; onerror=alert(1) x=&quot;');

  /* Idempotence in the sense that matters: escaping twice still decodes back to the once-escaped
     string rather than to the raw payload. */
  const parsed = cheerio.load(`<meta content="${escapeAttr(ENTITY_PAYLOAD)}"/>`);
  expect(parsed('meta').attr('content')).toBe(ENTITY_PAYLOAD);

  expect(escapeText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
});

test('interpolate leaves $-replacement patterns in substituted values inert', () => {
  /* `String.replace` with a string replacement expands `$&`, `$\'` and `$1`. The old
     `String.prototype.format` used that form, so a value containing them corrupted the output. */
  expect(interpolate('[{v}]', { v: "$& $' $` $1" })).toBe("[$& $' $` $1]");
  expect(interpolate('{a}-{b}', { a: '1' })).toBe('1-{b}');
  /* Placeholders named after Object.prototype members are left alone, not stringified functions. */
  expect(interpolate('{toString}', {})).toBe('{toString}');
});

test('safeMetaUrl drops anything that is not a well-formed https URL', () => {
  expect(safeMetaUrl('https://pbs.twimg.com/media/a.jpg')).toBe(
    'https://pbs.twimg.com/media/a.jpg'
  );
  expect(safeMetaUrl('http://pbs.twimg.com/media/a.jpg')).toBeNull();
  expect(safeMetaUrl('javascript:alert(1)')).toBeNull();
  expect(safeMetaUrl('" onerror=alert(1) x="')).toBeNull();
  expect(safeMetaUrl('')).toBeNull();
  expect(safeMetaUrl(undefined)).toBeNull();
});

test('serializeMeta escapes every value and emits exactly one tag per entry', () => {
  const markup = serializeMeta([
    { property: 'og:title', content: NAME_PAYLOAD },
    { property: 'og:image:alt', content: ALT_PAYLOAD },
    { property: 'og:description', content: ENTITY_PAYLOAD },
    { name: 'theme-color', content: '#6363ff' },
    { httpEquiv: 'refresh', content: '0;url=https://x.com/evil/status/991777' },
    { link: { rel: 'canonical', href: 'https://x.com/a?b=1&c=2', title: NAME_PAYLOAD } },
    /* raw() is the deliberate escape hatch: this string is a literal, not upstream data. */
    { rawHtml: raw('<style>body{color:red}</style>') }
  ]).toString();

  const $ = cheerio.load(markup);

  /* Six tag entries, one of which is a <style>: five <meta>, one <link>, one <style>, and
     crucially no injected <script> and no extra elements from a broken-out attribute. */
  expect($('meta').length).toBe(5);
  expect($('link').length).toBe(1);
  expect($('style').length).toBe(1);
  expect($('script').length).toBe(0);

  /* Every value round-trips back to exactly what went in. */
  expect($('meta[property="og:title"]').attr('content')).toBe(NAME_PAYLOAD);
  expect($('meta[property="og:image:alt"]').attr('content')).toBe(ALT_PAYLOAD);
  expect($('meta[property="og:description"]').attr('content')).toBe(ENTITY_PAYLOAD);
  expect($('link[rel="canonical"]').attr('href')).toBe('https://x.com/a?b=1&c=2');
  expect($('link[rel="canonical"]').attr('title')).toBe(NAME_PAYLOAD);

  /* The alt payload's whole point is to add an attribute to the tag it lands on. */
  expect($('meta[property="og:image:alt"]').attr('onerror')).toBeUndefined();
  expect(markup).not.toContain('<script');
});

test('a status with injection payloads in its name and alt text renders no extra markup', async () => {
  const result = await app.request(
    new Request(`https://fxtwitter.com/evil/status/${STATUS_ID}`, {
      method: 'GET',
      headers: { 'User-Agent': MULTI_IMAGE_BOT }
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(200);
  const body = await result.text();

  const $ = cheerio.load(body);

  /* Nothing broke out of an attribute. */
  expect($('script').length).toBe(0);
  expect($('img').length).toBe(0);
  expect(body).not.toContain('<script');
  /* `onerror=` may legitimately appear *inside* an escaped attribute value; what must not happen
     is it becoming an attribute of its own, which the allowed-attribute check below asserts. */
  expect(body).not.toContain('" onerror=');

  /* Two photos, so exactly two og:image tags and two og:image:alt tags — the alt count is the
     "exactly as expected" check: an attribute break would have produced a different number of
     parsed <meta> elements than tags we emitted. */
  expect($('meta[property="og:image"]').length).toBe(2);
  const alts = $('meta[property="og:image:alt"]')
    .map((_i, el) => $(el).attr('content'))
    .get();
  expect(alts).toEqual([ALT_PAYLOAD, ENTITY_PAYLOAD]);

  /* Author name reaches og:title / twitter:title and round-trips exactly. */
  expect($('meta[property="og:title"]').attr('content')).toBe(`${NAME_PAYLOAD} (@evil)`);
  expect($('meta[property="twitter:title"]').attr('content')).toBe(`${NAME_PAYLOAD} (@evil)`);

  /* The oembed <link> carries the display name in title=", which was previously raw. */
  const oembed = $('link[type="application/json+oembed"]');
  expect(oembed.length).toBe(1);
  expect(oembed.attr('title')).toBe(NAME_PAYLOAD);

  /* No <meta> anywhere in the document carries an attribute other than the ones we emit. */
  const allowedMetaAttrs = new Set(['property', 'name', 'http-equiv', 'content', 'charset']);
  $('meta').each((_i, el) => {
    Object.keys((el as { attribs: Record<string, string> }).attribs).forEach(attr => {
      expect(allowedMetaAttrs.has(attr)).toBe(true);
    });
  });
});
