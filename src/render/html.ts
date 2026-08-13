/**
 * Structural HTML escaping.
 *
 * The rule this module enforces is: a plain `string` is untrusted text and gets escaped on the way
 * into a document; only an {@link Html} value — which nothing outside this module can forge — is
 * emitted verbatim. Escaping therefore becomes a property of the type rather than something every
 * call site has to remember to do, which is what previously let upstream display names, alt text
 * and URLs break out of `content="..."`.
 */

/**
 * Opaque marker for a string that is already valid, escaped HTML.
 *
 * It is a class rather than a branded string type on purpose: the tagged template and the meta
 * serialiser need to tell "already escaped" from "raw text" at *runtime*, which a compile-time
 * brand cannot do.
 */
export class Html {
  private readonly value: string;

  constructor(value: string) {
    this.value = value;
  }

  toString(): string {
    return this.value;
  }
}

/**
 * Escape for HTML *text* content (between tags).
 *
 * `&` is replaced first so the ampersands introduced by the later replacements are not themselves
 * re-escaped.
 */
export const escapeText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Escape for a quoted HTML *attribute* value.
 *
 * `&` MUST be escaped first. Escaping it last (what the old `sanitizeText` did by never escaping it
 * at all) means an upstream string containing a literal `&#34;` survives untouched and the HTML
 * parser then decodes it back to `"`, closing the attribute.
 */
export const escapeAttr = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Escape hatch: assert that `value` is already safe HTML.
 *
 * Every use must carry a comment justifying why the string cannot contain attacker-controlled
 * markup. There should only ever be a handful.
 */
export const raw = (value: string): Html => new Html(value);

/** Values an `html` template is allowed to interpolate. */
export type HtmlValue = Html | string | number | boolean | null | undefined | HtmlValue[];

const interpolateValue = (value: HtmlValue): string => {
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (value instanceof Html) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(interpolateValue).join('');
  }
  /* Attribute escaping is a superset of text escaping, so using it unconditionally is correct in
     both contexts and removes the need for the template to know which one it is in. */
  return escapeAttr(String(value));
};

/**
 * Tagged template that escapes every interpolated value unless it is already {@link Html}.
 *
 * ```ts
 * html`<h1>${untrustedName}</h1>`
 * ```
 */
export const html = (strings: TemplateStringsArray, ...values: HtmlValue[]): Html => {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += interpolateValue(values[i]) + strings[i + 1];
  }
  return new Html(out);
};
