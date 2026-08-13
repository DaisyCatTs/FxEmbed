/**
 * Minting of signed media links.
 *
 * Providers know *which* URL needs delivering through the Worker; only the Worker holds the signing
 * key that makes such a URL fetchable. The worker registers an implementation at startup (see
 * `worker.ts`), the same way the Bluesky and Twitter proxy runtimes are registered.
 *
 * With no implementation registered — or with no signing key configured — minting returns null and
 * the caller keeps the upstream CDN URL. That is the honest fallback: an unsigned link to our own
 * media endpoint would be an open proxy, which is exactly what this replaced.
 */

export type MediaLinkRequest = {
  /** Provider id, selecting the allowlist and outbound header profile at fetch time. */
  provider: string;
  /** Upstream media URL. */
  url: string;
  /** Absolute origin the minted link must point at, e.g. `https://e.puppygirl.city`. */
  base: string;
  /** Credentials the provider's CDN needs, travelling inside the signed token rather than a query. */
  credentials?: string | null;
  /** Cosmetic trailing filename, so clients that infer a type from the path get it right. */
  name?: string;
};

export type MediaLinkRuntime = {
  /** Returns null when the link cannot be signed, in which case the caller uses `url` as-is. */
  mint: (request: MediaLinkRequest) => Promise<string | null>;
};

let runtime: MediaLinkRuntime | null = null;

export function setMediaLinkRuntime(r: MediaLinkRuntime): void {
  runtime = r;
}

export async function mintMediaLink(request: MediaLinkRequest): Promise<string | null> {
  return runtime ? await runtime.mint(request) : null;
}
