import { getMastodonProviderEnv } from '../mastodon-runtime.js';
import {
  allowHosts,
  ANY_PUBLIC_HOST,
  checkUrl,
  guardedFetch,
  NetError,
  normalizeHostname,
  readTextCapped
} from '../../net/index.js';

const DEFAULT_TIMEOUT_MS = 12_000;
/** Instance API responses are JSON documents; a larger body is not something we should read. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Validate a Mastodon instance hostname.
 *
 * This is the one provider whose host comes straight from the request path and cannot be
 * allowlisted — any instance on the fediverse is legitimate. That makes it the sharpest SSRF edge
 * in the codebase, so the check is the full URL validator rather than a syntax test.
 *
 * The previous version only rejected slashes, backslashes, `..` and characters outside
 * `[a-z0-9.-]`, which accepted `localhost`, `127.0.0.1` and `169.254.169.254` — every address
 * an SSRF is actually aimed at.
 */
export const assertSafeMastodonDomain = (domain: string): string => {
  const d = domain.trim().toLowerCase();
  if (!d || d.length > 253) {
    throw new Error('invalid_domain');
  }

  /* Must be a bare hostname. Without this, `evil.example/../admin` or `user:pass@evil.example`
     parse into a perfectly valid URL whose hostname is fine, and we would silently accept input
     that was never a hostname at all. */
  if (/[/\\?#@:\s]/.test(d)) {
    throw new Error('invalid_domain');
  }

  const checked = checkUrl(`https://${d}/`, ANY_PUBLIC_HOST);
  if (!checked.ok) {
    throw new Error('invalid_domain');
  }

  /* Return the normalised host (lowercased, punycoded, no trailing root label) so that everything
     downstream — URL building and the allowlist the fetch is pinned to — compares the same
     string. `mastodon.social.` and `mastodon.social` are the same host to DNS but not to
     `endsWith`. */
  return normalizeHostname(checked.url.hostname);
};

const instanceBase = (domain: string): string => `https://${assertSafeMastodonDomain(domain)}`;

export type MastodonFetchOk<T> = { ok: true; data: T; link: string | null };
export type MastodonFetchErr = { ok: false; status: number; body: string };
export type MastodonFetchResult<T> = MastodonFetchOk<T> | MastodonFetchErr;

async function mastodonFetch<T>(
  domain: string,
  path: string,
  searchParams: Record<string, string | number | boolean | undefined>
): Promise<MastodonFetchResult<T>> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined) continue;
    qs.set(k, String(v));
  }

  let res: Response;
  try {
    const expectedHost = assertSafeMastodonDomain(domain);
    const url = `${instanceBase(domain)}${path}${qs.size ? `?${qs.toString()}` : ''}`;

    /* Pin the policy to this one instance. Redirects are then allowed for the canonical-URL and
       trailing-slash hops an instance legitimately uses, but a redirect to any other host is
       refused by the guard rather than by a check we have to remember to write here. */
    res = await guardedFetch(
      url,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': getMastodonProviderEnv().userAgent
        }
      },
      {
        hostPolicy: allowHosts(expectedHost),
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /* A blocked host is a bad request, not an upstream timeout. */
    const status = e instanceof NetError && e.kind === 'blocked' ? 400 : 504;
    return { ok: false, status, body: msg };
  }

  const link = res.headers.get('Link');
  if (!res.ok) {
    const body = await readTextCapped(res, MAX_RESPONSE_BYTES);
    return { ok: false, status: res.status, body };
  }
  try {
    const data = (await res.json()) as T;
    return { ok: true, data, link };
  } catch {
    return { ok: false, status: 502, body: 'invalid JSON from Mastodon' };
  }
}

/** Extract `max_id` from the `rel="next"` URL in a Mastodon `Link` header */
export const nextMaxIdFromLinkHeader = (linkHeader: string | null): string | null => {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (!m?.[1]) continue;
    try {
      const u = new URL(m[1]);
      const maxId = u.searchParams.get('max_id');
      if (maxId) return maxId;
    } catch {
      /* ignore */
    }
  }
  return null;
};

export const fetchStatus = async (
  domain: string,
  id: string
): Promise<MastodonFetchResult<MastodonStatus>> =>
  mastodonFetch<MastodonStatus>(domain, `/api/v1/statuses/${encodeURIComponent(id)}`, {});

export const fetchStatusContext = async (
  domain: string,
  id: string
): Promise<MastodonFetchResult<MastodonContext>> =>
  mastodonFetch<MastodonContext>(domain, `/api/v1/statuses/${encodeURIComponent(id)}/context`, {});

export const fetchFavouritedBy = async (
  domain: string,
  id: string,
  params: { limit: number; max_id?: string }
): Promise<MastodonFetchResult<MastodonAccount[]>> =>
  mastodonFetch<MastodonAccount[]>(
    domain,
    `/api/v1/statuses/${encodeURIComponent(id)}/favourited_by`,
    { limit: params.limit, max_id: params.max_id }
  );

export const fetchRebloggedBy = async (
  domain: string,
  id: string,
  params: { limit: number; max_id?: string }
): Promise<MastodonFetchResult<MastodonAccount[]>> =>
  mastodonFetch<MastodonAccount[]>(
    domain,
    `/api/v1/statuses/${encodeURIComponent(id)}/reblogged_by`,
    { limit: params.limit, max_id: params.max_id }
  );

export const lookupAccount = async (
  domain: string,
  acct: string
): Promise<MastodonFetchResult<MastodonAccount>> =>
  mastodonFetch<MastodonAccount>(domain, '/api/v1/accounts/lookup', { acct });

export const fetchAccount = async (
  domain: string,
  accountId: string
): Promise<MastodonFetchResult<MastodonAccount>> =>
  mastodonFetch<MastodonAccount>(domain, `/api/v1/accounts/${encodeURIComponent(accountId)}`, {});

export const fetchAccountStatuses = async (
  domain: string,
  accountId: string,
  params: {
    limit: number;
    max_id?: string;
    only_media?: boolean;
    exclude_replies?: boolean;
  }
): Promise<MastodonFetchResult<MastodonStatus[]>> =>
  mastodonFetch<MastodonStatus[]>(
    domain,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses`,
    {
      limit: params.limit,
      max_id: params.max_id,
      only_media: params.only_media === true ? true : undefined,
      exclude_replies: params.exclude_replies === true ? true : undefined
    }
  );

export const fetchAccountFollowers = async (
  domain: string,
  accountId: string,
  params: { limit: number; max_id?: string }
): Promise<MastodonFetchResult<MastodonAccount[]>> =>
  mastodonFetch<MastodonAccount[]>(
    domain,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/followers`,
    { limit: params.limit, max_id: params.max_id }
  );

export const fetchAccountFollowing = async (
  domain: string,
  accountId: string,
  params: { limit: number; max_id?: string }
): Promise<MastodonFetchResult<MastodonAccount[]>> =>
  mastodonFetch<MastodonAccount[]>(
    domain,
    `/api/v1/accounts/${encodeURIComponent(accountId)}/following`,
    { limit: params.limit, max_id: params.max_id }
  );

export const searchStatuses = async (
  domain: string,
  q: string,
  params: { limit: number; offset?: number; max_id?: string; min_id?: string }
): Promise<MastodonFetchResult<MastodonSearchResponse>> =>
  mastodonFetch<MastodonSearchResponse>(domain, '/api/v2/search', {
    q,
    type: 'statuses',
    resolve: false,
    limit: params.limit,
    offset: params.offset,
    max_id: params.max_id,
    min_id: params.min_id
  });
