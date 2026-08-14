import { expect, test } from 'vitest';
import { APIBlueskyStatusSchema } from '@fxembed/atmosphere/types/api-schemas';

test('APIBlueskyStatusSchema parses minimal bluesky-shaped payload', () => {
  const sample = {
    id: 'rkey1',
    cid: 'bafycid',
    at_uri: 'at://did:plc:x/app.bsky.feed.post/rkey1',
    url: 'https://bsky.app/profile/handle/post/rkey1',
    text: 'hi',
    created_at: '2024-01-01T00:00:00.000Z',
    created_timestamp: 1704067200,
    likes: 0,
    reposts: 0,
    replies: 0,
    author: {
      id: 'handle',
      name: 'N',
      screen_name: 'handle',
      avatar_url: null,
      banner_url: null,
      description: '',
      raw_description: { text: '', facets: [] },
      location: '',
      url: 'https://bsky.app/profile/handle',
      protected: false,
      followers: 0,
      following: 0,
      statuses: 0,
      media_count: 0,
      likes: 0,
      joined: '',
      website: null,
      type: 'profile' as const
    },
    media: { photos: [] },
    raw_text: { text: 'hi', facets: [] },
    lang: 'en',
    possibly_sensitive: false,
    replying_to: null,
    source: 'Bluesky Social',
    embed_card: 'tweet',
    provider: 'bluesky' as const,
    type: 'status' as const
  };

  const r = APIBlueskyStatusSchema.safeParse(sample);
  expect(r.success).toBe(true);
});
