import { Context } from 'hono';
import { Strings } from '../../../strings';
import { getBranding } from '../../../helpers/branding';
import { OEmbed } from '../../../types/types';
import { THREADS_WEB_ROOT } from '../../../providers/threads/web';

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';
  const status = searchParams.get('status') ?? '';

  const statusUrl = `${THREADS_WEB_ROOT}/t/${encodeURIComponent(status)}`;
  const branding = getBranding(c);

  const data: OEmbed = {
    author_name: text,
    author_url: author
      ? `${THREADS_WEB_ROOT}/@${encodeURIComponent(author.replace(/^@/, ''))}/`
      : statusUrl,
    provider_name: branding.name,
    provider_url: searchParams.get('provider') ? statusUrl : branding.redirect,
    title: Strings.DEFAULT_AUTHOR_TEXT,
    type: 'rich',
    version: '1.0'
  };

  return c.json(data, 200);
};
