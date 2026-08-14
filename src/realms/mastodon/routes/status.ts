import { Context } from 'hono';
import { handleStatus, returnError } from '../../../embed/status';
import { DataProvider } from '../../../enum';
import { Constants } from '../../../constants';
import { Strings } from '../../../strings';
import { InputFlags } from '../../../types/types';
import { assertSafeMastodonDomain } from '@fxembed/atmosphere/providers/mastodon/client';
import { constructMastodonThread } from '@fxembed/atmosphere/providers/mastodon/conversation';
import { mastodonBuildHostFromContext } from '../../../providers/mastodon/build-host-adapter';

/**
 * Mastodon is the only provider whose upstream host is supplied by the person pasting the link,
 * which makes this route the sharpest SSRF edge in the worker.
 *
 * The host is therefore run through `assertSafeMastodonDomain` — the same validator the client
 * uses on every outbound request — *before* anything else happens, so a bad instance is refused
 * here rather than deep inside a fetch. That is one validator used twice, not two validators:
 * this call exists to fail early and does not replace, weaken, or duplicate the check in
 * `packages/atmosphere/src/providers/mastodon/client.ts`.
 */
const safeInstance = (domain: string): string | null => {
  try {
    return assertSafeMastodonDomain(domain);
  } catch {
    return null;
  }
};

/** Strip the leading `@` off the optional handle segment of a pasted Mastodon permalink. */
const bareHandle = (handle: string | undefined): string | null => {
  const trimmed = (handle ?? '').replace(/^@/, '');
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Where a human who clicked this link should land.
 *
 * With the handle in the path — the shape you get by pasting a permalink — the destination is
 * known without asking the instance anything. Without it, only the instance can say which account
 * owns the status, so we ask, and fall back to the instance root if it will not tell us.
 */
const resolveDestination = async (
  c: Context,
  instance: string,
  id: string,
  handle: string | null
): Promise<string> => {
  if (handle) {
    return `https://${instance}/@${encodeURIComponent(handle)}/${encodeURIComponent(id)}`;
  }

  try {
    const resolved = await constructMastodonThread(
      id,
      instance,
      false,
      mastodonBuildHostFromContext(c),
      undefined
    );
    const url = resolved.status?.url;
    if (typeof url === 'string' && url.startsWith('https://')) {
      return url;
    }
  } catch (e) {
    console.log('could not resolve Mastodon permalink for redirect', e);
  }

  return `https://${instance}/`;
};

export const mastodonStatusRequest = async (c: Context) => {
  const { domain, handle, id } = c.req.param();

  const instance = safeInstance(domain ?? '');
  if (!instance) {
    /* No fetch has happened and none will: the instance never became a URL. */
    console.log('rejected Mastodon instance before any fetch');
    return returnError(c, Strings.ERROR_MASTODON_BAD_INSTANCE);
  }

  const statusId = (id ?? '').replace(/\.(mp4|png|jpe?g|gifv?)$/i, '');
  if (!statusId) {
    return c.text(Strings.ERROR_UNKNOWN, 404);
  }

  const userAgent = c.req.header('User-Agent') || '';
  const url = new URL(c.req.url);
  const flags: InputFlags = {};

  const isBotUA = userAgent.match(Constants.BOT_UA_REGEX) !== null || flags?.archive;

  if (/\.(mp4|png|jpe?g|gifv?)$/i.test(id ?? '')) {
    console.log('Direct media request by extension');
    flags.direct = true;
  } else if (Constants.DIRECT_MEDIA_DOMAINS.includes(url.hostname)) {
    console.log('Direct media request by domain');
    flags.direct = true;
  } else if (Constants.TEXT_ONLY_DOMAINS.includes(url.hostname)) {
    console.log('Text-only embed request');
    flags.textOnly = true;
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

  if (!isBotUA && !flags.direct) {
    console.log('Matched human UA', userAgent);
    return c.redirect(await resolveDestination(c, instance, statusId, bareHandle(handle)), 302);
  }

  const statusResponse = await handleStatus(
    c,
    statusId,
    /* `authorHandle` carries the instance for Mastodon, the way it carries the author DID for
       Bluesky: it is the second identifier the provider needs to resolve a status. */
    instance,
    undefined,
    userAgent,
    flags,
    undefined,
    DataProvider.Mastodon
  );

  if (!statusResponse) {
    /* handleStatus always returns something; this is the belt to its braces. */
    return c.text(Strings.ERROR_UNKNOWN, 500);
  }

  c.status(200);
  return statusResponse;
};
