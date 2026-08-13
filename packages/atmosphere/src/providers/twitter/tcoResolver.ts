import { generateUserAgent } from '../../helpers/user-agent.js';
import { guardedFetch, NetPolicies, readTextCapped } from '../../net/index.js';

const TCO_TIMEOUT_MS = 3_000;
/** t.co answers with a tiny meta-refresh stub; a larger body is not something we should read. */
const TCO_MAX_BYTES = 64 * 1024;

/**
 * Validate an expanded link for *display*.
 *
 * This URL is rendered as an href and never fetched, so the bar is only that it cannot be a
 * script-bearing scheme. Plain `http://` targets are legitimate and common on older links, so the
 * https-only rule that applies to outbound requests would wrongly drop them and leave the raw
 * `t.co` URL showing instead.
 */
const asDisplayUrl = (candidate: string): string | null => {
  const parsed = URL.parse(candidate);
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return null;
  }
  /* Credentials in a displayed link are a phishing aid and never legitimate here. */
  return parsed.username || parsed.password ? null : parsed.href;
};

/**
 * Expand t.co short links to their destinations.
 *
 * Two things matter here beyond the fetch itself:
 *
 *  - We only ever talk to t.co. Previously this followed redirects automatically, so the final
 *    request went to whatever host the shortener named.
 *  - The expanded URL is rendered back into the embed as a link, so it is validated before being
 *    returned. Without that, a destination like `javascript:` would be written into an href.
 *    Anything that fails validation falls back to the original t.co URL, which is always safe.
 */
export const tcoResolver = async (links: string[]): Promise<Record<string, string>> => {
  const [userAgent, secChUa] = generateUserAgent();
  const resolvedLinks: Record<string, string> = {};
  const startTime = performance.now();

  await Promise.all(
    links.map(async link => {
      if (!link.match(/https?:\/\/t\.co\/\w+/g)) {
        resolvedLinks[link] = link;
        return;
      }

      try {
        const response = await guardedFetch(
          link,
          { headers: { 'User-Agent': userAgent, 'sec-ch-ua': secChUa } },
          {
            hostPolicy: NetPolicies.twitterShortener,
            redirect: 'manual',
            timeoutMs: TCO_TIMEOUT_MS,
            maxBytes: TCO_MAX_BYTES
          }
        );

        /* t.co answers either with a real redirect or with a meta-refresh page. */
        const destination =
          response.headers.get('location') ??
          (await readTextCapped(response, TCO_MAX_BYTES)).match(
            /(?<=content="0;url=)https?:\/\/.*?(?=">)/i
          )?.[0];

        resolvedLinks[link] = (destination && asDisplayUrl(destination)) || link;
      } catch (error) {
        console.error('Error resolving t.co link:', error);
        resolvedLinks[link] = link;
      }
    })
  );

  const endTime = performance.now();
  console.log(
    `Resolved ${Object.keys(resolvedLinks).length} t.co links in ${endTime - startTime}ms`
  );
  return resolvedLinks;
};
