import { expect, test } from 'vitest';
import { ActivityStatus } from '../src/types/types';
import { app } from '../src/worker';
import harness from './helpers/harness';
import { encodeSnowcode } from '../src/helpers/snowcode';
import { botHeaders } from './helpers/data';

/**
 * Discord does not read our OpenGraph tags for these posts — it is handed a pointer to
 * /api/v1/statuses/:snowcode and renders whatever the Mastodon-shaped payload says. The link
 * preview therefore lives entirely in `card`, and the poll in `poll`.
 */

const getActivity = async (data: object): Promise<Response> =>
  app.request(
    new Request(`https://fxtwitter.com/api/v1/statuses/${encodeSnowcode(data)}`, {
      method: 'GET',
      headers: botHeaders
    }),
    undefined,
    harness
  );

const getActivityJson = async (data: object): Promise<ActivityStatus> => {
  const result = await getActivity(data);
  expect(result.status).toEqual(200);
  return (await result.json()) as ActivityStatus;
};

test('Article card is surfaced as a Mastodon preview card', async () => {
  const response = await getActivityJson({ i: '991778' });

  expect(response.card).toBeTruthy();
  expect(response.card?.type).toEqual('link');
  expect(response.card?.title).toEqual('A Very Newsworthy Article');
  expect(response.card?.description).toEqual(
    'Everything you never wanted to know about link previews.'
  );
  /* The card URL upstream is a t.co short link; the destination is what a client should show. */
  expect(response.card?.url).toEqual('https://www.example.com/article');
  expect(response.card?.provider_name).toEqual('example.com');
  expect(response.card?.image).toEqual(
    'https://pbs.twimg.com/card_img/991778/article.jpg?name=800x419'
  );
  expect(response.card?.image_description).toEqual('A photo of an article');
  expect(response.card?.width).toEqual(800);
  expect(response.card?.height).toEqual(419);
  expect(response.card?.html).toEqual('');
});

test('Player card is surfaced as a video preview card', async () => {
  const response = await getActivityJson({ i: '991780' });

  expect(response.card).toBeTruthy();
  expect(response.card?.type).toEqual('video');
  expect(response.card?.embed_url).toEqual('https://www.youtube.com/embed/dQw4w9WgXcQ');
  expect(response.card?.provider_name).toEqual('youtube.com');
  expect(response.card?.image).toEqual('https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg');
  expect(response.card?.width).toEqual(1280);
  expect(response.card?.height).toEqual(720);
  /* An iframe embed must never be handed over as markup we did not build. */
  expect(response.card?.html).toEqual('');
});

test('Status without a card keeps card null', async () => {
  const response = await getActivityJson({ i: '20' });
  expect(response.card).toBeNull();

  /* A status with plain media must not have a card invented for it either. */
  const withMedia = await getActivityJson({ i: '1848831595014459513' });
  expect(withMedia.card).toBeNull();
});

test('Malicious card text does not break the payload', async () => {
  const result = await getActivity({ i: '991779' });
  expect(result.status).toEqual(200);
  const body = await result.text();
  /* Payload must still be parseable JSON with the hostile text carried verbatim, not injected. */
  const response = JSON.parse(body) as ActivityStatus;

  expect(body).not.toContain('<script>alert("pwned")</script>');
  expect(response.card?.title).toEqual('</script><script>alert("pwned")</script>');
  expect(response.card?.description).toEqual('"><img src=x onerror=alert(1)> & </title>');
  expect(response.card?.provider_name).toEqual('evil"><b>.example');
  expect(response.card?.url).toEqual('https://evil.example/x?a=1&b=2');
  /* A javascript: image URL is dropped rather than handed to a client. */
  expect(response.card?.image).toBeNull();
});

test('Card with a non-http URL is dropped entirely', async () => {
  const response = await getActivityJson({ i: '991781' });
  expect(response.card).toBeNull();
});

test('Poll is surfaced alongside the rendered poll text', async () => {
  const response = await getActivityJson({ i: '1899954694652309701' });

  expect(response.poll).toBeTruthy();
  expect(response.poll?.id).toEqual('1899954694652309701');
  expect(response.poll?.multiple).toEqual(false);
  expect(response.poll?.expired).toEqual(true);
  expect(response.poll?.votes_count).toEqual(22);
  expect(response.poll?.voters_count).toEqual(22);
  expect(response.poll?.options).toEqual([
    { title: 'MISC Freelancer', votes_count: 2 },
    { title: 'Anvil Carrack', votes_count: 6 },
    { title: 'Drake Cutlass (Any?)', votes_count: 5 },
    { title: 'Origin 600i', votes_count: 9 }
  ]);
});

test('Status without a poll keeps poll null', async () => {
  const response = await getActivityJson({ i: '20' });
  expect(response.poll).toBeNull();
});
