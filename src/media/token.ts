import { checkUrl, type HostPolicy } from '@fxembed/atmosphere/net';

/**
 * Signed media tokens.
 *
 * The media endpoint fetches a remote URL and streams it back. Taking that URL from a query
 * parameter — which is what the TikTok proxy did — makes the Worker an open proxy: anyone can
 * point it anywhere the allowlist happens to permit, and any allowlist mistake becomes directly
 * exploitable. Instead the URL is minted by us, signed, and handed out inside the embed.
 *
 * Three independent gates, all of which must pass:
 *
 *  1. **Signature** — only URLs this Worker produced can be fetched, so there is no
 *     attacker-controlled `?url=` at all.
 *  2. **Allowlist, re-checked at request time** — a signature proves we minted it, not that it is
 *     still acceptable. Re-validating means tightening the allowlist retroactively invalidates
 *     tokens already in the wild.
 *  3. **Expiry** — bounds replay, and matches the fact that provider CDN URLs expire anyway.
 */

/** Payload kept short because it travels in a URL path. */
export type MediaTokenPayload = {
  /** Provider id, selecting the allowlist and the outbound header profile. */
  p: string;
  /** Upstream URL to fetch. */
  u: string;
  /** `r` = redirect to it, `s` = stream it through us. */
  m: 'r' | 's';
  /** Expiry, unix seconds. */
  x: number;
  /**
   * Optional server-minted credential blob (e.g. the cookies TikTok's CDN requires).
   *
   * This is the reason the whole token is signed rather than just the URL: these previously rode
   * in a query parameter, which meant they were both caller-controllable on the way in and
   * publicly visible on the way out.
   */
  c?: string;
};

export type MediaTokenVerification =
  | { readonly ok: true; readonly payload: MediaTokenPayload; readonly url: URL }
  | { readonly ok: false; readonly reason: MediaTokenRejection };

export type MediaTokenRejection =
  'malformed' | 'bad_signature' | 'expired' | 'unknown_provider' | 'url_not_allowed';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array | null => {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
};

/**
 * Import a signing key.
 *
 * Kept separate so callers can import once per isolate rather than per request. A key shorter than
 * 32 bytes is rejected rather than silently accepted: a weak signing key defeats the entire scheme.
 */
export const importMediaSigningKey = async (secret: string): Promise<CryptoKey> => {
  const raw = encoder.encode(secret);
  if (raw.byteLength < 32) {
    throw new Error('MEDIA_SIGNING_KEY must be at least 32 bytes');
  }
  return await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify'
  ]);
};

/** Sign a payload, producing `<payload>.<signature>` in base64url. */
export const signMediaToken = async (
  payload: MediaTokenPayload,
  key: CryptoKey
): Promise<string> => {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
};

/**
 * Verify a token and re-validate its URL.
 *
 * @param policyFor maps a provider id to its host policy; returning null rejects the token, so an
 *   unknown or retired provider cannot be fetched even with a valid signature.
 * @param nowSeconds injectable so expiry is testable without waiting.
 */
export const verifyMediaToken = async (
  token: string,
  key: CryptoKey,
  policyFor: (provider: string) => HostPolicy | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<MediaTokenVerification> => {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return { ok: false, reason: 'malformed' };
  }

  const body = token.slice(0, separator);
  const signature = fromBase64Url(token.slice(separator + 1));
  if (!signature) {
    return { ok: false, reason: 'malformed' };
  }

  /* `crypto.subtle.verify` compares in constant time, so this must not be replaced with a
     string comparison of re-signed output. */
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(body));
  if (!valid) {
    return { ok: false, reason: 'bad_signature' };
  }

  const decoded = fromBase64Url(body);
  if (!decoded) {
    return { ok: false, reason: 'malformed' };
  }

  let payload: MediaTokenPayload;
  try {
    payload = JSON.parse(decoder.decode(decoded)) as MediaTokenPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (
    typeof payload?.u !== 'string' ||
    typeof payload?.p !== 'string' ||
    typeof payload?.x !== 'number' ||
    (payload.m !== 'r' && payload.m !== 's')
  ) {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.x <= nowSeconds) {
    return { ok: false, reason: 'expired' };
  }

  const policy = policyFor(payload.p);
  if (!policy) {
    return { ok: false, reason: 'unknown_provider' };
  }

  /* Gate 2: a valid signature is not authorisation. Re-check against the policy as it stands
     now, not as it stood when the token was minted. */
  const checked = checkUrl(payload.u, policy);
  if (!checked.ok) {
    return { ok: false, reason: 'url_not_allowed' };
  }

  return { ok: true, payload, url: checked.url };
};
