import { Context } from 'hono';
import { oembedResponse } from '../../../render/oembed';
import { THREADS_WEB_ROOT } from '../../../providers/threads/web';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';
  const status = searchParams.get('status') ?? '';

  const statusUrl = `${THREADS_WEB_ROOT}/t/${encodeURIComponent(status)}`;

  return oembedResponse(c, {
    text,
    authorUrl: author
      ? `${THREADS_WEB_ROOT}/@${encodeURIComponent(author.replace(/^@/, ''))}/`
      : statusUrl,
    providerUrl: statusUrl
  });
};
