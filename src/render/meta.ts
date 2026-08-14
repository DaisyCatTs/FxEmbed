import { escapeAttr, Html } from './html';

/**
 * The single place in the codebase that is allowed to write a `<meta>` or `<link>` tag.
 *
 * Renderers describe the tags they want as data; {@link serializeMeta} turns that data into markup
 * and escapes it. No call site hand-builds `<meta ... content="...">` any more, so there is exactly
 * one function to get right instead of ~40 template literals to remember.
 */

/** A `<link>` tag. Attributes beyond `rel`/`href` are optional and omitted when absent. */
export interface MetaLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
  sizes?: string;
}

/**
 * A tag to emit into `<head>`.
 *
 * `content` accepts {@link Html} for a value that is markup by construction rather than upstream
 * data; anything typed `string` is escaped.
 *
 * `httpEquiv` and `rawHtml` are extra variants beyond property/name/link: the former carries the
 * browser-fallback `<meta http-equiv="refresh">`, the latter a literal element such as a `<style>`
 * block. Both still pass through this serialiser, so the choke point holds.
 */
export type MetaTag =
  | { property: string; content: string | Html }
  | { name: string; content: string | Html }
  | { httpEquiv: string; content: string | Html }
  | { link: MetaLink }
  | { rawHtml: Html };

const attrValue = (content: string | Html): string =>
  content instanceof Html ? content.toString() : escapeAttr(content);

const serializeLink = (link: MetaLink): string => {
  let out = `<link rel="${escapeAttr(link.rel)}" href="${escapeAttr(link.href)}"`;
  if (link.type) {
    out += ` type="${escapeAttr(link.type)}"`;
  }
  if (link.title) {
    out += ` title="${escapeAttr(link.title)}"`;
  }
  if (link.sizes) {
    out += ` sizes="${escapeAttr(link.sizes)}"`;
  }
  return `${out}/>`;
};

const serializeTag = (tag: MetaTag): string => {
  if ('rawHtml' in tag) {
    return tag.rawHtml.toString();
  }
  if ('link' in tag) {
    return serializeLink(tag.link);
  }
  if ('property' in tag) {
    return `<meta property="${escapeAttr(tag.property)}" content="${attrValue(tag.content)}"/>`;
  }
  if ('name' in tag) {
    return `<meta name="${escapeAttr(tag.name)}" content="${attrValue(tag.content)}"/>`;
  }
  return `<meta http-equiv="${escapeAttr(tag.httpEquiv)}" content="${attrValue(tag.content)}"/>`;
};

/** Render a list of tags into `<head>` markup. This is the only escaping choke point. */
export const serializeMeta = (tags: MetaTag[]): Html => new Html(tags.map(serializeTag).join(''));

/**
 * Validate a URL destined for a `content=`/`href=` attribute.
 *
 * Requires https and re-serialises through `URL`, so anything that is not a well-formed absolute
 * https URL comes back as `null` and the caller drops the tag entirely rather than emitting a
 * half-built one. Note this is for URLs only — literal sentinel values such as
 * `twitter:image content="0"` must not go through it.
 */
export const safeMetaUrl = (url: string | null | undefined): string | null => {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};
