import { Context } from 'hono';
import { Constants } from '../constants';
import { Strings } from '../strings';
import { getBranding } from '../helpers/branding';

/**
 * oEmbed (https://oembed.com) — the attribution line Discord renders above an embed.
 *
 * Despite returning JSON, this is part of the embed pipeline and not the JSON API:
 * `src/embed/status.ts` emits an `application/json+oembed` link tag pointing at `/owoembed`, and
 * Discord fetches it to fill in the small provider/author line above the card. Every realm needs
 * one, so the shared payload lives here rather than under any single realm; the realm-specific
 * part is only ever *which URLs the fields point at*, which is what each realm's thin route
 * builds before calling {@link oembedResponse}.
 */
export type OEmbed = {
  author_name?: string;
  author_url?: string;
  provider_name?: string;
  provider_url?: string;
  title?: string | null;
  type: 'link' | 'rich';
  version: '1.0';
};

export type OEmbedFields = {
  /** Attribution line, from the `text` query param the link tag stamped in. */
  text: string;
  /** Where the author name links to. */
  authorUrl: string;
  /**
   * Where the provider name links to when the embed asked for a provider line. Defaults to
   * `authorUrl` for providers whose posts have no separate permalink to point at.
   */
  providerUrl?: string;
  /**
   * Show the `provider` query param as the provider name instead of the branding name.
   *
   * Only the X route does this, which is what it did before oEmbed moved here. The param carries
   * two meanings that have never been reconciled: `src/embed/status.ts` stamps in *display text*
   * (a GIF indicator, engagement counts), while `src/routing/identify.ts` reads it as a *realm
   * name*. Reading it as a name in every realm would turn `provider=instagram` — the only form
   * that actually reaches the Instagram route — into a literal "instagram" byline.
   */
  useProviderParamAsName?: boolean;
};

export const oembedResponse = (c: Context, fields: OEmbedFields) => {
  const { searchParams } = new URL(c.req.url);
  const branding = getBranding(c);

  /* Present only when the embed wanted a provider line at all. */
  const provider = searchParams.get('provider');

  const data: OEmbed = {
    author_name: fields.text,
    author_url: fields.authorUrl,
    provider_name: (fields.useProviderParamAsName ? provider : null) ?? branding.name,
    provider_url: provider ? (fields.providerUrl ?? fields.authorUrl) : branding.redirect,
    title: Strings.DEFAULT_AUTHOR_TEXT,
    type: 'rich',
    version: '1.0'
  };

  /* oEmbed is a public, cross-origin-consumed document by design. */
  for (const [header, value] of Object.entries(Constants.API_RESPONSE_HEADERS)) {
    c.header(header, value);
  }

  return c.json(data, 200);
};
