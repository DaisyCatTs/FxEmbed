import { test, expect } from 'vitest';
import { app } from '../src/worker';
import harness from './helpers/harness';
import { botHeaders, brandingFor, humanHeaders, twitterBaseUrl } from './helpers/data';

/* The home page redirects to whatever the matching branding zone configures. */
const homeRedirect = brandingFor('fxtwitter.com').redirect;

test('Home page redirect', async () => {
  const result = await app.request(
    new Request('https://fxtwitter.com', {
      method: 'GET',
      headers: botHeaders
    }),
    undefined,
    harness
  );
  const resultHuman = await app.request(
    new Request('https://fxtwitter.com', {
      method: 'GET',
      headers: humanHeaders
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(302);
  expect(result.headers.get('location')).toEqual(homeRedirect);
  expect(resultHuman.status).toEqual(302);
  expect(resultHuman.headers.get('location')).toEqual(homeRedirect);
});

test('Status redirect human', async () => {
  const result = await app.request(
    new Request('https://fxtwitter.com/jack/status/20', {
      method: 'GET',
      headers: humanHeaders
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(302);
  expect(result.headers.get('location')).toEqual(`${twitterBaseUrl}/jack/status/20`);
});

test('Status redirect human trailing slash', async () => {
  const result = await app.request(
    new Request('https://fxtwitter.com/jack/status/20/', {
      method: 'GET',
      headers: humanHeaders
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(302);
  expect(result.headers.get('location')).toEqual(`${twitterBaseUrl}/jack/status/20`);
});

test('Status redirect human custom base redirect', async () => {
  const result = await app.request(
    new Request('https://fxtwitter.com/jack/status/20', {
      method: 'GET',
      headers: {
        ...humanHeaders,
        Cookie: 'cf_clearance=a; base_redirect=https://nitter.net'
      }
    }),
    undefined,
    harness
  );
  expect(result.status).toEqual(302);
  expect(result.headers.get('location')).toEqual('https://nitter.net/jack/status/20');
});

test('Twitter moment redirect', async () => {
  const result = await app.request(
    new Request(
      'https://fxtwitter.com/i/events/1572638642127966214?t=0UK7Ny-Jnsp-dUGzlb-M8w&s=35',
      {
        method: 'GET',
        headers: botHeaders
      }
    ),
    undefined,
    harness
  );
  expect(result.status).toEqual(302);
  expect(result.headers.get('location')).toEqual(`${twitterBaseUrl}/i/events/1572638642127966214`);
});
