import { Context } from 'hono';
import { handleStatus } from '../../../embed/status';
import { DataProvider } from '../../../enum';
import { Constants } from '../../../constants';
import { Experiment, experimentCheck } from '../../../experiments';
import { Strings } from '../../../strings';
import { InputFlags } from '../../../types/types';
import { THREADS_WEB_ROOT } from '../../../providers/threads/web';
import { normalizeThreadsPostId } from '@fxembed/atmosphere/providers/threads/shortcode';

export const threadsPostRequest = async (c: Context) => {
  const { handle, code } = c.req.param();

  /* Strip direct-media extensions (e.g. /@user/post/CODE.mp4) before normalizing. */
  const rawCode = (code ?? '').replace(/\.(mp4|png|jpe?g|gifv?)$/i, '');
  const shortcode = normalizeThreadsPostId(rawCode);
  if (!shortcode) {
    return c.text(Strings.ERROR_UNKNOWN, 404);
  }

  const userAgent = c.req.header('User-Agent') || '';
  const url = new URL(c.req.url);
  const flags: InputFlags = {};

  const isBotUA = userAgent.match(Constants.BOT_UA_REGEX) !== null || flags?.archive;

  if (/\.(mp4|png|jpe?g|gifv?)$/i.test(code ?? '')) {
    console.log('Direct media request by extension');
    flags.direct = true;
  } else if (Constants.DIRECT_MEDIA_DOMAINS.includes(url.hostname)) {
    console.log('Direct media request by domain');
    flags.direct = true;
  } else if (Constants.TEXT_ONLY_DOMAINS.includes(url.hostname)) {
    console.log('Text-only embed request');
    flags.textOnly = true;
  } else if (Constants.INSTANT_VIEW_DOMAINS.includes(url.hostname)) {
    console.log('Forced instant view request');
    flags.forceInstantView = true;
  } else if (
    experimentCheck(Experiment.IV_FORCE_THREAD_UNROLL, userAgent.includes('TelegramBot'))
  ) {
    console.log('Forced unroll instant view');
    flags.instantViewUnrollThreads = true;
  } else if (Constants.GALLERY_DOMAINS.includes(url.hostname)) {
    console.log('Gallery embed request');
    flags.gallery = true;
  } else if (Constants.FORCE_MOSAIC_DOMAINS.includes(url.hostname)) {
    console.log('Force mosaic');
    flags.forceMosaic = true;
  } else if (Constants.OLD_EMBED_DOMAINS.includes(url.hostname)) {
    console.log('Disable activity embed');
    flags.noActivity = true;
  }

  const bareHandle = (handle ?? '').replace(/^@/, '');
  /* Threads' own short link works without an author, so a code-only request still has somewhere
     honest to send a human. */
  const threadsUrl = bareHandle
    ? `${THREADS_WEB_ROOT}/@${encodeURIComponent(bareHandle)}/post/${encodeURIComponent(shortcode)}`
    : `${THREADS_WEB_ROOT}/t/${encodeURIComponent(shortcode)}`;

  if (!isBotUA && !flags.direct && !flags.api) {
    console.log('Matched human UA', userAgent);
    return c.redirect(threadsUrl, 302);
  }

  const statusResponse = await handleStatus(
    c,
    shortcode,
    bareHandle || null,
    undefined,
    userAgent,
    flags,
    undefined,
    DataProvider.Threads
  );

  if (!statusResponse) {
    return c.text(Strings.ERROR_UNKNOWN, 500);
  }

  c.status(200);
  return statusResponse;
};
