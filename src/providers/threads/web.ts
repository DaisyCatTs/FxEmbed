/**
 * Threads' public web root.
 *
 * The atmosphere processor builds permalinks against the same origin. It lives here rather than in
 * `src/constants.ts` because it is a fixed upstream address, not an operator-tunable one, so it
 * needs none of the esbuild env-inlining plumbing a `process.env` constant would drag along.
 */
export const THREADS_WEB_ROOT = 'https://www.threads.com';
