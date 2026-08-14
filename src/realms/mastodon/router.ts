import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { getBranding } from '../../helpers/branding';
import { activityRequest } from './routes/activity';
import { mastodonStatusRequest } from './routes/status';
import { oembed } from './routes/oembed';
import { versionRoute } from '../common/version';

/**
 * Mastodon realm.
 *
 * `src/routing/identify.ts` hands this router a path with the `/mastodon` introducer already
 * stripped, so both the bare form (`/mastodon/mastodon.social/109…`) and the explicit one
 * (`/_/mastodon/mastodon.social/109…`) arrive here as `/mastodon.social/109…`.
 */
export const mastodon = new Hono();
mastodon.use(trimTrailingSlash());

mastodon.get('/owoembed', oembed);
mastodon.get('/api/v1/statuses/:snowcode', activityRequest);
mastodon.get('/version', c => versionRoute(c));

/* `/:instance/@user/:id` is the pasted permalink with the instance moved to the front; the
   two-segment form is the same status without the author, which the instance can still resolve. */
mastodon.get('/:domain/:handle/:id', mastodonStatusRequest);
mastodon.get('/:domain/:id', mastodonStatusRequest);

mastodon.all('*', async c => c.redirect(getBranding(c).redirect, 302));
