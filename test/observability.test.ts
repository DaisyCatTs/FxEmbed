import { afterEach, describe, expect, test, vi } from 'vitest';
import { clientFamily, createRequestLogger, redactUrl } from '../src/observability';

describe('redactUrl', () => {
  test('keeps host and path shape', () => {
    expect(redactUrl('https://e.puppygirl.city/jack/status/20')).toEqual(
      'https://e.puppygirl.city/jack/status/20'
    );
  });

  test('drops the query string entirely', () => {
    /* Wholesale rather than per-parameter: the list of "sensitive" params has been wrong before —
       `?cookies=` was forwarded verbatim for months. */
    expect(
      redactUrl('https://cdn.example/video.mp4?cookies=tt_chain_token%3Dsecret&sig=abc')
    ).toEqual('https://cdn.example/video.mp4?[redacted]');
  });

  test('masks long opaque path segments', () => {
    /* Signed media tokens ride in the path, not the query. */
    const token = 'eyJwIjoidGlrdG9rIiwidSI6Imh0dHBz'.repeat(3);
    const redacted = redactUrl(`https://e.puppygirl.city/_/m/${token}/video.mp4`);

    expect(redacted).not.toContain(token);
    expect(redacted).toContain('/_/m/');
    expect(redacted).toContain('video.mp4');
  });

  test('never throws on junk', () => {
    expect(redactUrl('not a url')).toEqual('[unparseable]');
  });
});

describe('clientFamily', () => {
  test.each([
    ['Discordbot/2.0', 'discord'],
    ['TelegramBot (like TwitterBot)', 'telegram'],
    ['WhatsApp/2.0', 'whatsapp'],
    ['Mozilla/5.0 (compatible; SomeCrawler/1.0)', 'bot'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120', 'human'],
    [undefined, 'none']
  ])('%s -> %s', (ua, expected) => {
    expect(clientFamily(ua as string | undefined)).toEqual(expected);
  });
});

describe('createRequestLogger', () => {
  const logs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });

  const capture = () => {
    vi.spyOn(console, 'log').mockImplementation(line => {
      logs.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(line => {
      logs.push(String(line));
    });
  };

  const request = () =>
    new Request('https://e.puppygirl.city/jack/status/20', {
      headers: { 'User-Agent': 'Discordbot/2.0' }
    });

  test('emits single-line JSON with a correlation id', () => {
    capture();
    const log = createRequestLogger(request());
    log.event('resolve');

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.event).toEqual('resolve');
    expect(parsed.rid).toEqual(log.rid);
    expect(parsed.client).toEqual('discord');
  });

  test('every line for a request shares the id, so they can be grouped', () => {
    capture();
    const log = createRequestLogger(request());
    log.event('a');
    log.error('b');
    log.finish();

    const ids = logs.map(l => JSON.parse(l).rid);
    expect(new Set(ids).size).toEqual(1);
  });

  test('fields set once are carried by later lines and the summary', () => {
    capture();
    const log = createRequestLogger(request());
    log.set({ realm: 'twitter', provider: 'twitter' });
    log.event('fetched', { upstreamMs: 120 });
    log.finish({ status: 200, outcome: 'ok' });

    const fetched = JSON.parse(logs[0]);
    expect(fetched.realm).toEqual('twitter');
    expect(fetched.upstreamMs).toEqual(120);

    const summary = JSON.parse(logs[1]);
    expect(summary.event).toEqual('request');
    expect(summary.status).toEqual(200);
    expect(summary.outcome).toEqual('ok');
    expect(typeof summary.totalMs).toEqual('number');
  });

  test('two requests get different ids', () => {
    capture();
    const a = createRequestLogger(request());
    const b = createRequestLogger(request());
    expect(a.rid).not.toEqual(b.rid);
  });
});
