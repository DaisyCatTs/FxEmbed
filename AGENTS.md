# AGENTS.md

This is a single-domain fork of FxEmbed (the home of FxTwitter, FixupX, and FxBluesky), serving `e.puppygirl.city`. It generates rich embeds for social media posts (X/Twitter, Bluesky, TikTok, Instagram, Mastodon, Threads) for Discord. Deployed on Cloudflare Workers; TypeScript, Hono for routing, i18next localization.

> **Removed from this fork:** the `/2/*` JSON API and its OpenAPI spec, Telegram Instant View, and the RSS/Atom feeds. Upstream documentation describing those still applies to FxEmbed proper, not here. `packages/atmosphere` keeps its relay/OpenAPI types for self-hosters.

## @fxembed/atmosphere (monorepo package)

- **Path:** `packages/atmosphere/`. The worker and tests import it via `"@fxembed/atmosphere"`.
- **Build:** `npm run build:atmosphere` (runs before the worker build).
- **Transports:** `public` | `anonymous-proxy` (credentials) | `proxy-relay` (to another host’s OpenAPI) | `authenticated` (interface stub, not implemented) — see `packages/atmosphere/src/transports/`.
- **Bluesky:** runtime wiring (API roots, proxy) — `setBlueskyProviderEnv` + `setBlueskyProxyRuntime` from `worker.ts` and `@fxembed/atmosphere/providers/bluesky-runtime`.
- **Proxy-relay OpenAPI (optional):** `npm run openapi:atmosphere` fetches public specs and writes `packages/atmosphere/src/relay/generated/`. Use `createRelayFetch` from `@fxembed/atmosphere` for `User-Agent` + API key injection.
- **Self-hosting:** docs site `/deployment/atmosphere-transports/` — public-only, own proxy pool, relay to `https://api.fxtwitter.com` / `https://api.fxbsky.app`, or mixed. Mastodon / Twitter / TikTok providers remain under `src/providers/*`; follow the Bluesky → `@fxembed/atmosphere` migration pattern when moving more code.

## Environment variables

Environment variables are generally set in .env, not in Wrangler, except for certain secrets such as CREDENTIAL_KEY. When adding an environment variable, you generally have to add them in the following places for them to be included correctly during a build:

- `.env.example` (for documentation)
- `esbuild.config.mjs` (so it's passed to the worker during build)
- `vitest.config.mts` (for tests)
- `.github/workflows/deploy.yml` (So GitHub Actions variables/secrets are given to it during deployment)
- `src/types/env.d.ts` (for type documentation)
- `src/constants.ts` (We typically load all environment variables under the Constants object)

## Cursor Cloud specific instructions

### Prerequisites

- **Node.js Latest LTS (Currently 24.14.x)** (CI uses `24.14.1`). The VM uses nvm; run `source ~/.nvm/nvm.sh && nvm use 24.14.1` before any npm commands.
- Config files must exist before build/test: copy `wrangler.example.toml` → `wrangler.toml` and `.env.example` → `.env` if they don't already exist. `branding.json` is auto-copied from `branding.example.json` during build if missing.

### Key commands

| Task          | Command                                                        |
| ------------- | -------------------------------------------------------------- |
| Install deps  | `npm install`                                                  |
| Lint          | `npm run lint:eslint`                                          |
| Format        | `npm run prettier`                                             |
| Build (local) | `npm run build-local`                                          |
| Test          | `npm run test`                                                 |
| Dev server    | `npx wrangler dev --local` (serves on `http://localhost:8787`) |

### Docs site (`docs/`)

- Guide screenshots are static assets under `docs/public/guide/readme/` (served as `/guide/readme/*` in the docs site).
- API reference specs: the `extract-openapi` scripts pull from upstream FxEmbed hosts only. This worker serves no OpenAPI spec, so `extract-openapi:local` no longer has anything to read.
- Then `npm run dev` in `docs/` to preview.

### Dev server testing notes

- The worker routes by `Host` header. Use `-H "Host: fxtwitter.com"` (or `fxbsky.app`, `api.fxtwitter.com`, etc.) with curl to hit different realms.
- Embed responses require a bot User-Agent (e.g. `-H "User-Agent: Discordbot/2.0"`); otherwise the worker redirects to the original platform.
- Tests run inside Miniflare (local Cloudflare Workers simulator) via `@cloudflare/vitest-pool-workers` and use extensive mocks in `test/mocks/` — no real API credentials needed.
- No Cloudflare account or authentication is required for build, test, or local dev.

### Gotchas

- `credentials.enc.json` is optional; build gracefully falls back to empty strings if missing.
- `wrangler dev` triggers a build automatically (via the `[build]` section in `wrangler.toml`).
