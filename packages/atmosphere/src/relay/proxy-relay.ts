/**
 * Typed relay over another FxEmbed host’s `/2` JSON API (proxy-relay transport).
 * Prefer generating path types with `npm run openapi:atmosphere` at the repo root,
 * then wrapping calls with `openapi-fetch` against {@link createRelayFetch}.
 */
import { allowHosts, guardedFetch, normalizeHostname } from '../net/index.js';

export type RelayFetchOptions = {
  baseUrl: string;
  userAgent: string;
  apiKey?: string;
};

/** Returns a `fetch`-compatible function that prefixes `baseUrl` and adds UA / optional API key. */
export function createRelayFetch(opts: RelayFetchOptions): typeof fetch {
  const base = opts.baseUrl.replace(/\/$/, '');

  /* Pin the relay to the configured host. Previously an absolute URL passed by the caller
     bypassed `baseUrl` entirely, so a value that was only ever meant to select a path could
     redirect the whole request somewhere else. The Authorization header below makes that worse:
     an off-host request would have carried the operator's API key with it. */
  /* `createRelayFetch` has never thrown, and callers construct it eagerly. An unconfigured
     `baseUrl` is now realistic — the host lists in `.env.example` ship empty — so report it as a
     failed request rather than a constructor-time TypeError. */
  const relayOrigin = URL.parse(base);
  const hostPolicy = relayOrigin ? allowHosts(normalizeHostname(relayOrigin.hostname)) : null;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!hostPolicy) {
      throw new Error(`createRelayFetch: invalid baseUrl ${JSON.stringify(opts.baseUrl)}`);
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = url.startsWith('http') ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;
    const headers = new Headers(init?.headers);
    headers.set('User-Agent', opts.userAgent);
    if (opts.apiKey) headers.set('Authorization', `Bearer ${opts.apiKey}`);
    return guardedFetch(target, { ...init, headers }, { hostPolicy });
  };
}
