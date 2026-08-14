import { Context } from 'hono';
import { Constants } from '../../../constants';
import { oembedResponse } from '../../../render/oembed';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  /* Fallbacks */
  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';
  const status = searchParams.get('status') ?? '';

  const statusUrl = `${Constants.TIKTOK_ROOT}/@${encodeURIComponent(author)}/video/${status}`;

  return oembedResponse(c, { text, authorUrl: statusUrl });
};
