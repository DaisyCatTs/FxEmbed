/**
 * The single outbound HTTP path for the whole codebase.
 *
 * Bare `fetch` is banned by lint (see eslint.config.mjs) because every one of the protections
 * below was missing somewhere before this existed: redirects were followed blindly to whatever
 * host they named, responses were read with no size limit, and several calls had no timeout at
 * all. Centralising them means a new provider gets all of it by default rather than by remembering.
 */
import { checkUrl, type HostPolicy, type UrlRejectionReason } from './host-validation.js';
import { ANY_PUBLIC_HOST } from './policies.js';

export type NetErrorKind = 'blocked' | 'too_many_redirects' | 'response_too_large' | 'timeout';

export class NetError extends Error {
  readonly kind: NetErrorKind;
  /** Set when `kind` is `blocked`, giving the specific validation failure. */
  readonly reason?: UrlRejectionReason;

  constructor(kind: NetErrorKind, message: string, reason?: UrlRejectionReason) {
    super(message);
    this.name = 'NetError';
    this.kind = kind;
    this.reason = reason;
  }
}

export const NET_DEFAULTS = {
  /**
   * Time allowed to receive response *headers*, redirects included. Body streaming is not bounded
   * by this — a 64 MB video legitimately takes longer than any sane header timeout, and aborting
   * mid-stream would truncate it. Body size is bounded by `maxBytes` instead.
   */
  timeoutMs: 8_000,
  /**
   * Providers previously used the platform default of 20 hops. Login walls and CDN edges routinely
   * chain three or four, so this is generous enough for real traffic while still cutting off a
   * loop.
   */
  maxRedirects: 5,
  /** Metadata responses (JSON, HTML) are small; anything larger is a decompression bomb. */
  maxJsonBytes: 8 * 1024 * 1024,
  /** Media streams. */
  maxMediaBytes: 64 * 1024 * 1024
} as const;

export type GuardedFetchOptions = {
  /** Which hosts this request may reach. Required — there is no permissive default. */
  hostPolicy: HostPolicy;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  /**
   * `follow` (default) re-validates and follows each hop. `manual` returns the redirect response
   * untouched, for callers that only want the `Location` header. Mirrors `RequestInit.redirect`,
   * except that `follow` here means "follow safely" rather than "hand control to the remote host".
   */
  redirect?: 'follow' | 'manual';
  /** Caller signal, combined with the internal timeout. */
  signal?: AbortSignal;
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Enforce a byte ceiling on a response body.
 *
 * `Content-Length` is a claim by the remote server, so it is never trusted; the only reliable
 * limit is counting bytes as they arrive and erroring the stream. Because this wraps the body
 * rather than buffering it, an oversized response is cut off mid-flight instead of being read
 * into memory first — which matters on a Worker with a hard memory cap.
 */
const capBody = (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): ReadableStream<Uint8Array> | null => {
  if (!body) {
    return null;
  }

  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            new NetError('response_too_large', `Response exceeded ${maxBytes} bytes`)
          );
          return;
        }
        controller.enqueue(chunk);
      }
    })
  );
};

const withCappedBody = (response: Response, maxBytes: number, finalUrl: string): Response => {
  const capped = new Response(capBody(response.body, maxBytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });

  /* `Response.url` is a read-only accessor that a constructed Response reports as the empty
     string. Callers use it to learn where they actually ended up — TikTok parses a video id out
     of it, and Instagram uses it to detect the login wall — so without this a wrapped response
     silently loses that, and Instagram would parse a login page as a post. */
  Object.defineProperty(capped, 'url', { value: finalUrl, enumerable: true });
  Object.defineProperty(capped, 'redirected', { value: response.redirected, enumerable: true });

  return capped;
};

/**
 * Fetch a URL with SSRF, redirect, timeout and size protections.
 *
 * Redirects are followed manually so that every hop is re-validated against the same policy as
 * the original URL. Following them automatically would let a permitted host bounce us to any
 * address it liked, which is the redirect-based SSRF this is here to prevent.
 *
 * @throws {NetError} on a blocked URL, redirect overflow, timeout, or transport failure. An
 *   oversized body surfaces later, when the stream is read.
 */
export const guardedFetch = async (
  input: string | URL | Request,
  init: RequestInit = {},
  options: GuardedFetchOptions
): Promise<Response> => {
  const {
    hostPolicy,
    timeoutMs = NET_DEFAULTS.timeoutMs,
    maxRedirects = NET_DEFAULTS.maxRedirects,
    maxBytes = NET_DEFAULTS.maxJsonBytes,
    redirect = 'follow',
    signal
  } = options;

  /* A Request already carries method, headers and body, so keep it and only swap the URL when
     following a redirect. */
  const sourceRequest = input instanceof Request ? input : null;
  const initial = checkUrl(sourceRequest ? sourceRequest.url : (input as string | URL), hostPolicy);
  if (!initial.ok) {
    throw new NetError(
      'blocked',
      `Refused to fetch ${initial.detail} (${initial.reason})`,
      initial.reason
    );
  }

  /* One budget covering every redirect hop, cancelled as soon as the final headers arrive so the
     body can stream for as long as it needs. `AbortSignal.timeout` cannot be cancelled, hence the
     manual controller. */
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  let target = initial.url;

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let response: Response;
      try {
        /* Pass the href rather than the URL object: that is what every caller previously handed to
           `fetch`, and what test doubles are written against. */
        response = sourceRequest
          ? await fetch(new Request(target.href, sourceRequest), {
              redirect: 'manual',
              signal: combined
            })
          : await fetch(target.href, { ...init, redirect: 'manual', signal: combined });
      } catch (cause) {
        if (timedOut) {
          throw new NetError(
            'timeout',
            `Request to ${target.hostname} timed out after ${timeoutMs}ms`
          );
        }

        /* Rethrow untouched. Callers branch on the error: `withTimeout` retries only on
           `AbortError`, and the Bluesky client treats an abort as grounds for falling back to an
           authenticated PDS. Wrapping it in a NetError silently disabled both. */
        throw cause;
      }

      if (redirect === 'manual' || !REDIRECT_STATUSES.has(response.status)) {
        return withCappedBody(response, maxBytes, target.href);
      }

      const location = response.headers.get('location');
      if (!location) {
        /* A redirect status with nowhere to go. Hand it back rather than inventing a target. */
        return withCappedBody(response, maxBytes, target.href);
      }

      const next = checkUrl(location, hostPolicy, target);
      if (!next.ok) {
        throw new NetError(
          'blocked',
          `Refused to follow redirect from ${target.hostname} to ${next.detail} (${next.reason})`,
          next.reason
        );
      }

      target = next.url;
    }

    throw new NetError('too_many_redirects', `Exceeded ${maxRedirects} redirects`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A drop-in `fetch` replacement restricted to public hosts.
 *
 * For the parts of the codebase that take a `fetchImpl: typeof fetch` parameter — the Bluesky
 * OAuth stack resolves handles and DIDs against hosts it cannot know in advance — this is the
 * safe default. Callers can still inject their own implementation for tests.
 */
export const publicGuardedFetch: typeof fetch = (input, init) =>
  guardedFetch(input as string | URL | Request, init ?? {}, { hostPolicy: ANY_PUBLIC_HOST });

/**
 * Read a response body as text, enforcing a byte ceiling.
 *
 * `guardedFetch` already caps the stream; this is for the callers that need a tighter limit than
 * the transfer default, and it makes the limit visible at the point the body is consumed.
 */
export const readTextCapped = async (
  response: Response,
  maxBytes = NET_DEFAULTS.maxJsonBytes
): Promise<string> => {
  const capped = capBody(response.body, maxBytes);
  if (!capped) {
    return '';
  }
  return await new Response(capped).text();
};

/**
 * Resolve a short link to its target without following it.
 *
 * Returns the validated destination, or null if the response was not a redirect or named a
 * destination the policy rejects. Used for `t.co` and `vm.tiktok.com` expansion, where we want
 * the target URL but must never actually fetch whatever it points at.
 */
export const resolveRedirectTarget = async (
  input: string | URL,
  init: RequestInit,
  options: GuardedFetchOptions & {
    /**
     * Policy for the destination, which is usually broader than the policy for the shortener
     * itself: we may only fetch `t.co`, but it can legitimately point anywhere public. Defaults
     * to `hostPolicy`.
     */
    targetPolicy?: HostPolicy;
  }
): Promise<URL | null> => {
  const response = await guardedFetch(input, init, { ...options, redirect: 'manual' });

  if (!REDIRECT_STATUSES.has(response.status)) {
    return null;
  }

  const location = response.headers.get('location');
  if (!location) {
    return null;
  }

  const next = checkUrl(
    location,
    options.targetPolicy ?? options.hostPolicy,
    new URL(String(input))
  );
  return next.ok ? next.url : null;
};
