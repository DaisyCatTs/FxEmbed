# Discord verification checklist

Things that cannot be verified locally. Embed rendering is decided by Discord's client and its
crawler, not by our output alone — a response can be correct by every automated check here and
still render wrong.

Run this after each deploy. Discord caches aggressively per URL; append `?v=2`, `?v=3`… to force a
re-crawl rather than assuming a fix did not work.

## Before deploying

```sh
npm run build          # inlines .env into the bundle — config changes need a rebuild
npm run deploy         # wrangler deploy --no-bundle
```

Two things `wrangler deploy` will **not** do for you:

- **Routes.** `wrangler.toml` has no `routes` block, so the deploy publishes the Worker but does
  not bind it to `e.puppygirl.city`. That binding has to already exist in the Cloudflare dashboard
  (Workers → Routes), otherwise you are testing `puppygirl-embed.<subdomain>.workers.dev`.
- **Secrets.** `CREDENTIAL_KEY` is set with `wrangler secret put CREDENTIAL_KEY`, never in
  `wrangler.toml`.

## What should work right now

| Case | Paste | Expected |
|---|---|---|
| Single image | an X post with one photo | image renders (this already worked) |
| **Multiple images** | an X post with 4 photos | **4 separate images**, not 1 |
| **Animated GIF** | an X post with a GIF | **auto-looping silent video**, not a still frame and not blank |
| Video | an X post with a video | inline player |
| **Bluesky** | `e.puppygirl.city/profile/<handle>/post/<rkey>` | embeds at all |
| **TikTok** | `e.puppygirl.city/@<user>/video/<id>` | embeds at all |
| **Instagram** | `e.puppygirl.city/p/<shortcode>` | embeds at all |
| Explicit prefix | `e.puppygirl.city/_/x/jack/status/20` | same as the plain form |

The bolded rows are the ones this work changed. Everything else is a regression check.

### Also check: edge caching is now enabled for Discord

Discord requests used to bypass the cache entirely, so caching did nothing for the only client that
matters. That bypass has been removed, which means a Discord response is now stored at the edge.

Paste the **same** link twice in different channels and confirm both render identically, then paste
a *different* post and confirm it does not show the first one's content. What this is guarding
against is one post's embed being served for another — the failure mode that caused the bypass
upstream in the first place. Its cause there was branding mutating shared state, which no longer
exists here, but this is the check that would catch it if the reasoning is wrong.

### Why the bolded rows were broken

Discord does not read our OpenGraph tags at all: the activity embed runs at 100%, so Discord is
handed a pointer to `/api/v1/statuses/:snowcode` and reads media from there.

- GIFs were rewritten onto `gif.e.puppygirl.city` — a host that does not exist — with a `.webp`
  extension. They now emit the upstream mp4 typed as `gifv`, which is what makes a client loop it.
- Multi-image posts gave every attachment the same hardcoded id, so they collapsed.
- Bluesky, TikTok and Instagram were unreachable: the realm was chosen from the last two labels of
  the hostname, so `e.puppygirl.city` became `puppygirl.city`, matched nothing, and every request
  fell through to X.

## Known limitations, not bugs

- **X is guest-token only** until `credentials.enc.json` and `CREDENTIAL_KEY` exist. Single posts
  work; threads, profiles, search, quotes and timelines will not, no matter how the embed is built.
- **Mastodon and Threads have no HTML embed path** — they only ever existed as JSON API routes.
  Adding them is outstanding work, not a regression.
- **`@p` and `@t` profiles** are shadowed by the Instagram and TikTok mirror shapes; reach them at
  `/_/x/p` and `/_/x/t`. Same for most of `/profile/…` versus the X account `@profile`.
- **oEmbed `provider_name`** is your single brand rather than a per-provider name, because one
  domain means one branding zone.

## If a GIF still renders as a still image

Check the activity JSON directly — that is what Discord actually reads:

```sh
curl -s -H 'User-Agent: Discordbot/2.0' \
  'https://e.puppygirl.city/<handle>/status/<id>' | grep -o '/api/v1/statuses/[^"]*'

curl -s -H 'User-Agent: Discordbot/2.0' \
  'https://e.puppygirl.city/api/v1/statuses/<snowcode>' | jq '.media_attachments'
```

Expected: `type` is `gifv`, `url` ends `.mp4` on `video.twimg.com`, `preview_url` is the still, and
no URL contains `gif.`, `mosaic.`, `pbs.e.` or `/2/go`. If the JSON is right and Discord still shows
a still, the problem is Discord's cache or its client — not this service.
