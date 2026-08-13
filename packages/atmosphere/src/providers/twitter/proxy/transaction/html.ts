/*
 * HTML extraction for the x-client-transaction-id flow.
 *
 * These used to be cheerio (`load($)`) queries, which dragged parse5 + htmlparser2 +
 * domhandler + css-select + domutils + entities + nth-check into the Worker bundle for a
 * handful of attribute reads. The Workers runtime already ships a streaming HTML parser
 * (`HTMLRewriter`), so the same reads are expressed as element handlers here and the
 * dependency is gone.
 *
 * Everything in this file is pure (string in, extracted values out) so it can be unit tested
 * without touching the network.
 */

/* Minimal structural typing for the Workers `HTMLRewriter` global. @cloudflare/workers-types
   is not wired into this package's tsconfig, so we describe only the surface we use. */
interface RewriterElement {
  getAttribute(name: string): string | null;
}

interface RewriterElementHandler {
  element(element: RewriterElement): void;
}

interface Rewriter {
  on(selector: string, handlers: RewriterElementHandler): Rewriter;
  transform(response: Response): Response;
}

type RewriterConstructor = new () => Rewriter;

/**
 * Run a set of element handlers over an HTML string.
 *
 * `HTMLRewriter` is a streaming transformer: handlers only fire while the body is consumed,
 * and they fire in document order (a start tag before any of its descendants), which is what
 * lets `collectHomePageSignals` attribute each animation path to the frame it belongs to.
 */
async function scanHtml(html: string, register: (rewriter: Rewriter) => Rewriter): Promise<void> {
  const HTMLRewriterCtor = (globalThis as unknown as { HTMLRewriter?: RewriterConstructor })
    .HTMLRewriter;
  if (!HTMLRewriterCtor) {
    throw new Error('HTMLRewriter is not available in this runtime');
  }
  /* Consume the transformed stream; the return value is discarded, we only want the handlers. */
  await register(new HTMLRewriterCtor()).transform(new Response(html)).text();
}

export const MIGRATION_URL_REGEX =
  /(https?:\/\/(?:www\.)?(?:twitter|x)\.com(?:\/x)?\/migrate[/?]tok=[A-Za-z0-9%\-_]+)/;

export const DEFAULT_MIGRATION_ACTION = 'https://x.com/x/migrate';

export interface MigrationForm {
  action: string;
  method: string;
  fields: Record<string, string>;
}

interface FormCandidate {
  found: boolean;
  action: string | null;
  method: string | null;
  fields: Record<string, string>;
}

const newFormCandidate = (): FormCandidate => ({
  found: false,
  action: null,
  method: null,
  fields: {}
});

export interface MigrationPage {
  /** Redirect target found in the `<meta http-equiv="refresh">` tag, or anywhere in the page. */
  migrationUrl: string | null;
  /** The interstitial's POST/GET form, if this page is one. */
  form: MigrationForm | null;
}

/**
 * Read the two things x.com's migration interstitial can carry: a meta-refresh redirect and a
 * self-submitting form.
 *
 * The form is preferred by `name="f"`, falling back to `action="https://x.com/x/migrate"`,
 * matching the selectors the cheerio implementation used.
 */
export async function parseMigrationPage(html: string): Promise<MigrationPage> {
  /* Handlers mutate these holders rather than closed-over `let` bindings so TypeScript's
     control-flow analysis doesn't narrow them to their initial values. */
  const meta = { content: null as string | null };
  const named: FormCandidate = newFormCandidate();
  const byAction: FormCandidate = newFormCandidate();

  const readForm = (candidate: FormCandidate, element: RewriterElement) => {
    /* First matching form wins, like `.attr()` on a cheerio selection. */
    if (candidate.found) {
      return;
    }
    candidate.found = true;
    candidate.action = element.getAttribute('action');
    candidate.method = element.getAttribute('method');
  };

  const readInput = (candidate: FormCandidate, element: RewriterElement) => {
    const name = element.getAttribute('name');
    if (name) {
      candidate.fields[name] = element.getAttribute('value') ?? '';
    }
  };

  await scanHtml(html, rewriter =>
    rewriter
      .on('meta[http-equiv="refresh"]', {
        element(element) {
          meta.content ??= element.getAttribute('content');
        }
      })
      .on('form[name="f"]', {
        element(element) {
          readForm(named, element);
        }
      })
      .on('form[name="f"] input', {
        element(element) {
          readInput(named, element);
        }
      })
      .on(`form[action="${DEFAULT_MIGRATION_ACTION}"]`, {
        element(element) {
          readForm(byAction, element);
        }
      })
      .on(`form[action="${DEFAULT_MIGRATION_ACTION}"] input`, {
        element(element) {
          readInput(byAction, element);
        }
      })
  );

  const chosen = named.found ? named : byAction.found ? byAction : null;
  const form: MigrationForm | null = chosen
    ? {
        action: chosen.action || DEFAULT_MIGRATION_ACTION,
        method: (chosen.method || 'POST').toUpperCase(),
        fields: chosen.fields
      }
    : null;

  /* The meta tag is the documented carrier, but the token also appears in inline script on some
     variants of the interstitial, so fall back to a scan of the whole document. */
  const migrationUrl =
    (meta.content ? MIGRATION_URL_REGEX.exec(meta.content)?.[1] : undefined) ??
    MIGRATION_URL_REGEX.exec(html)?.[1] ??
    null;

  return { migrationUrl, form };
}

export interface HomePageSignals {
  /** `content` of `<meta name="twitter-site-verification">` — the base64 transaction key. */
  key: string | null;
  /**
   * `d` of the second path of the first child of each `id^="loading-x-anim"` element, in
   * document order. Entries are `null` when a frame is present but has no such path.
   */
  framePaths: (string | null)[];
}

/**
 * Extract the transaction key and animation frame paths from an x.com home page.
 */
export async function parseHomePageSignals(html: string): Promise<HomePageSignals> {
  const verification = { key: null as string | null };
  const framePaths: (string | null)[] = [];

  await scanHtml(html, rewriter =>
    rewriter
      .on('[name="twitter-site-verification"]', {
        element(element) {
          verification.key ??= element.getAttribute('content');
        }
      })
      .on('[id^="loading-x-anim"]', {
        element() {
          /* Opens a slot for this frame; the path handler below fills it. Start tags are
             emitted before their descendants, so the slot always exists in time. */
          framePaths.push(null);
        }
      })
      /* cheerio equivalent: `$frame.children().first().children().eq(1).attr('d')`. */
      .on('[id^="loading-x-anim"] > *:first-child > *:nth-child(2)', {
        element(element) {
          if (framePaths.length > 0) {
            framePaths[framePaths.length - 1] = element.getAttribute('d');
          }
        }
      })
  );

  return { key: verification.key, framePaths };
}
