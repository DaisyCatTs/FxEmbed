import i18next from 'i18next';
import { Constants } from '../constants';
import { Experiment, experimentCheck } from '../experiments';
import { handleQuote } from '../helpers/quote';
import { DataProvider } from '../enum';
import type { APITwitterStatus } from '../realms/api/schemas';
import { getBranding } from '../helpers/branding';
import { getGIFTranscodeDomain, shouldTranscodeGif } from '../helpers/giftranscode';
import { getVideoTranscodeDomain, getVideoTranscodeDomainBluesky } from '../helpers/transcode';
import { interpolate } from '../strings';
import { MetaTag, safeMetaUrl } from './meta';

export const renderVideo = (
  properties: RenderProperties,
  video: APIVideo
): ResponseInstructions => {
  const { status, userAgent, text } = properties;
  const instructions: ResponseInstructions = { addHeaders: [] };

  const all = status.media?.all as APIMedia[];

  /* This fix is specific to Discord not wanting to render videos that are too large,
      or rendering low quality videos too small.
      
      Basically, our solution is to cut the dimensions in half if the video is too big (> 1080p),
      or double them if it's too small. (<400p)
      
      We check both height and width so we can apply this to both horizontal and vertical videos equally*/

  let sizeMultiplier = 1;

  if (video.width > 1920 || video.height > 1920) {
    sizeMultiplier = 0.5;
  }
  if (video.width < 400 && video.height < 400) {
    sizeMultiplier = 2;
  }

  /* Like photos when picking a specific one (not using mosaic),
      we'll put an indicator if there are more than one video */
  if (all && all.length > 1 && (userAgent?.indexOf('TelegramBot') ?? 0) > -1) {
    const baseString =
      all.length === status.media?.videos?.length
        ? i18next.t('videoCount')
        : i18next.t('mediaCount');
    const videoCounter = interpolate(baseString, {
      number: String(all.indexOf(video) + 1),
      total: String(all.length)
    });

    instructions.siteName = `${getBranding(properties.context).name} - ${videoCounter}`;
  }

  if (status.provider === 'twitter') {
    instructions.authorText = (status as APITwitterStatus).translation?.text || text || '';
  } else {
    instructions.authorText = text || '';
  }

  if ((instructions.authorText ?? '').length < 40 && status.quote) {
    const q = handleQuote(status.quote);
    if (q) instructions.authorText += `\n${q}`;
  }

  let url = video.url;

  if (
    status.provider !== DataProvider.Bluesky &&
    shouldTranscodeGif(properties.context) &&
    video.type === 'gif'
  ) {
    url = video.url.replace(
      Constants.TWITTER_VIDEO_BASE,
      `https://${getGIFTranscodeDomain(status.id)}`
    );
    console.log('We passed checks for transcoding GIFs, feeding embed url', url);
  }

  // console.log('status', status);
  console.log('provider', status.provider);

  // Apply video redirect workaround for Discord/Telegram, but NOT for TikTok
  // TikTok videos need their own proxy with specific cookies/headers
  if (
    experimentCheck(Experiment.KITCHENSINK_VIDEO, userAgent?.includes('TelegramBot')) &&
    status.provider !== DataProvider.TikTok
  ) {
    const domain =
      status.provider === DataProvider.Twitter
        ? getVideoTranscodeDomain(status.id)
        : getVideoTranscodeDomainBluesky(status.id);
    url = `https://${domain}${new URL(url).pathname}`;
  } else if (
    experimentCheck(Experiment.VIDEO_REDIRECT_WORKAROUND, Constants.API_HOST_LIST.length > 0) &&
    (userAgent?.includes('Discordbot') || userAgent?.includes('TelegramBot')) &&
    status.provider !== DataProvider.TikTok
  ) {
    url = `https://${Constants.API_HOST_LIST[0]}/2/go?url=${encodeURIComponent(url)}`;
  }

  /* Push the video-related tags */
  const streamUrl = safeMetaUrl(url);
  const thumbnailUrl = safeMetaUrl(video.thumbnail_url);
  const tags: MetaTag[] = [
    { property: 'twitter:player:height', content: String(video.height * sizeMultiplier) },
    { property: 'twitter:player:width', content: String(video.width * sizeMultiplier) }
  ];

  if (streamUrl) {
    tags.push(
      { property: 'twitter:player:stream', content: streamUrl },
      { property: 'twitter:player:stream:content_type', content: String(video.format) },
      { property: 'og:video', content: streamUrl },
      { property: 'og:video:secure_url', content: streamUrl }
    );
  }

  tags.push(
    { property: 'og:video:height', content: String(video.height * sizeMultiplier) },
    { property: 'og:video:width', content: String(video.width * sizeMultiplier) },
    { property: 'og:video:type', content: String(video.format) }
  );

  if (thumbnailUrl) {
    tags.push({ property: 'og:image', content: thumbnailUrl });
  }

  /* Not a URL — a sentinel that tells Twitter-card consumers there is no card image. */
  tags.push({ property: 'twitter:image', content: '0' });

  instructions.addHeaders = tags;

  return instructions;
};
