import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Checklist Q-14: when the server is gone the page says so in words, not the browser's "Failed to fetch". */
test('a request to a TeamBot that is not running fails with a plain message (status 0)', async () => {
  const g = globalThis as any;
  const orig = g.fetch;
  g.location ??= { hash: '', href: 'http://localhost/' };
  g.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    // A computed path: the browser module needs the DOM types, which the server typecheck does not load.
    const { api, UNREACHABLE } = await import('../ui/src/lib/' + 'api.js');
    await assert.rejects(api.get('/routines'), (e: any) => e.message === UNREACHABLE && e.status === 0 && !/Failed to fetch/.test(e.message));
    // A cancelled request stays a cancellation.
    g.fetch = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await assert.rejects(api.get('/routines'), (e: any) => e.name === 'AbortError');
  } finally {
    g.fetch = orig;
  }
});
