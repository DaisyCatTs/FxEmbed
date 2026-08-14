/**
 * Structured request logging.
 *
 * The Worker previously logged in prose — colo banners, emoji, bare `console.log(url)` — which
 * reads nicely in `wrangler tail` and is nearly useless afterwards. There is no Sentry DSN and no
 * exception webhook configured, so these logs are the only account of what production did. They
 * need to answer, per request: which provider, which realm, did it hit cache, how long did the
 * upstream take, what status came back, and if it failed, why.
 *
 * Everything is emitted as single-line JSON so `wrangler tail --format json` and Logpush can
 * filter on fields rather than grepping sentences.
 *
 * NOTHING here may log a credential. URLs are redacted before they are recorded: signed media
 * tokens, `?cookies=` parameters and API keys have all lived in URLs in this codebase, and a log
 * line is exactly the wrong place for them to resurface.
 */

export type RequestOutcome =
  'ok' | 'not_found' | 'upstream_error' | 'blocked' | 'timeout' | 'error';

export type RequestLogFields = {
  /** Correlates every line emitted for one request. */
  rid: string;
  realm?: string;
  provider?: string;
  /** Cloudflare cache result, when the cache layer ran. */
  cache?: 'hit' | 'miss' | 'skip';
  status?: number;
  outcome?: RequestOutcome;
  /** Milliseconds spent on upstream provider calls. */
  upstreamMs?: number;
  /** Milliseconds for the whole request. */
  totalMs?: number;
  /** Set when a request was refused by the SSRF guard or a token check. */
  blockedReason?: string;
  /** Bot family, not the raw UA string. */
  client?: string;
  [key: string]: unknown;
};

/**
 * Strip anything credential-shaped from a URL before logging it.
 *
 * Keeps host and path shape, which is what makes a log line useful, and drops the query string
 * wholesale rather than trying to enumerate which parameters are sensitive — that list has been
 * wrong before (`?cookies=` was forwarded verbatim for months). Long opaque path segments are
 * masked too, because signed media tokens ride in the path.
 */
export const redactUrl = (input: string | URL): string => {
  const url = typeof input === 'string' ? URL.parse(input) : input;
  if (!url) {
    return '[unparseable]';
  }

  const path = url.pathname
    .split('/')
    .map(segment => (segment.length > 24 ? `[${segment.length}ch]` : segment))
    .join('/');

  return `${url.origin}${path}${url.search ? '?[redacted]' : ''}`;
};

/** Which embedding client this is, by family rather than raw user agent. */
export const clientFamily = (userAgent: string | undefined): string => {
  const ua = (userAgent ?? '').toLowerCase();
  if (!ua) return 'none';
  if (ua.includes('discordbot')) return 'discord';
  if (ua.includes('telegrambot')) return 'telegram';
  if (ua.includes('whatsapp')) return 'whatsapp';
  if (ua.includes('slackbot')) return 'slack';
  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) return 'bot';
  return 'human';
};

const emit = (level: 'info' | 'warn' | 'error', event: string, fields: RequestLogFields): void => {
  /* One line, one JSON object. `console` is the only sink a Worker has by default. */
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export type RequestLogger = {
  readonly rid: string;
  /** Merge fields that later lines (and the summary) should carry. */
  set(fields: Partial<RequestLogFields>): void;
  event(name: string, fields?: Partial<RequestLogFields>): void;
  warn(name: string, fields?: Partial<RequestLogFields>): void;
  error(name: string, fields?: Partial<RequestLogFields>): void;
  /** Emit the one summary line that carries timing and outcome. */
  finish(fields?: Partial<RequestLogFields>): void;
};

/**
 * Create a logger for one request.
 *
 * `crypto.randomUUID()` is available in Workers; the id is truncated because it only has to be
 * unique within a tail session, not globally.
 */
export const createRequestLogger = (request: Request): RequestLogger => {
  const started = Date.now();
  const rid = crypto.randomUUID().slice(0, 8);

  const base: RequestLogFields = {
    rid,
    client: clientFamily(request.headers.get('user-agent') ?? undefined)
  };

  return {
    rid,
    set(fields) {
      Object.assign(base, fields);
    },
    event(name, fields) {
      emit('info', name, { ...base, ...fields });
    },
    warn(name, fields) {
      emit('warn', name, { ...base, ...fields });
    },
    error(name, fields) {
      emit('error', name, { ...base, ...fields });
    },
    finish(fields) {
      emit('info', 'request', { ...base, ...fields, totalMs: Date.now() - started });
    }
  };
};
