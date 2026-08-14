/* eslint-disable no-case-declarations */
import { interpolate, Strings } from '../strings';
import { DataProvider, returnError } from './status';
import { constructTwitterThread } from '@fxembed/atmosphere/providers/twitter/conversation';
import { twitterBuildHostFromContext } from '../providers/twitter/build-host-adapter';
import { constructBlueskyThread } from '@fxembed/atmosphere/providers/bluesky/conversation';
import { blueskyBuildHostFromContext } from '../providers/bluesky/build-host-adapter';
import { Constants } from '../constants';
import { getActivitySocialProof } from '../helpers/socialproof';
import i18next from 'i18next';
import icu from 'i18next-icu';
import { escapeRegex } from '../helpers/utils';
import { decodeSnowcode } from '../helpers/snowcode';
import translationResources from '../../i18n/resources';
import { Experiment, experimentCheck } from '../experiments';
import { Context } from 'hono';
import { shouldTranscodeGif } from '../helpers/giftranscode';
import { normalizeLanguage } from '../helpers/language';
import { constructTikTokVideo } from '@fxembed/atmosphere/providers/tiktok/conversation';
import { constructInstagramPost } from '@fxembed/atmosphere/providers/instagram/post';
import { constructMastodonThread } from '@fxembed/atmosphere/providers/mastodon/conversation';
import { mastodonBuildHostFromContext } from '../providers/mastodon/build-host-adapter';
import { constructThreadsPost } from '@fxembed/atmosphere/providers/threads/post';
import { THREADS_WEB_ROOT } from '../providers/threads/web';
import { renderArticleToHtml, DISCORD_ARTICLE_MAX_LENGTH } from '../helpers/article';
import {
  facetUtf16RangeOnPlainText,
  normalizeUtf16EntityRange
} from '../helpers/twitterTextIndices';
import { getLocalizedTombstoneLine, isTombstone } from '../helpers/tombstone';

const convertArticleMediaToAttachment = (
  media: TwitterApiMedia
): ActivityMediaAttachment | null => {
  if (media.media_info.__typename === 'ApiImage') {
    const image = media.media_info as TwitterApiImage;
    return {
      id: media.media_id,
      type: 'image',
      url: image.original_img_url,
      preview_url: null,
      remote_url: null,
      preview_remote_url: null,
      text_url: null,
      description: null,
      meta: {
        original: {
          width: image.original_img_width,
          height: image.original_img_height,
          size: `${image.original_img_width}x${image.original_img_height}`,
          aspect: image.original_img_width / image.original_img_height
        }
      }
    } as ActivityMediaAttachment;
  } else if (
    media.media_info.__typename === 'ApiVideo' ||
    media.media_info.__typename === 'ApiGif'
  ) {
    const video = media.media_info as TwitterApiVideo;
    const videoUrl = video.video_info?.variants?.[0]?.url || video.media_url_https;
    let sizeMultiplier = 1;
    const width = video.original_info.width;
    const height = video.original_info.height;

    if (width > 1920 || height > 1920) {
      sizeMultiplier = 0.5;
    }
    if (width < 400 || height < 400) {
      sizeMultiplier = 2;
    }

    if (experimentCheck(Experiment.VIDEO_REDIRECT_WORKAROUND, Constants.API_HOST_LIST.length > 0)) {
      const redirectedUrl = `https://${Constants.API_HOST_LIST[0]}/2/go?url=${encodeURIComponent(videoUrl)}`;
      return {
        id: media.media_id,
        type: 'video',
        url: redirectedUrl,
        preview_url: video.media_url_https,
        remote_url: null,
        preview_remote_url: null,
        text_url: null,
        description: video.ext_alt_text ?? undefined,
        meta: {
          original: {
            width: width * sizeMultiplier,
            height: height * sizeMultiplier,
            size: `${width * sizeMultiplier}x${height * sizeMultiplier}`,
            aspect: width / height
          }
        }
      } as ActivityMediaAttachment;
    }

    return {
      id: media.media_id,
      type: 'video',
      url: videoUrl,
      preview_url: video.media_url_https,
      remote_url: null,
      preview_remote_url: null,
      text_url: null,
      description: video.ext_alt_text ?? undefined,
      meta: {
        original: {
          width: width * sizeMultiplier,
          height: height * sizeMultiplier,
          size: `${width * sizeMultiplier}x${height * sizeMultiplier}`,
          aspect: width / height
        }
      }
    } as ActivityMediaAttachment;
  }

  return null;
};

/* Card/poll text is attacker-controlled upstream data. It is only ever serialized as JSON here, so
   JSON encoding is the entire escaping story — it must never reach an HTML string. */

/** Rejects non-http(s) card links (`javascript:`, `data:`) before a client can turn them into a link. */
const safeCardUrl = (url: string | null | undefined): string | null => {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
};

const cardProviderName = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/* Discord never reads our OpenGraph tags for these posts, so Mastodon's preview card is the only
   place a link preview can come from. */
const buildActivityCard = (status: APIStatus): ActivityCard | null => {
  const websiteCard =
    status.provider === DataProvider.Twitter ? (status as APITwitterStatus).card : undefined;
  const websiteCardUrl = safeCardUrl(websiteCard?.url);

  if (websiteCard && websiteCardUrl) {
    return {
      url: websiteCardUrl,
      title: websiteCard.title ?? '',
      description: websiteCard.description ?? '',
      type: 'link',
      author_name: '',
      author_url: '',
      provider_name: websiteCard.domain?.replace(/^www\./, '') ?? cardProviderName(websiteCardUrl),
      provider_url: '',
      html: '',
      width: websiteCard.image?.width ?? 0,
      height: websiteCard.image?.height ?? 0,
      image: safeCardUrl(websiteCard.image?.url),
      image_description: websiteCard.image?.alt ?? '',
      embed_url: '',
      blurhash: null
    };
  }

  const external = status.media?.external;
  const embedUrl = safeCardUrl(external?.url);

  if (external && embedUrl) {
    /* Player cards (YouTube and friends) carry no title/description bindings upstream, so the embed
       URL and its thumbnail are all we can honestly hand a client. */
    return {
      url: embedUrl,
      title: '',
      description: '',
      type: 'video',
      author_name: '',
      author_url: '',
      provider_name: cardProviderName(embedUrl),
      provider_url: '',
      html: '',
      width: external.width ?? 0,
      height: external.height ?? 0,
      image: safeCardUrl(external.thumbnail_url),
      image_description: '',
      embed_url: embedUrl,
      blurhash: null
    };
  }

  return null;
};

const buildActivityPoll = (status: APIStatus, statusId: string): ActivityPoll | null => {
  const poll = status.poll;
  if (!poll) {
    return null;
  }

  const endsAt = new Date(poll.ends_at);
  const expiresAt = isNaN(endsAt.getTime()) ? null : endsAt.toISOString();

  return {
    id: statusId,
    expires_at: expiresAt,
    expired: expiresAt !== null && endsAt.getTime() <= Date.now(),
    /* X polls are single-choice, and an embed request never carries a viewer identity, so the
       voting fields are constants rather than unknowns. */
    multiple: false,
    votes_count: poll.total_votes,
    voters_count: poll.total_votes,
    voted: false,
    own_votes: [],
    options: poll.choices.map(choice => ({ title: choice.label, votes_count: choice.count })),
    emojis: []
  };
};

const generatePoll = (poll: APIPoll): string => {
  let str = '<blockquote>';

  const barLength = 32;

  poll.choices.forEach(choice => {
    const bar = '█'.repeat((choice.percentage / 100) * barLength);
    str += `${bar}<br><b>${choice.label}</b>&emsp;${choice.percentage}%<br>︀︀︀<br>︀`;
  });

  /* Finally, add the footer of the poll with # of votes and time left */
  str += ''; /* TODO: Localize time left */
  str += i18next.t('pollVotes', {
    voteCount: poll.total_votes,
    timeLeft: poll.time_left_en ?? ''
  });

  return str + '</blockquote>';
};

interface StatusTextResult {
  text: string;
  articleMedia: TwitterApiMedia[];
}

const getStatusText = (status: APIStatus): StatusTextResult => {
  let text: string;

  // Check if is Twitter so we can detect article
  if (status.provider === DataProvider.Twitter) {
    const twitterStatus = status as APITwitterStatus;
    if (twitterStatus.article) {
      const articleResult = renderArticleToHtml(twitterStatus.article.content, {
        maxLength: DISCORD_ARTICLE_MAX_LENGTH,
        fullRenderer: false,
        mediaEntities: twitterStatus.article.media_entities
      });

      // Prepend article title
      text = `<b>📰 ${twitterStatus.article.title}</b>${articleResult.html}`;

      return { text, articleMedia: articleResult.collectedMedia };
    }
  }

  const convertedStatusText = status.text.trim().replace(/\n/g, '<br>︀︀');

  if (status.translation) {
    console.log('translation', JSON.stringify(status.translation));
    const { translation } = status;

    const formatText = interpolate(`<b>📑 {translation}</b>`, {
      translation: interpolate(i18next.t('translatedFrom'), {
        language: i18next.t(`language_${translation?.source_lang}`)
      })
    });

    text = `${formatText}<br><br>${formatStatus(translation?.text ?? '', status)}<br><br>`;
    text += `<blockquote><b>${i18next.t('ivOriginalText')}</b><br>${formatStatus(convertedStatusText, status)}</blockquote>`;
  } else {
    text = formatStatus(convertedStatusText, status) + '<br><br>';
  }
  if (status.quote) {
    if (isTombstone(status.quote)) {
      text += `<blockquote><i>${status.quote.message}</i></blockquote>`;
    } else {
      const quoteText = (status.quote.translation?.text ?? status.quote.text)
        .trim()
        .replace(/\n/g, '<br>︀︀');
      text += `<blockquote><b>${interpolate(i18next.t('ivQuoteHeader'), {
        authorName: status.quote.author.name,
        authorURL: status.quote.author.url,
        authorHandle: status.quote.author.screen_name,
        url: status.quote.url
      })}</b><br>︀<br>${formatStatus(quoteText, status.quote)}</blockquote>`;
    }
  }
  if (status.replying_to) {
    text = `<sub>↩ <a href="${status.replying_to.profile_url}" class="u-url mention">${status.replying_to.display_name ?? ''} (@${status.replying_to.screen_name})</a></sub><br>${text}`;
  }
  if (status.poll) {
    text += `${generatePoll(status.poll)}`;
  }
  const socialProof = getActivitySocialProof(status);
  if (socialProof) {
    text += socialProof;
  }
  return { text, articleMedia: [] };
};

/**
 * The instance a Mastodon status came from, taken from the author's own profile URL.
 *
 * There is no fixed web root for the fediverse — every account lives on its own instance — so
 * mention and hashtag links have to be built against whichever one served this status. Returns
 * null rather than guessing when the URL is missing or not https, which drops the linkification
 * instead of emitting a link to nowhere.
 */
const mastodonOrigin = (status: APIStatus): string | null => {
  try {
    const parsed = new URL(status.author?.url ?? '');
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
};

const linkifyMentions = (text: string, status: APIStatus) => {
  let baseUrl = '';
  switch (status.provider) {
    case DataProvider.Mastodon: {
      const origin = mastodonOrigin(status);
      if (!origin) {
        return text;
      }
      baseUrl = `${origin}/@`;
      break;
    }
    case DataProvider.Threads:
      baseUrl = `${THREADS_WEB_ROOT}/@`;
      break;
    case DataProvider.Bluesky:
      baseUrl = `${Constants.BLUESKY_ROOT}/profile/`;
      break;
    case DataProvider.Twitter:
      baseUrl = `${Constants.TWITTER_ROOT}/`;
      break;
    case DataProvider.TikTok:
      baseUrl = `${Constants.TIKTOK_ROOT}/@`;
      break;
    case DataProvider.Instagram:
      baseUrl = `${Constants.INSTAGRAM_ROOT}/`;
      break;
  }
  const matches = text.match(/(?<!https?:\/\/[\w.\-_%$@&?!:;/'()*]+)@([\w.]+)(?=\W|$)/g);

  console.log('matches', matches);
  // deduplicate mentions
  [...new Set(matches ?? [])]?.forEach(mention => {
    text = text.replace(
      new RegExp(`(?<!https?:\\/\\/[\\w.:/]+)${escapeRegex(mention)}(?=\\W|$)`, 'g'),
      `<a href="${baseUrl}${mention.slice(1)}">${mention}</a>`
    );
  });
  console.log('text', text);
  return text;
};

const linkifyHashtags = (text: string, status: APIStatus) => {
  let baseUrl = '';
  switch (status.provider) {
    case DataProvider.Mastodon: {
      const origin = mastodonOrigin(status);
      if (!origin) {
        return text;
      }
      baseUrl = `${origin}/tags`;
      break;
    }
    /* Threads has no path-shaped hashtag URL — its tag search is a query string, which does not
       fit the `${base}/${tag}` join every other provider uses. Leaving the tag as plain text is
       better than emitting a link that 404s. */
    case DataProvider.Threads:
      return text;
    case DataProvider.Bluesky:
      baseUrl = `${Constants.BLUESKY_ROOT}/hashtag`;
      break;
    case DataProvider.Twitter:
      baseUrl = `${Constants.TWITTER_ROOT}/hashtag`;
      break;
    case DataProvider.TikTok:
      baseUrl = `${Constants.TIKTOK_ROOT}/tag`;
      break;
    case DataProvider.Instagram:
      baseUrl = `${Constants.INSTAGRAM_ROOT}/explore/tags`;
      break;
  }
  const matches = text.match(/(?<!https?:\/\/[\w.\-_%$@&?!:;/'()*]+)#([\w.]+)(?=\W|$)/g);
  console.log('matches', matches);
  // deduplicate hashtags
  [...new Set(matches ?? [])]?.forEach(hashtag => {
    text = text.replace(
      new RegExp(`(?<!https?:\\/\\/[\\w.:/]+)${hashtag}(?=\\W|$)`, 'g'),
      `<a href="${baseUrl}/${hashtag.slice(1)}">${hashtag}</a>`
    );
  });
  console.log('text', text);
  return text;
};

const statusLinkWrapper = (text: string) => {
  const matches = text.match(
    /(?<!href=")https?:\/\/(?:www\.)?[-\w@:%.+~#=]{1,256}\.[a-zA-Z\d()]{1,6}\b([-\w()@:%+.~#?&/=]*)(?=\W|$)/g
  );
  [...new Set(matches ?? [])]?.forEach(url => {
    text = text.replace(
      new RegExp(`${escapeRegex(url)}(?=\\W|$)`, 'g'),
      `<a href="${url}">${url}</a>`
    );
  });
  return text;
};

const formatStatus = (text: string, status: APIStatus) => {
  const enableFacets = false;

  if (status.raw_text && enableFacets) {
    const plainText = status.raw_text.text;
    text = plainText;

    const noteTweetUnicodeScalarFacets =
      status.provider === DataProvider.Twitter && (status as APITwitterStatus).is_note_tweet;

    const facetUtf16RangesOnPlain = status.raw_text.facets.map(f =>
      facetUtf16RangeOnPlainText(plainText, f, noteTweetUnicodeScalarFacets)
    );

    let baseHashtagUrl = '';
    let baseSymbolUrl = '';
    let baseMentionUrl = '';

    switch (status.provider) {
      case DataProvider.Bluesky:
        baseHashtagUrl = `${Constants.BLUESKY_ROOT}/hashtag`;
        baseSymbolUrl = `${Constants.BLUESKY_ROOT}/search?q=%24`;
        baseMentionUrl = `${Constants.BLUESKY_ROOT}/profile/`;
        break;
      case DataProvider.Twitter:
        baseHashtagUrl = `${Constants.TWITTER_ROOT}/hashtag`;
        baseSymbolUrl = `${Constants.TWITTER_ROOT}/search?q=%24`;
        baseMentionUrl = `${Constants.TWITTER_ROOT}/`;
        break;
      case DataProvider.TikTok:
        baseHashtagUrl = `${Constants.TIKTOK_ROOT}/tag`;
        baseSymbolUrl = `${Constants.TIKTOK_ROOT}/search?q=%24`;
        baseMentionUrl = `${Constants.TIKTOK_ROOT}/@`;
        break;
      case DataProvider.Instagram:
        baseHashtagUrl = `${Constants.INSTAGRAM_ROOT}/explore/tags`;
        baseSymbolUrl = `${Constants.INSTAGRAM_ROOT}/explore/tags`;
        baseMentionUrl = `${Constants.INSTAGRAM_ROOT}/`;
        break;
      case DataProvider.Mastodon: {
        /* Per-instance, so an unusable author URL leaves these empty and the facet renders as
           plain text rather than as a link to a host we invented. */
        const origin = mastodonOrigin(status);
        if (origin) {
          baseHashtagUrl = `${origin}/tags`;
          baseMentionUrl = `${origin}/@`;
        }
        break;
      }
      case DataProvider.Threads:
        baseMentionUrl = `${THREADS_WEB_ROOT}/@`;
        break;
    }
    let offset = 0;
    status.raw_text.facets.forEach((facet: APIFacet, facetIndex: number) => {
      const [rawStart, rawEnd] = facetUtf16RangesOnPlain[facetIndex]!;
      const [start, end] = normalizeUtf16EntityRange(text, rawStart + offset, rawEnd + offset);
      const oldLen = end - start;

      let newFacet: string;
      switch (facet.type) {
        case 'bold':
          newFacet = `<b>${text.slice(start, end)}</b>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'italic':
          newFacet = `<i>${text.slice(start, end)}</i>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'underline':
          newFacet = `<u>${text.slice(start, end)}</u>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'strikethrough':
          newFacet = `<s>${text.slice(start, end)}</s>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'url':
          newFacet = `<a href="${facet.replacement}">${facet.display}</a>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'hashtag':
          newFacet = `<a href="${baseHashtagUrl}/${facet.original}">#${facet.original}</a>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'symbol':
          newFacet = baseSymbolUrl
            ? `<a href="${baseSymbolUrl}/${facet.original}">$${facet.original}</a>`
            : `$${facet.original}`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'mention':
          newFacet = `<a href="${baseMentionUrl}${facet.original}">@${facet.original}</a>`;
          text = text.slice(0, start) + newFacet + text.slice(end);
          offset += newFacet.length - oldLen;
          break;
        case 'media':
        case 'inline_media':
          text = text.slice(0, start) + text.slice(end);
          offset -= oldLen;
          break;
      }
    });
    text = text.trim().replace(/\n/g, '<br>︀︀');
  } else {
    text = statusLinkWrapper(text);
    text = linkifyMentions(text, status);
    text = linkifyHashtags(text, status);
  }
  return text;
};

export const handleActivity = async (
  c: Context,
  snowcode: string,
  provider: DataProvider
): Promise<Response> => {
  let language: string | null = null;
  let authorHandle: string | null = null;
  let mediaNumber: number | null = null;
  let textOnly = false;
  let forceMosaic = false;
  const decoded = decodeSnowcode(snowcode);
  const statusId = decoded.i;
  if (decoded.l) {
    language = decoded.l;
  }
  if (decoded.h) {
    authorHandle = decoded.h;
  }
  if (decoded.t) {
    textOnly = true;
  }
  if (decoded.m) {
    forceMosaic = true;
  }
  if (decoded.n) {
    mediaNumber = decoded.n;
  }

  const preferredProxyServiceHost =
    typeof decoded.p === 'string' && decoded.p.length > 0 ? decoded.p : undefined;

  console.log('snowcode params', JSON.stringify(decoded));

  let thread: SocialThread;
  if (provider === DataProvider.Twitter) {
    thread = await constructTwitterThread(
      statusId,
      false,
      twitterBuildHostFromContext(c),
      language ?? undefined,
      false
    );
  } else if (provider === DataProvider.Bluesky) {
    thread = await constructBlueskyThread(
      statusId,
      authorHandle ?? '',
      false,
      blueskyBuildHostFromContext(c),
      language ?? undefined,
      preferredProxyServiceHost ? { preferredProxyServiceHost } : undefined
    );
  } else if (provider === DataProvider.TikTok) {
    // Get proxy base URL from the current request for TikTok video proxy
    const requestUrl = new URL(c.req.url);
    const proxyBase = `${requestUrl.protocol}//${requestUrl.host}`;
    thread = await constructTikTokVideo(statusId, proxyBase);
  } else if (provider === DataProvider.Instagram) {
    thread = (await constructInstagramPost(statusId, c.req.header('User-Agent'))) as SocialThread;
  } else if (provider === DataProvider.Mastodon) {
    /* The instance travelled in the snowcode's `h` slot — see src/embed/status.ts. A status id on
       its own does not identify a fediverse post, so without it there is nothing to fetch. */
    if (!authorHandle) {
      return returnError(c, Strings.ERROR_MASTODON_BAD_INSTANCE);
    }
    thread = (await constructMastodonThread(
      statusId,
      authorHandle,
      false,
      mastodonBuildHostFromContext(c),
      language ?? undefined
    )) as SocialThread;
  } else if (provider === DataProvider.Threads) {
    thread = await constructThreadsPost(statusId, c.req.header('User-Agent'));
  } else {
    return returnError(c, Strings.ERROR_API_FAIL);
  }

  if (!thread.status) {
    if (provider === DataProvider.Bluesky) {
      return returnError(
        c,
        thread.code === 404 ? Strings.ERROR_TWEET_NOT_FOUND : Strings.ERROR_BLUESKY_UNAVAILABLE
      );
    }
    return returnError(c, Strings.ERROR_API_FAIL);
  }

  if (isTombstone(thread.status)) {
    const message = await getLocalizedTombstoneLine(thread.status.reason, language ?? undefined);
    return returnError(c, message);
  }

  await i18next.use(icu).init({
    lng: normalizeLanguage(language ?? thread.status.lang ?? 'en'),
    resources: translationResources,
    fallbackLng: 'en'
  });

  // Get status text and article media
  const statusResult = getStatusText(thread.status as APIStatus);
  const statusText = statusResult.text;
  const articleMedia = statusResult.articleMedia;

  // Map FxEmbed API to Mastodon API v1
  const response: ActivityStatus = {
    id: statusId,
    url: thread.status.url,
    uri: thread.status.url,
    created_at: new Date(thread.status.created_at).toISOString(),
    edited_at: null,
    reblog: null,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    language: thread.status.lang,
    content: statusText,
    spoiler_text: '',
    visibility: 'public',
    application: {
      name: thread.status.source,
      website: null
    },
    media_attachments: [],
    account: {
      id: thread.status.author.id,
      display_name: thread.status.author.name,
      username: thread.status.author.screen_name,
      acct: thread.status.author.screen_name,
      url: thread.status.url,
      uri: thread.status.url,
      created_at: thread.status.author.joined
        ? new Date(thread.status.author.joined).toISOString()
        : new Date().toISOString(),
      locked: false,
      bot: false,
      discoverable: true,
      indexable: false,
      group: false,
      avatar: thread.status.author.avatar_url ?? undefined,
      avatar_static: thread.status.author.avatar_url ?? undefined,
      header: thread.status.author.banner_url ?? undefined,
      header_static: thread.status.author.banner_url ?? undefined,
      followers_count: thread.status.author.followers,
      following_count: thread.status.author.following,
      statuses_count: thread.status.author.statuses,
      hide_collections: false,
      noindex: false,
      emojis: [],
      roles: [],
      fields: []
    },
    mentions: [],
    tags: [],
    emojis: [],
    card: buildActivityCard(thread.status as APIStatus),
    poll: buildActivityPoll(thread.status as APIStatus, statusId)
  };

  // Convert article media to attachments format
  const articleAttachments = articleMedia
    .map((media: TwitterApiMedia) => convertArticleMediaToAttachment(media))
    .filter(Boolean) as ActivityMediaAttachment[];

  const rawMediaList =
    (thread.status.media?.all?.length ?? 0) > 0
      ? thread.status.media?.all
      : !isTombstone(thread.status.quote)
        ? (thread.status.quote?.media?.all ?? [])
        : [];
  let mediaList = rawMediaList;

  if (!textOnly) {
    if (mediaNumber) {
      console.log('we have a media number', mediaNumber);
      const newMedia = rawMediaList?.[mediaNumber - 1];
      if (newMedia) {
        mediaList = [newMedia];
      } else {
        console.log('wtf there is no media #', mediaNumber);
      }
      console.log('updated mediaList', mediaList);
    }
    if (
      forceMosaic &&
      mediaList?.length !== 1 &&
      (thread.status.media?.mosaic ||
        (!isTombstone(thread.status.quote) && thread.status.quote?.media?.mosaic))
    ) {
      const mosaic =
        thread.status.media?.mosaic ||
        (!isTombstone(thread.status.quote) ? thread.status.quote?.media?.mosaic : undefined);
      response.media_attachments = [
        {
          id: '114163769487684704',
          type: 'image',
          url: mosaic?.formats?.jpeg || '',
          remote_url: null,
          preview_url: null,
          preview_remote_url: null,
          text_url: null,
          description: null,
          meta: {
            original: {
              width: mosaic?.width || 0,
              height: mosaic?.height || 0
            }
          }
        }
      ];
    } else if (mediaList && mediaList.length > 0) {
      // Cast results to ActivityMediaAttachment[]
      response.media_attachments = mediaList
        .map((media, index) => {
          /* Attachment ids must be unique. Clients treat Mastodon attachments as a keyed set, so
             reusing one id across a multi-photo post collapses it to a single image. Upstream
             media ids are already unique; fall back to the status id plus position. */
          const attachmentId = media.id ?? `${statusId}${index}`;

          if (media.type === 'gif') {
            const videoMedia = media as APIVideo;
            const photoMedia = media as APIPhoto;
            const shouldTranscodeGifs = shouldTranscodeGif(c);

            if (videoMedia.format === 'image/gif') {
              media.type = 'photo';
            } else if (shouldTranscodeGifs && photoMedia.transcode_url) {
              media.type = 'photo';
              media.url = photoMedia.transcode_url;
            }
          }
          switch (media.type) {
            case 'photo':
              const image = media as APIPhoto;
              return {
                id: attachmentId,
                type: 'image',
                url: image.url,
                preview_url: null,
                remote_url: null,
                preview_remote_url: null,
                text_url: null,
                description: image.altText ?? null,
                meta: {
                  original: {
                    width: image.width,
                    height: image.height,
                    size: `${image.width}x${image.height}`,
                    aspect: image.width / image.height
                  }
                }
              } as ActivityMediaAttachment;
            case 'video':
            case 'gif':
              const video = media as APIVideo;
              let sizeMultiplier = 1;

              if (video.width > 1920 || video.height > 1920) {
                sizeMultiplier = 0.5;
              }
              if (video.width < 400 || video.height < 400) {
                sizeMultiplier = 2;
              }
              // Apply video redirect workaround, but NOT for TikTok/Instagram (CDN URLs work directly)
              if (
                experimentCheck(
                  Experiment.VIDEO_REDIRECT_WORKAROUND,
                  Constants.API_HOST_LIST.length > 0
                ) &&
                thread.status?.provider !== DataProvider.TikTok &&
                thread.status?.provider !== DataProvider.Instagram
              ) {
                video.url = `https://${Constants.API_HOST_LIST[0]}/2/go?url=${encodeURIComponent(video.url)}`;
              }
              return {
                id: attachmentId,
                /* `gifv` is Mastodon's type for a GIF delivered as a silent looping video, which
                   is exactly what X and Bluesky serve. Clients render it as an auto-looping
                   player; labelling it `video` gets a click-to-play control instead. */
                type: media.type === 'gif' ? 'gifv' : 'video',
                url: video.url,
                preview_url: video.thumbnail_url,
                remote_url: null,
                preview_remote_url: null,
                text_url: null,
                description: null,
                meta: {
                  original: {
                    width: video.width * sizeMultiplier,
                    height: video.height * sizeMultiplier,
                    size: `${video.width * sizeMultiplier}x${video.height * sizeMultiplier}`,
                    aspect: video.width / video.height
                  }
                }
              } as ActivityMediaAttachment;
            default:
              return null;
          }
        })
        .filter(Boolean) as ActivityMediaAttachment[];

      // Merge article media attachments, excluding duplicates by id
      const existingIds = new Set(response.media_attachments.map((a: { id: string }) => a.id));
      const uniqueArticleAttachments = articleAttachments.filter(a => !existingIds.has(a.id));
      response.media_attachments.push(...uniqueArticleAttachments);
    } else if (thread.status.media?.external) {
      const external = thread.status.media.external;
      // Cast the response media attachments to correct type
      response.media_attachments = [
        {
          id: '114163769487684704',
          type: 'video',
          url: external.url,
          preview_url: external.thumbnail_url,
          remote_url: null,
          preview_remote_url: null,
          text_url: null,
          description: null,
          meta: {
            original: {
              width: external.width,
              height: external.height,
              size: `${external.width}x${external.height}`,
              aspect: 1
            }
          }
        } as ActivityMediaAttachment
      ];
    } else if (articleAttachments.length > 0) {
      // If no regular media but we have article media, use article media
      response.media_attachments = articleAttachments;
    }
  }

  return c.json(response);
};
