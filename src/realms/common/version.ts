import { Context } from 'hono';
import { Constants } from '../../constants';
import { interpolate, Strings } from '../../strings';
import { escapeAttr } from '../../render/html';
import { getBranding } from '../../helpers/branding';
import { formatRuntime } from '../../helpers/runtime';

export const versionRoute = async (c: Context) => {
  c.header('cache-control', 'max-age=0, no-cache, no-store, must-revalidate');
  const req = c.req;
  const cf = req.raw.cf;
  const brandingName = getBranding(c).name;
  const runtime = formatRuntime();

  if (!cf) {
    return c.html(
      interpolate(Strings.VERSION_HTML, {
        brandingName,
        /* Same reasoning as the x-powered-by header: publish the build, not the branch name. */
        ogDescription: `Build ${Constants.PUBLIC_VERSION} (${runtime})`,
        statsBody: '',
        runtime
      })
    );
  }

  /* Every one of these is substituted into VERSION_HTML, which lands them both in an
     og:description content="..." and in the page body. `ip` comes straight off a request header
     and `ua` off the User-Agent, so all of them are escaped here rather than only the UA. */
  const rawNerdFields: Record<string, string> = {
    runtime,
    rtt: cf.clientTcpRtt ? `🏓 ${cf.clientTcpRtt} ms RTT` : '',
    colo: (cf.colo as string) ?? '??',
    httpversion: (cf.httpProtocol as string) ?? 'Unknown HTTP Version',
    tlsversion: (cf.tlsVersion as string) ?? 'Unknown TLS Version',
    ip: req.header('x-real-ip') ?? req.header('cf-connecting-ip') ?? 'Unknown IP',
    city: (cf.city as string) ?? 'Unknown City',
    region: (cf.region as string) ?? (cf.country as string) ?? 'Unknown Region',
    country: (cf.country as string) ?? 'Unknown Country',
    asn: `AS${cf.asn ?? '??'} (${cf.asOrganization ?? 'Unknown ASN'})`,
    ua: req.header('user-agent') ?? 'Unknown User Agent'
  };
  const nerdFields = Object.fromEntries(
    Object.entries(rawNerdFields).map(([key, value]) => [key, escapeAttr(value)])
  );

  return c.html(
    interpolate(Strings.VERSION_HTML, {
      brandingName,
      ogDescription: interpolate(Strings.VERSION_OG_DESCRIPTION_NERDS, nerdFields),
      statsBody: interpolate(Strings.VERSION_STATS_BODY, nerdFields),
      runtime
    })
  );
};
