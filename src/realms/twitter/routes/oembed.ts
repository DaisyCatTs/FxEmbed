import { Context } from 'hono';
import { Constants } from '../../../constants';
import { oembedResponse } from '../../../render/oembed';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  /* Fallbacks are @jack's first post — a real, permanent URL, so a hand-typed /owoembed still
     answers with something valid rather than a link to nowhere. */
  const text = searchParams.get('text') ?? 'Twitter';
  const author = searchParams.get('author') ?? 'jack';
  const status = searchParams.get('status') ?? '20';

  const statusUrl = `${Constants.TWITTER_ROOT}/${encodeURIComponent(author)}/status/${status}`;

  return oembedResponse(c, { text, authorUrl: statusUrl, useProviderParamAsName: true });
};
