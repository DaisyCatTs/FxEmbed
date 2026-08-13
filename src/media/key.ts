import { importMediaSigningKey } from './token';

/**
 * The media signing key, imported once per isolate.
 *
 * `crypto.subtle.importKey` is cheap but not free, and a media-heavy embed mints one token per
 * video variant, so importing per request would be pure waste. The secret is the same for every
 * request an isolate serves — it is a Wrangler secret, not request data — so caching it is safe.
 *
 * It is deliberately *not* read from `.env`: the build inlines `.env` values into the bundle, and a
 * signing key that ships inside the artefact is not a secret at all. It arrives as
 * `MEDIA_SIGNING_KEY` on the Worker's env binding.
 */

let cachedSecret: string | null = null;
let cachedKey: Promise<CryptoKey> | null = null;

/**
 * Resolve the key for a request's env, caching it for the isolate.
 *
 * Returns null when no secret is configured, which callers must treat as "signing is unavailable"
 * — never as "sign with nothing".
 */
export const mediaSigningKey = (secret: string | undefined): Promise<CryptoKey> | null => {
  const trimmed = secret?.trim();
  if (!trimmed) {
    return null;
  }

  if (cachedSecret !== trimmed) {
    cachedSecret = trimmed;
    cachedKey = importMediaSigningKey(trimmed);
  }

  return cachedKey;
};

/**
 * The key remembered from an earlier request in this isolate.
 *
 * Minting happens deep inside the provider processors, which are handed a post id and a base URL
 * and never see the Worker env. Rather than thread the binding through every provider signature,
 * the request pipeline primes this on the way in (see `worker.ts`) and minting reads it back.
 * There is no cross-request leakage in that: the value is deployment-wide configuration, identical
 * for every request the isolate will ever serve.
 */
export const primedMediaSigningKey = (): Promise<CryptoKey> | null => cachedKey;
