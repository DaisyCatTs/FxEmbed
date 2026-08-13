/* Parse a comma-separated env var into a list of hosts.
   Must filter empties: a plain `''.split(',')` yields `['']`, which has length 1 and so passes
   every "is this feature configured?" guard, causing us to rewrite media URLs onto an empty host
   (e.g. `https:///2/go?url=...`). An unconfigured list has to be genuinely empty. */
const domainList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/* First host of a list as an origin, or '' when the list is empty. */
const firstOrigin = (value: string | undefined): string => {
  const host = domainList(value)[0];
  return host ? `https://${host}` : '';
};

export const Constants = {
  /* Populated from process.env (.env under Bun/Node, or each key inlined by esbuild for Workers). */
  STANDARD_DOMAIN_LIST: domainList(process.env.STANDARD_DOMAIN_LIST),
  STANDARD_BSKY_DOMAIN_LIST: domainList(process.env.STANDARD_BSKY_DOMAIN_LIST),
  STANDARD_TIKTOK_DOMAIN_LIST: domainList(process.env.STANDARD_TIKTOK_DOMAIN_LIST),
  STANDARD_INSTAGRAM_DOMAIN_LIST: domainList(process.env.STANDARD_INSTAGRAM_DOMAIN_LIST),
  DIRECT_MEDIA_DOMAINS: domainList(process.env.DIRECT_MEDIA_DOMAINS),
  TEXT_ONLY_DOMAINS: domainList(process.env.TEXT_ONLY_DOMAINS),
  INSTANT_VIEW_DOMAINS: domainList(process.env.INSTANT_VIEW_DOMAINS),
  GALLERY_DOMAINS: domainList(process.env.GALLERY_DOMAINS),
  FORCE_MOSAIC_DOMAINS: domainList(process.env.FORCE_MOSAIC_DOMAINS),
  OLD_EMBED_DOMAINS: domainList(process.env.OLD_EMBED_DOMAINS),
  MOSAIC_DOMAIN_LIST: domainList(process.env.MOSAIC_DOMAIN_LIST),
  MOSAIC_BSKY_DOMAIN_LIST: domainList(process.env.MOSAIC_BSKY_DOMAIN_LIST),
  POLYGLOT_DOMAIN_LIST: domainList(process.env.POLYGLOT_DOMAIN_LIST),
  POLYGLOT_ACCESS_TOKEN: process.env.POLYGLOT_ACCESS_TOKEN ?? '',
  API_HOST_LIST: domainList(process.env.API_HOST_LIST),
  API_HOST_ROOT: firstOrigin(process.env.API_HOST_LIST),
  BLUESKY_API_HOST_LIST: domainList(process.env.BLUESKY_API_HOST_LIST),
  BLUESKY_API_HOST_ROOT: firstOrigin(process.env.BLUESKY_API_HOST_LIST),
  ATMOSPHERE_API_HOST_LIST: domainList(process.env.ATMOSPHERE_API_HOST_LIST),
  ATMOSPHERE_API_HOST_ROOT: firstOrigin(process.env.ATMOSPHERE_API_HOST_LIST),
  RELEASE_NAME: process.env.RELEASE_NAME || 'local',
  GIF_TRANSCODE_DOMAIN_LIST: domainList(process.env.GIF_TRANSCODE_DOMAIN_LIST),
  VIDEO_TRANSCODE_DOMAIN_LIST: domainList(process.env.VIDEO_TRANSCODE_DOMAIN_LIST),
  VIDEO_TRANSCODE_BSKY_DOMAIN_LIST: domainList(process.env.VIDEO_TRANSCODE_BSKY_DOMAIN_LIST),
  PBS_PROXY_DOMAIN_LIST: domainList(process.env.PBS_PROXY_DOMAIN_LIST),
  API_DOCS_URL: `https://github.com/FxEmbed/FxEmbed/wiki/API-Home`,
  TWITTER_ROOT: process.env.TWITTER_ROOT || 'https://x.com',
  HORIZON_WEB_ROOT: 'https://app.fxtwitter.com',
  TWITTER_API_ROOT: 'https://api.x.com',
  TWITTER_VIDEO_BASE: 'https://video.twimg.com',
  BLUESKY_ROOT: 'https://bsky.app',
  BLUESKY_VIDEO_BASE: 'https://video.bsky.app',
  BLUESKY_API_ROOT: 'https://public.api.bsky.app',
  TIKTOK_ROOT: 'https://www.tiktok.com',
  TIKTOK_API_HOST: 'https://api16-normal-c-useast1a.tiktokv.com',
  INSTAGRAM_ROOT: process.env.INSTAGRAM_ROOT || 'https://www.instagram.com',
  NATIVE_MULTI_IMAGE_UA_REGEX: /discordbot\/|matrixpreviewbot/gi,
  BOT_UA_REGEX:
    /bot|facebook|embed|got|firefox\/92|firefox\/38|chrome\/96\.0\.4664\.110|curl|wget|go-http|yahoo|generator|whatsapp|revoltchat|preview|link|proxy|vkshare|images|analyzer|index|crawl|spider|python|node|deno|mastodon|http\.rb|ruby|bun\/|fiddler|iframely|steamchaturllookup|bluesky|matrix-media-repo|cardyb|resolver|util|feedly|rss|reader|atom|thunderbird|axios/gi,
  /* 3 hours */
  GUEST_TOKEN_MAX_AGE: 3 * 60 * 60,
  GUEST_BEARER_TOKEN: `Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA`,
  GUEST_FETCH_PARAMETERS: [
    'cards_platform=Web-12',
    'include_cards=1',
    'include_ext_alt_text=true',
    'include_ext_views=true',
    'include_quote_count=true',
    'include_reply_count=1',
    'tweet_mode=extended',
    'include_entities=true',
    'include_ext_media_color=true',
    'include_ext_media_availability=true',
    'include_ext_sensitive_media_warning=true',
    'include_ext_has_birdwatch_notes=true',
    'simple_quoted_tweet=true',
    'ext=mediaStats%2ChighlightedLabel'
  ].join('&'),
  BASE_HEADERS: {
    'DNT': `1`,
    'x-twitter-client-language': `en`,
    'sec-ch-ua-mobile': `?0`,
    'content-type': `application/json`,
    'cache-control': `no-cache`,
    'x-twitter-active-user': `yes`,
    'sec-ch-ua-platform': `"Windows"`,
    'Accept': `*/*`,
    'Origin': `https://x.com`,
    'Sec-Fetch-Site': `same-site`,
    'Sec-Fetch-Mode': `cors`,
    'Sec-Fetch-Dest': `empty`,
    'Sec-Gpc': `1`,
    'Permissions-Policy': `browsing-topics=()`,
    'Pragma': `no-cache`,
    'Referer': `https://x.com/home`,
    'Accept-Encoding': `gzip, deflate, br, zstd`,
    'Accept-Language': `en`
  },
  RESPONSE_HEADERS: {
    'allow': 'OPTIONS, GET, HEAD',
    'content-type': 'text/html;charset=UTF-8',
    'x-powered-by': `${process.env.RELEASE_NAME || 'local'}`,
    'x-trans-rights': 'true',
    'Vary': 'Accept-Encoding, User-Agent'
  },
  API_RESPONSE_HEADERS: {
    'access-control-allow-origin': '*',
    'content-type': 'application/json'
  },
  POLL_TWEET_CACHE: 'max-age=60',
  DEFAULT_COLOR: '#10A3FF',
  FRIENDLY_USER_AGENT: `Mozilla/5.0 FxEmbedBot/2.0 (like Twitterbot; +https://fxembed.com/crawler)`
};
