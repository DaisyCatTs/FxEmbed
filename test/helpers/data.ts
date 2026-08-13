export const botHeaders = { 'User-Agent': 'Discordbot/2.0' };
export const humanHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
};
export const twitterBaseUrl = process.env.TWITTER_ROOT || 'https://x.com';

/**
 * Branding is deployment-specific: `branding.json` is gitignored, and the build copies
 * `branding.example.json` over it when absent. CI therefore sees the upstream FxEmbed names while
 * a real checkout sees whatever that operator configured.
 *
 * Tests that touch branding must read the same config the worker does, rather than hardcoding
 * either set of values — otherwise they pass in one environment and fail in the other.
 */
import branding from '../../branding.json';

type BrandingZone = {
  name: string;
  domains: string[];
  redirect: string;
  default?: boolean;
};

const zones = branding.zones as BrandingZone[];

/** The zone the worker will pick for a hostname, matching `src/helpers/branding.ts`. */
export const brandingFor = (hostname: string): BrandingZone => {
  const domain = hostname.split('.').slice(-2).join('.');
  return (
    zones.find(zone => zone.domains.includes(domain)) ?? zones.find(z => z.default) ?? zones[0]
  );
};
