import { Context } from 'hono';
import { Constants } from '../../../constants';
import { oembedResponse } from '../../../render/oembed';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  /* Fallbacks */
  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';
  const status = searchParams.get('status') ?? '';

  const statusUrl = `${Constants.BLUESKY_ROOT}/profile/${encodeURIComponent(author)}/post/${status}`;

  return oembedResponse(c, { text, authorUrl: statusUrl });
};
