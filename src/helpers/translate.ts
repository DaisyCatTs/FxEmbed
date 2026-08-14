import { Context } from 'hono';
import { allowHosts, guardedFetch } from '@fxembed/atmosphere/net';
import type { APIMastodonStatus, APITwitterStatus } from '@fxembed/atmosphere/types/api-schemas';
import { Constants } from '../constants';
import { normalizeLanguage } from './language';

const getDomain = (): string | null => {
  const polyglotDomains: string[] = Constants.POLYGLOT_DOMAIN_LIST;
  if (polyglotDomains.length === 0) {
    return null;
  }

  return polyglotDomains[Math.floor(Math.random() * polyglotDomains.length)];
};

/* Handles translating statuses when asked! */
export const translateStatus = async (
  status: APITwitterStatus | APIBlueskyStatus | APIMastodonStatus | APIStatus,
  _language: string,
  _c: Context
): Promise<PolyglotTranslation | null> => {
  const language = normalizeLanguage(_language);

  console.log('Using Polyglot translation');
  const domain = getDomain();
  if (!domain) {
    return null;
  }
  try {
    /* Pinned to the configured translation host. The Authorization header carries the operator's
       access token, so a redirect off this host would leak it. */
    const response = await guardedFetch(
      `https://${domain}/translate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Constants.POLYGLOT_ACCESS_TOKEN}`,
          'User-Agent': Constants.FRIENDLY_USER_AGENT
        },
        body: JSON.stringify({ text: status.text, source_lang: status.lang, target_lang: language })
      },
      { hostPolicy: allowHosts(domain) }
    );

    const data: PolyglotTranslation = await response.json();

    if (!response.ok) {
      console.error('Polyglot translation failed', data);
      return null;
    }

    console.log('Polyglot translation successful', data.translated_text);

    return data;
  } catch (error) {
    console.error('Polyglot translation failed', error);
    return null;
  }
};
