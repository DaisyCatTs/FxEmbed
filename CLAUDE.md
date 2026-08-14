# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is also present and covers env-var plumbing, self-hosting/transport modes, and the docs site in detail — read it for those topics rather than duplicating the info here.

## What this is

A single-domain fork of FxEmbed (the worker behind FxTwitter / FixupX / FxBluesky / FixTok / FxInstagram), serving `e.puppygirl.city`. It rewrites social post URLs into rich embeds for Discord. TypeScript on Cloudflare Workers, Hono routing, i18next (+ICU) localization, esbuild bundling, Vitest under Miniflare.

Three inherited subsystems have been removed and should not be reintroduced without a reason: the `/2/*` JSON API (and the `api` / `blueskyapi` / `atmosphere` realms), Telegram Instant View, and the RSS/Atom feeds. Telegram still gets ordinary OpenGraph tags.

## Commands

npm is canonical (CI uses `npm install` with `package-lock.json`; an untracked `bun.lock` may exist locally — ignore it). Node 24.x; CI pins 24.18.1. `.npmrc` sets `min-release-age=7`, so freshly published versions won't install.

Before the first build/test, copy `wrangler.example.toml` → `wrangler.toml` and `.env.example` → `.env`. `branding.json` is auto-copied from `branding.example.json` by the build.

| Task | Command |
| --- | --- |
| Build (worker + atmosphere) | `npm run build` |
| Build without Sentry upload | `npm run build-local` |
| Test | `npm test` (`pretest` builds atmosphere first) |
| Single test file | `npx vitest run test/embed.surface.test.ts` |
| Single test by name | `npx vitest run test/bot.test.ts -t "some test name"` |
| Lint (worker + package) | `npm run lint:eslint` |
| Format | `npm run prettier` |
| Dev server | `npm run dev` (wrangler dev --local, port 8787) |
| Deploy | `npm run deploy` (`wrangler deploy --no-bundle` — build first) |

- `wrangler dev` runs `npm run build` itself via the `[build]` section of `wrangler.toml`.
- Root Vitest only picks up `test/*.ts` — a test placed in a subdirectory of `test/` will silently not run. `test/helpers/` and `test/mocks/` are support files.
- `packages/atmosphere` has its own Vitest config (`src/**/*.test.ts`), run via `npm test -w @fxembed/atmosphere`.
- No Cloudflare account or real API credentials are needed for build, test, or local dev.

## Architecture

### Realm routing (`src/worker.ts`)

`app`'s custom `getPath` **rewrites the path to `/<realm>/<pathname>`** before Hono matches routes — `twitter`, `bluesky`, `tiktok`, `instagram`, `mastodon`, `threads`, `media`. Upstream picks the realm from the request hostname, which cannot work on one domain, so `src/routing/identify.ts` picks it from the URL *shape* instead, with `/_/x/`, `/_/bsky/`, … available to force one. That module is pure, so the whole table is asserted in `test/routing.test.ts`.

Consequence for local testing: paste a real post URL path (`curl http://localhost:8787/jack/status/20`), or force a realm with `/_/bsky/...`. Embed HTML only renders for a bot UA (`Constants.BOT_UA_REGEX`, e.g. `Discordbot/2.0`); otherwise the worker 302s to the original platform. The `Host` header still selects branding.

Provider runtime env is injected at module load, *before* the router imports — `setBlueskyProviderEnv`, `setTwitterProviderEnv`, `setMastodonProviderEnv`, plus `set*ProxyRuntime` for credential callbacks. Don't reorder those calls below the `app.route(...)` imports.

### Request flow

`src/realms/<realm>/router.ts` (route table + realm quirks) → `src/realms/<realm>/routes/*.ts` (parses URL/host/UA into `InputFlags`) → `src/embed/status.ts` `handleStatus` (the shared embed pipeline: fetch via provider, localize, build thread) → `src/render/{photo,video}.ts` (emit meta-tag instructions) → `Strings.BASE_HTML`.

Behavior is driven heavily by **subdomain flags** resolved in the route layer from `Constants` domain lists: `d.` direct media, text-only, gallery, force-mosaic, old-embed. Adding a new behavior generally means a new domain list env var + a flag in `InputFlags`.

`src/experiments.ts` gates features by random percentage roll (`experimentCheck`); a `percentage` of 0 or 1 is an off/on switch.

`src/caches.ts` wraps everything in the Workers Cache API and **varies the cache key by client** (`&telegram`, `&discord`, `&multibot`, `&bot`), because responses are tailored per embedding client. Caching is skipped on localhost/workers.dev and for Discordbot.

### `@fxembed/atmosphere` (`packages/atmosphere/`)

npm workspace holding the portable layer: provider clients/processors (Bluesky, Twitter, Mastodon, TikTok, Instagram, Threads), pure helpers, unified envelope types, transports, and relay. It is a **plain `tsc` build to `dist/`** consumed through subpath exports (`@fxembed/atmosphere/providers/twitter/conversation`, `/helpers/*`, `/types/*`) — so `npm run build:atmosphere` must run before the worker build or tests, and adding a new entry point requires a matching `exports` entry in its `package.json`.

The package must stay free of Hono/worker specifics. The worker keeps: Hono routing, branding, and credentials. Where a provider needs host context, the worker passes an adapter (`src/providers/*/build-host-adapter.ts`). The package still carries relay and OpenAPI types for self-hosters even though this deployment serves neither — leave them.

### Two JSON endpoints that are not the JSON API

Both survived the API removal because Discord depends on them, and both are easy to mistake for API surface:

- `/api/v1/statuses/:snowcode` (`src/embed/activity.ts`) is the Mastodon-shaped **activity** document Discord fetches for media. Deleting it breaks every embed.
- `/owoembed` (`src/render/oembed.ts` + a thin route per realm) is the **oEmbed** attribution line above a Discord embed. `identify.ts` routes it by the `provider` query param.

Shared API *field shapes* (`APITwitterStatus`, `APIStatusTombstone`, …) come from `@fxembed/atmosphere/types/api-schemas` — import them from there, not from a realm.

### Config and secrets

`src/constants.ts` is the single place `process.env.*` is read. esbuild **inlines** each variable listed in `esbuild.config.mjs` at build time, so a new env var only reaches the Workers bundle if it's added to that list — plus `.env.example`, `vitest.config.mts`, `.github/workflows/deploy.yml`, and `src/types/env.d.ts` (see AGENTS.md).

X/Twitter and Bluesky account credentials live in `credentials.enc.json` (gitignored, AES-encrypted, produced by `npm run credentials:*` in `tools/`) and are inlined as `ENCRYPTED_CREDENTIALS`/`CREDENTIALS_IV`; the worker decrypts them at runtime with the `CREDENTIAL_KEY` secret. A missing file is not an error — the build falls back to empty strings.

`branding.json` (gitignored) drives per-domain name/favicon/redirect via `src/helpers/branding.ts`, keyed on the last two hostname labels.

### Tests

Vitest runs inside Miniflare via `@cloudflare/vitest-pool-workers`. `test/helpers/harness.ts` supplies a `TwitterProxy` Fetcher mock that dispatches on the GraphQL operation name and loads JSON from `test/mocks/<Operation>/<id>.json`; adding coverage for a new upstream query means adding a `case` there plus fixture files. `test/helpers/env.ts` provides the process env (host lists etc.) that the subdomain flags depend on — the two comments in `vitest.config.mts` about `keepProcessEnv` and not loading the full wrangler config exist because empty `process.env` silently disables every domain-list feature.

## Conventions

- Prettier (single quotes, no trailing commas, width 100, `arrowParens: avoid`) is enforced through ESLint; `npm run lint:eslint` runs with `--max-warnings=0`.
- Unused vars are allowed only with a leading `_`.
- Translations live in `i18n/<locale>/resources.json`, aggregated by the hand-maintained `i18n/resources.js` barrel that `src/embed/status.ts` imports — adding a locale means editing that barrel too. Non-English strings come from Crowdin, so write new keys in `i18n/en`.
- MIT licensed and self-hostable; keep new dependencies compatible with that.
