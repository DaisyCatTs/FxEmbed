import { Hono } from 'hono';
import { trimTrailingSlash } from 'hono/trailing-slash';
import { getBranding } from '../../helpers/branding';
import { activityRequest } from './routes/activity';
import { threadsPostRequest } from './routes/post';
import { oembed } from './routes/oembed';
import { versionRoute } from '../common/version';

/**
 * Threads realm.
 *
 * The mirror shape is `/@handle/post/:code` — the pasted permalink with the domain swapped. TikTok
 * already owns `/@handle/video/:id`, which is why the literal `post` segment is what separates
 * them. `/_/threads/…` reaches the same routes explicitly.
 */
export const threads = new Hono();
threads.use(trimTrailingSlash());

threads.get('/owoembed', oembed);
threads.get('/api/v1/statuses/:snowcode', activityRequest);
threads.get('/version', c => versionRoute(c));

threads.get('/:handle/post/:code', threadsPostRequest);
/* Author-less forms: Threads' own short link, and the bare code under the explicit prefix. */
threads.get('/post/:code', threadsPostRequest);
threads.get('/t/:code', threadsPostRequest);

threads.all('*', async c => c.redirect(getBranding(c).redirect, 302));
