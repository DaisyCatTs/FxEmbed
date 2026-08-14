import { Context } from 'hono';
import { getBranding } from '../../../helpers/branding';
import { oembedResponse } from '../../../render/oembed';
import { assertSafeMastodonDomain } from '@fxembed/atmosphere/providers/mastodon/client';

/**
 * Turn a fediverse acct (`user@instance`) into that account's profile URL.
 *
 * The acct arrives as a query parameter, so the instance half is untrusted even though nothing is
 * fetched from it here — a link we hand a client should still point at a real host. The check is
 * the same `assertSafeMastodonDomain` used everywhere else rather than a looser local one.
 */
const profileUrlFromAcct = (acct: string): string | null => {
  const at = acct.lastIndexOf('@');
  if (at <= 0) {
    return null;
  }
  const user = acct.slice(0, at);
  try {
    return `https://${assertSafeMastodonDomain(acct.slice(at + 1))}/@${encodeURIComponent(user)}`;
  } catch {
    return null;
  }
};

export const oembed = async (c: Context) => {
  const { searchParams } = new URL(c.req.url);

  const text = searchParams.get('text') ?? '';
  const author = searchParams.get('author') ?? '';

  /* Unlike every other provider there is no single web root to fall back on — a fediverse account
     only exists on its own instance — so an unusable acct falls back to the branding redirect. */
  const authorUrl = profileUrlFromAcct(author) ?? getBranding(c).redirect;

  return oembedResponse(c, { text, authorUrl });
};
