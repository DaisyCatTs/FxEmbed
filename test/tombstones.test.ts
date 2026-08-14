import { afterEach, expect, test, vi } from 'vitest';
import { app } from '../src/worker';
import { botHeaders } from './helpers/data';
import harness from './helpers/harness';
import { stripTombstones } from '../src/helpers/tombstone';
import { DataProvider } from '../src/enum';
import type { APIStatusTombstone, APITwitterStatus } from '@fxembed/atmosphere/types/api-schemas';

afterEach(() => {
  vi.restoreAllMocks();
});

const tombstone = (reason: APIStatusTombstone['reason']): APIStatusTombstone => ({
  type: 'tombstone',
  provider: 'twitter',
  reason,
  message: `msg-${reason}`,
  id: 't1'
});

const minimalTwitterStatus = (overrides: Partial<APITwitterStatus> = {}): APITwitterStatus =>
  ({
    type: 'status',
    id: '1',
    url: 'https://x.com/x/status/1',
    text: 'hello',
    created_at: 'Mon Jan 01 00:00:00 +0000 2024',
    created_timestamp: 1704067200,
    likes: 0,
    reposts: 0,
    replies: 0,
    author: {
      id: '12',
      name: 'A',
      screen_name: 'a',
      url: 'https://x.com/a',
      avatar_url: '',
      banner_url: null,
      followers: 0,
      following: 0,
      statuses: 0,
      joined: null,
      location: null,
      website: null,
      verified: false,
      protected: false,
      possibly_sensitive: false
    },
    media: {},
    raw_text: { text: 'hello', facets: [] },
    lang: 'en',
    possibly_sensitive: false,
    replying_to: null,
    source: null,
    embed_card: 'summary',
    provider: DataProvider.Twitter,
    ...overrides
  }) as APITwitterStatus;

test('stripTombstones removes nested quote tombstones and thread items', () => {
  const innerTomb = tombstone('deleted');
  const quoted = minimalTwitterStatus({ id: '2', quote: innerTomb });
  const outer = minimalTwitterStatus({ id: '3', quote: quoted });
  const th = tombstone('unavailable');
  const thread = {
    code: 200 as const,
    status: outer,
    thread: [outer, th, minimalTwitterStatus({ id: '4' })],
    author: outer.author
  };

  stripTombstones(thread);

  expect((thread.status.quote as APITwitterStatus | undefined)?.quote).toBeUndefined();
  expect(thread.thread?.length).toBe(2);
  expect(thread.thread?.every(t => (t as { type?: string }).type !== 'tombstone')).toBe(true);
});

/**
 * Tombstone coverage through the embed pipeline.
 *
 * These used to go through the `/2/*` JSON API, which read the same processors but is gone. The
 * embed path is the only surface this deployment serves, so that is where tombstones have to be
 * asserted — a tombstoned focal post must still produce a readable card rather than a blank one.
 */
const embed = async (path: string): Promise<string> => {
  const res = await app.request(
    new Request(`https://fxtwitter.com${path}`, { method: 'GET', headers: botHeaders }),
    undefined,
    harness
  );
  expect(res.status).toBe(200);
  return await res.text();
};

test('a suspended focal post embeds as its tombstone message, not an empty card', async () => {
  const html = await embed('/i/status/991500');
  expect(html).toContain('og:description');
  expect(html).toMatch(/suspended|unavailable|deleted/i);
});

test('a tombstoned quote is described in the embed of the post that quotes it', async () => {
  const html = await embed('/i/status/991004');
  expect(html).toMatch(/suspended|unavailable|deleted/i);
});
