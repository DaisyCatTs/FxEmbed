import { expect, test } from 'vitest';
import { ActivityStatus } from '../src/types/types';
import { app } from '../src/worker';
import harness from './helpers/harness';
import { encodeSnowcode } from '../src/helpers/snowcode';

/**
 * Regression tests for the media pipeline.
 *
 * Background: this deployment has no external mosaic/transcode services. Previously the code
 * assumed they existed and rewrote media URLs onto hosts that do not resolve, so GIFs, videos and
 * multi-image posts embedded as nothing at all. These tests pin the behaviour when those services
 * are absent, which is the production configuration.
 *
 * Note `test/helpers/env.ts` still configures the external services, because the older tests were
 * written against them. Tests below that need transcoding disabled request it through a host in
 * OLD_EMBED_DOMAINS, which is one of the conditions `shouldTranscodeGif` checks.
 */

const GIF_STATUS_ID = '1900000000000000001';
const GIF_MP4 = 'https://video.twimg.com/tweet_video/1900000000000000002.mp4';
const GIF_POSTER = 'https://pbs.twimg.com/tweet_video_thumb/GifPoster123.jpg';

/* A three-photo status, used to check that multiple images survive to the output. */
const MULTI_PHOTO_STATUS_ID = '1848831595014459513';
const MULTI_PHOTO_KEYS = ['GahebgHbEAEevTU', 'GahecZ5aAAEX7GX', 'GaheddqbsAAzGXg'];

const activityUrl = (host: string, data: object) =>
  `https://${host}/api/v1/statuses/${encodeSnowcode(data)}`;

/**
 * The test env still sets API_HOST_LIST, so video URLs are wrapped in a `/2/go?url=` redirect hop.
 * Production leaves that list empty and emits the CDN URL directly. Unwrap it so these tests
 * assert on the media actually being pointed at, in either configuration.
 */
const effectiveMediaUrl = (url: string): string => {
  const wrapped = new URL(url).searchParams.get('url');
  return wrapped ?? url;
};

const getActivity = async (host: string, data: object): Promise<ActivityStatus> => {
  const result = await app.request(
    new Request(activityUrl(host, data), {
      method: 'GET',
      headers: { 'User-Agent': 'Discordbot/2.0' }
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(200);
  return (await result.json()) as ActivityStatus;
};

test('GIF is delivered as a looping video, not a still image', async () => {
  const response = await getActivity('o.fxtwitter.com', {
    i: GIF_STATUS_ID,
    h: 'DivineDropbear'
  });

  expect(response.media_attachments.length).toEqual(1);
  const gif = response.media_attachments[0];

  /* `gifv` is what makes a client auto-loop it. Labelling it `video` yields a click-to-play
     control, and labelling it `image` (which is what the transcode path did) yields a still. */
  expect(gif.type).toEqual('gifv');

  /* The playable mp4 from the upstream CDN. */
  expect(effectiveMediaUrl(gif.url)).toEqual(GIF_MP4);

  /* The still frame belongs in preview_url, never as the main url. */
  expect(gif.preview_url).toEqual(GIF_POSTER);

  /* The specific failure this pins: the GIF used to be rewritten onto an external transcoder
     that does not exist, with a .webp extension for Discord. */
  expect(gif.url).not.toContain('gif.fxtwitter.com');
  expect(gif.url).not.toMatch(/\.webp($|\?)/);
});

test('GIF media is not filed as a photo when transcoding is unavailable', async () => {
  const result = await app.request(
    new Request(`https://o.fxtwitter.com/DivineDropbear/status/${GIF_STATUS_ID}`, {
      method: 'GET',
      /* Not Discordbot, so this renders OpenGraph tags rather than an activity pointer. */
      headers: { 'User-Agent': 'TestBot/1.0 (bot)' }
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(200);
  const html = await result.text();

  /* A GIF is a video for embedding purposes: it needs og:video to play. */
  expect(html).toContain(`<meta property="og:video" content="${GIF_MP4}"/>`);

  /* og:image should be the poster, and must not be the same URL as og:video. */
  expect(html).toContain(`<meta property="og:image" content="${GIF_POSTER}"/>`);

  expect(html).not.toContain('gif.fxtwitter.com');
});

test('every media attachment gets its own id', async () => {
  const response = await getActivity('fxtwitter.com', {
    i: MULTI_PHOTO_STATUS_ID,
    h: 'SpaceX'
  });

  expect(response.media_attachments.length).toEqual(MULTI_PHOTO_KEYS.length);

  /* Attachments are a keyed set: a shared id collapses a multi-photo post to a single image. */
  const ids = response.media_attachments.map(attachment => attachment.id);
  expect(new Set(ids).size).toEqual(ids.length);
  ids.forEach(id => expect(id).toBeTruthy());
});

test('a multi-photo status emits every photo, not just the first', async () => {
  const result = await app.request(
    new Request(`https://fxtwitter.com/SpaceX/status/${MULTI_PHOTO_STATUS_ID}`, {
      method: 'GET',
      /* Matches NATIVE_MULTI_IMAGE_UA_REGEX (so the client can show several images) but is not
         Discordbot, so we get OpenGraph tags rather than an activity pointer. */
      headers: { 'User-Agent': 'matrixpreviewbot/1.0' }
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(200);
  const html = await result.text();

  /* Previously the multi-image loop lived inside the mosaic branch, so with no mosaic service
     configured this fell through to a branch that rendered photos[0] alone. */
  const ogImageCount = html.match(/<meta property="og:image" content=/g)?.length ?? 0;
  expect(ogImageCount).toEqual(MULTI_PHOTO_KEYS.length);

  MULTI_PHOTO_KEYS.forEach(key => expect(html).toContain(key));
});

test('no rendered URL points at an empty host', async () => {
  const result = await app.request(
    new Request(`https://fxtwitter.com/SpaceX/status/${MULTI_PHOTO_STATUS_ID}`, {
      method: 'GET',
      headers: { 'User-Agent': 'TestBot/1.0 (bot)' }
    }),
    undefined,
    harness
  );
  const html = await result.text();

  /* An unset comma-separated env var used to parse to [''] rather than [], so "is this
     configured?" guards passed and we emitted URLs with no hostname. */
  expect(html).not.toContain('https:///');
  expect(html).not.toContain('https://undefined');
  expect(html).not.toContain('https://null');
});
