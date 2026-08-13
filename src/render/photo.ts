import i18next from 'i18next';
import { interpolate, Strings } from '../strings';
import { getBranding } from '../helpers/branding';
import { proxyTwitterPostPhotoUrl, shouldProxyTelegramPbsPhotos } from '../helpers/pbsProxy';
import { MetaTag, safeMetaUrl } from './meta';

export const renderPhoto = (
  properties: RenderProperties,
  photo: APIPhoto | APIMosaicPhoto
): ResponseInstructions => {
  const { status, engagementText, authorText, isOverrideMedia, userAgent } = properties;
  const instructions: ResponseInstructions = { addHeaders: [] };
  const isTelegram = (userAgent ?? '').includes('TelegramBot');

  if ((status.media?.photos?.length || 0) > 1 && (!status.media?.mosaic || isOverrideMedia)) {
    const all = status.media?.all as APIMedia[];
    const baseString =
      all.length === status.media?.photos?.length
        ? i18next.t('photoCount')
        : i18next.t('mediaCount');

    const photoCounter = interpolate(baseString, {
      number: String(all.indexOf(photo) + 1),
      total: String(all.length)
    });

    if (authorText === Strings.DEFAULT_AUTHOR_TEXT || isTelegram) {
      instructions.authorText = photoCounter;
    } else {
      instructions.authorText = `${authorText}${authorText ? '   ―   ' : ''}${photoCounter}`;
    }
    const brandingName = getBranding(properties.context).name;
    if (engagementText && !isTelegram) {
      instructions.siteName = `${brandingName} - ${engagementText} - ${photoCounter}`;
    } else {
      instructions.siteName = `${brandingName} - ${photoCounter}`;
    }
  }

  console.log('photo!', photo);

  const tags: MetaTag[] = [];

  if (photo.type === 'mosaic_photo' && !isOverrideMedia) {
    const mosaicUrl = safeMetaUrl(photo.formats.jpeg);
    if (mosaicUrl) {
      tags.push(
        { property: 'twitter:image', content: mosaicUrl },
        { property: 'og:image', content: mosaicUrl }
      );
    }
  } else {
    photo = photo as APIPhoto;
    const proxyPbs = shouldProxyTelegramPbsPhotos(isTelegram);
    const photoUrl = safeMetaUrl(proxyTwitterPostPhotoUrl(photo.url, proxyPbs));
    if (photoUrl) {
      tags.push(
        { property: 'twitter:image', content: photoUrl },
        { property: 'og:image', content: photoUrl },
        { property: 'twitter:image:width', content: String(photo.width) },
        { property: 'twitter:image:height', content: String(photo.height) },
        { property: 'og:image:width', content: String(photo.width) },
        { property: 'og:image:height', content: String(photo.height) }
      );
      /* Alt text is entirely user-controlled and was previously interpolated raw into
         content="...". It is escaped by serializeMeta now; it only makes sense alongside the
         image itself, so it lives inside this branch. */
      if (photo.altText) {
        tags.push(
          { property: 'twitter:image:alt', content: photo.altText },
          { property: 'og:image:alt', content: photo.altText }
        );
      }
    }
  }

  instructions.addHeaders = tags;

  return instructions;
};
