import { Context } from 'hono';
import branding from '../../branding.json';

type ActivityIcon = {
  default: string;
  [key: string]: string;
};

type Branding = {
  name: string;
  domains: string[];
  provider: string;
  favicon: string;
  redirect: string;
  default?: boolean;
  color?: string;
  activityIcons?: ActivityIcon | ActivityIcon[];
};

/**
 * Branding zones, resolved once and frozen.
 *
 * `branding.json` is a module import, so every request sees the *same* objects. The previous
 * implementation assigned to the zone it selected in order to apply `?brandingName` and friends,
 * which mutated that shared object for the lifetime of the isolate: a single crafted request
 * rebranded every subsequent request the isolate served, including other people's. Freezing makes
 * that class of bug impossible rather than merely absent.
 *
 * The query-parameter override is gone with it. It sat behind an experiment that was set to 0%,
 * and it let a URL set the displayed name, icon and — via `brandingRedirectUrl` — the destination
 * of every fallback redirect, which is an open redirect wearing a costume.
 */
const zones: readonly Branding[] = Object.freeze(
  (branding.zones as Branding[]).map(zone => Object.freeze({ ...zone }))
);

const defaultBranding = zones.find(zone => zone.default) ?? zones[0];

export const getBranding = (c: Context | Request): Branding => {
  try {
    const url = new URL(c instanceof Request ? c.url : c.req.url);
    /* Match on the registrable part of the hostname so subdomain flags share a zone. */
    const domain = url.hostname.split('.').slice(-2).join('.');
    return zones.find(zone => zone.domains.includes(domain)) ?? defaultBranding;
  } catch (_e) {
    return defaultBranding;
  }
};
