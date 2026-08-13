import { allowHosts, guardedFetch, readTextCapped } from '@fxembed/atmosphere/net';
import { Constants } from '../constants';

const HORIZON_HOST = new URL(Constants.HORIZON_WEB_ROOT).hostname;
const HORIZON_POLICY = allowHosts(HORIZON_HOST);

/** A rendered page; anything larger is not a page we should be relaying. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

/**
 * Fetch a page from the Horizon web frontend and return its HTML.
 *
 * The body is relayed to our own users, so it is fetched through the guard (pinned host, no
 * redirects off it, bounded time and size) rather than with a bare `fetch`. Path segments are
 * encoded by the caller-facing helpers below: they come from request parameters, and
 * interpolating them raw allowed a handle to alter the requested path.
 *
 * Returns null on any failure, so callers fall through to their normal rendering path.
 */
const fetchHorizonPage = async (path: string): Promise<string | null> => {
  try {
    const response = await guardedFetch(
      `${Constants.HORIZON_WEB_ROOT}${path}`,
      {},
      { hostPolicy: HORIZON_POLICY, timeoutMs: TIMEOUT_MS, maxBytes: MAX_PAGE_BYTES }
    );

    if (!response.ok) {
      return null;
    }

    const body = await readTextCapped(response, MAX_PAGE_BYTES);
    return body.includes('<!doctype html>') ? body : null;
  } catch (error) {
    console.error('Horizon web fetch failed', error);
    return null;
  }
};

/** Horizon page for a single status. */
export const fetchHorizonStatusPage = (handle: string, id: string): Promise<string | null> =>
  fetchHorizonPage(`/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`);

/** Horizon page for a profile. */
export const fetchHorizonProfilePage = (handle: string): Promise<string | null> =>
  fetchHorizonPage(`/${encodeURIComponent(handle)}`);

/**
 * Horizon page for an already-formed pathname.
 *
 * The pathname comes from `new URL(request.url).pathname`, which is already percent-encoded and
 * cannot contain a host or scheme, so it is passed through as-is.
 */
export const fetchHorizonPathPage = (pathname: string): Promise<string | null> =>
  fetchHorizonPage(pathname);
