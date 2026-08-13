import { test, expect } from 'vitest';
import {
  parseHomePageSignals,
  parseMigrationPage
} from '@fxembed/atmosphere/providers/twitter/proxy/transaction/html';

/*
 * These cover the HTMLRewriter-based replacements for the cheerio queries the
 * x-client-transaction-id flow used to run. The fixtures mirror the shape of x.com's migration
 * interstitial and the animation frames embedded in the home page.
 */

const HOME_PAGE = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="twitter-site-verification" content="dGVzdC1rZXktdmFsdWU=">
    <script>window.__INITIAL_STATE__={a:1};</script>
  </head>
  <body>
    <svg id="loading-x-anim-0" viewBox="0 0 108 108">
      <g><path d="ignored" fill="none"/><path d="M 0 0 C 10 20 30 40 50 60 C 1 2 3 4 5 6"/></g>
    </svg>
    <svg id="loading-x-anim-1">
      <g><path d="ignored"/><path d="M 9 9 C 90 80 70 60 50 40"></path></g>
    </svg>
    <svg id="loading-x-anim-2">
      <g><path d="ignored"/><path d="M 1 1 C 11 12 13 14 15 16"/></g>
    </svg>
    <svg id="loading-x-anim-3">
      <g><path d="ignored"/><path d="M 2 2 C 21 22 23 24 25 26"/></g>
    </svg>
  </body>
</html>`;

test('parseHomePageSignals reads the verification key and every animation frame path', async () => {
  const signals = await parseHomePageSignals(HOME_PAGE);
  expect(signals.key).toBe('dGVzdC1rZXktdmFsdWU=');
  expect(signals.framePaths).toEqual([
    'M 0 0 C 10 20 30 40 50 60 C 1 2 3 4 5 6',
    'M 9 9 C 90 80 70 60 50 40',
    'M 1 1 C 11 12 13 14 15 16',
    'M 2 2 C 21 22 23 24 25 26'
  ]);
});

test('parseHomePageSignals reports missing signals instead of inventing them', async () => {
  const signals = await parseHomePageSignals('<html><body><p>nothing here</p></body></html>');
  expect(signals.key).toBeNull();
  expect(signals.framePaths).toEqual([]);
});

test('parseHomePageSignals leaves a null slot for a frame with no second path', async () => {
  const signals = await parseHomePageSignals(
    `<svg id="loading-x-anim-0"><g><path d="only-one"/></g></svg>
     <svg id="loading-x-anim-1"><g><path d="a"/><path d="M 5 5 C 1 2 3 4 5 6"/></g></svg>`
  );
  expect(signals.framePaths).toEqual([null, 'M 5 5 C 1 2 3 4 5 6']);
});

test('parseMigrationPage finds the migration URL in the meta refresh tag', async () => {
  const page = await parseMigrationPage(
    `<html><head><meta http-equiv="refresh" content="0; url=https://x.com/x/migrate?tok=abc-123_XYZ"></head><body></body></html>`
  );
  expect(page.migrationUrl).toBe('https://x.com/x/migrate?tok=abc-123_XYZ');
  expect(page.form).toBeNull();
});

test('parseMigrationPage falls back to scanning the document when there is no meta refresh', async () => {
  const page = await parseMigrationPage(
    `<html><body><script>location.href="https://twitter.com/x/migrate?tok=fallback99";</script></body></html>`
  );
  expect(page.migrationUrl).toBe('https://twitter.com/x/migrate?tok=fallback99');
});

test('parseMigrationPage extracts the self-submitting form and its inputs', async () => {
  const page = await parseMigrationPage(
    `<html><body><form name="f" action="https://x.com/x/migrate" method="post">
       <input type="hidden" name="tok" value="tok-value">
       <input type="hidden" name="data" value="">
       <input type="hidden" value="no-name-is-skipped">
       <input type="submit" name="commit" value="Yes">
     </form></body></html>`
  );
  expect(page.form).toEqual({
    action: 'https://x.com/x/migrate',
    method: 'POST',
    fields: { tok: 'tok-value', data: '', commit: 'Yes' }
  });
});

test('parseMigrationPage matches the migrate form by action when it has no name', async () => {
  const page = await parseMigrationPage(
    `<form action="https://x.com/x/migrate"><input name="tok" value="t"></form>`
  );
  /* No method attribute defaults to POST, mirroring the previous cheerio behaviour. */
  expect(page.form).toEqual({
    action: 'https://x.com/x/migrate',
    method: 'POST',
    fields: { tok: 't' }
  });
});

test('parseMigrationPage prefers the named form over the action-matched one', async () => {
  const page = await parseMigrationPage(
    `<form action="https://x.com/x/migrate"><input name="wrong" value="1"></form>
     <form name="f" action="https://x.com/other" method="GET"><input name="right" value="2"></form>`
  );
  expect(page.form).toEqual({
    action: 'https://x.com/other',
    method: 'GET',
    fields: { right: '2' }
  });
});

test('parseMigrationPage returns nothing for an ordinary page', async () => {
  const page = await parseMigrationPage(HOME_PAGE);
  expect(page.migrationUrl).toBeNull();
  expect(page.form).toBeNull();
});
