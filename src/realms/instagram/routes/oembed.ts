import { Context } from 'hono';
import { Constants } from '../../../constants';
import { oembedResponse } from '../../../render/oembed';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  /* Fallbacks — /p/ and /reel/ are interchangeable for Instagram media */
  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';
  const status = searchParams.get('status') ?? '';

  const statusUrl = `${Constants.INSTAGRAM_ROOT}/p/${encodeURIComponent(status)}/`;

  return oembedResponse(c, {
    text,
    authorUrl: author ? `${Constants.INSTAGRAM_ROOT}/${encodeURIComponent(author)}/` : statusUrl,
    providerUrl: statusUrl
  });
};
