/**
 * Host and URL validation for outbound requests.
 *
 * Every URL we fetch is attacker-influenced to some degree: some come straight from a request
 * path, others are pulled out of JSON returned by a third party. Treat all of them as hostile and
 * validate here, in one place, with no I/O so it can be exhaustively unit-tested.
 *
 * This deliberately does NOT resolve DNS. A Worker cannot resolve a hostname before fetching it,
 * so a name that resolves to a private address (DNS rebinding) cannot be caught here. The
 * mitigation is the allowlist: for everything except genuinely open-ended providers we require a
 * known CDN or API host, and Cloudflare's egress does not route to our own private networks.
 */

/** Who a request is allowed to talk to. */
export type HostPolicy =
  /** Only these hosts, matched exactly or as a parent domain. */
  | { readonly mode: 'allowlist'; readonly hosts: readonly string[] }
  /**
   * Any public host. For providers where the host is inherently user-supplied and unbounded —
   * a Mastodon instance, a Bluesky PDS — an allowlist is impossible. Private, loopback,
   * link-local and reserved names are still rejected.
   */
  | { readonly mode: 'public' };

export type UrlRejectionReason =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'embedded_credentials'
  | 'port_not_allowed'
  | 'ip_literal'
  | 'reserved_hostname'
  | 'host_not_allowed';

export type UrlCheck =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: UrlRejectionReason; readonly detail: string };

/**
 * Suffixes that never name a public host. `.onion` is included because we have no Tor egress, so
 * such a request can only be an attempt to probe something.
 */
const RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'private',
  'corp',
  'home',
  'home.arpa',
  'lan',
  'onion',
  'test',
  'invalid',
  'in-addr.arpa',
  'ip6.arpa'
] as const;

/**
 * Normalise a hostname for comparison.
 *
 * The trailing dot matters: `pbs.twimg.com.` is the same host to DNS but does not match a naive
 * `endsWith('.twimg.com')` check, so without stripping it an allowlist can be walked straight
 * past. `URL` already lowercases and punycodes, but normalise again so this function is safe to
 * call on a raw string.
 */
export const normalizeHostname = (hostname: string): string => {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
};

/**
 * True if the hostname is an IP address literal rather than a name.
 *
 * Covers the encodings that bypass a naive dotted-quad regex: bare decimal (2130706433),
 * hexadecimal (0x7f000001), octal-prefixed octets (0177.0.0.1) and IPv6 (bracketed by `URL`).
 * The trick is that no real top-level domain is numeric, so an all-digit or hex final label means
 * the runtime will parse the host as an address.
 */
export const isIpLiteral = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);

  /* URL keeps IPv6 literals bracketed in `hostname`. */
  if (host.startsWith('[') || host.includes(':')) {
    return true;
  }

  const lastLabel = host.split('.').pop() ?? '';
  return /^\d+$/.test(lastLabel) || /^0x[0-9a-f]+$/.test(lastLabel);
};

/** True if the hostname is a reserved or non-routable name. */
export const isReservedHostname = (hostname: string): boolean => {
  const host = normalizeHostname(hostname);

  if (!host) {
    return true;
  }

  /* A public host is always dotted. A single label is an intranet name or a search-domain
     lookup, never something we mean to reach. */
  if (!host.includes('.')) {
    return true;
  }

  return RESERVED_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
};

/**
 * True if `hostname` is `allowed` or a subdomain of it.
 *
 * Anchored on a dot so `pbs.twimg.com.evil.com` does not match `twimg.com`, and substring
 * matching (`hostname.includes(allowed)`) is never used.
 */
export const matchesHost = (hostname: string, allowed: string): boolean => {
  const host = normalizeHostname(hostname);
  const suffix = normalizeHostname(allowed);
  return host === suffix || host.endsWith(`.${suffix}`);
};

/** True if `hostname` satisfies the policy. Assumes the host has already passed the checks above. */
export const isHostAllowed = (hostname: string, policy: HostPolicy): boolean =>
  policy.mode === 'public' ? true : policy.hosts.some(allowed => matchesHost(hostname, allowed));

/**
 * Validate a URL for outbound fetching.
 *
 * @param candidate absolute URL, or a relative one when `base` is given (for redirect Locations)
 * @param policy which hosts this request may reach
 * @param base resolved against, for relative redirect targets
 */
export const checkUrl = (candidate: string | URL, policy: HostPolicy, base?: URL): UrlCheck => {
  const url = candidate instanceof URL ? candidate : URL.parse(candidate, base?.href ?? undefined);

  if (!url) {
    return { ok: false, reason: 'invalid_url', detail: String(candidate) };
  }

  /* https only. `javascript:` and `data:` parse as perfectly valid URLs, so checking the scheme
     is not optional; plain http is refused so a redirect cannot silently downgrade us. */
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme_not_https', detail: url.protocol };
  }

  /* https://user:pass@host/ sends credentials we never intended, and is a classic way to make a
     URL read as one host while resolving to another. */
  if (url.username || url.password) {
    return { ok: false, reason: 'embedded_credentials', detail: url.hostname };
  }

  /* Non-standard ports are how internal services get reached. */
  if (url.port && url.port !== '443') {
    return { ok: false, reason: 'port_not_allowed', detail: url.port };
  }

  if (isIpLiteral(url.hostname)) {
    return { ok: false, reason: 'ip_literal', detail: url.hostname };
  }

  if (isReservedHostname(url.hostname)) {
    return { ok: false, reason: 'reserved_hostname', detail: url.hostname };
  }

  if (!isHostAllowed(url.hostname, policy)) {
    return { ok: false, reason: 'host_not_allowed', detail: url.hostname };
  }

  return { ok: true, url };
};
