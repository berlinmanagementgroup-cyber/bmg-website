/* Unit tests for submit-inquiry.js's own control flow, with global.fetch mocked so no real
 * network call (to Formspree or OpenAI) ever happens. No credentials required - CONTEXT is
 * deliberately left unset/non-production here, which is also what proves the production-
 * context guard does its job even when OPENAI_PIXEL_ID/OPENAI_CONVERSIONS_API_KEY happen to
 * be set (simulating a misconfigured "available in all contexts" secret).
 * Run with: node --test netlify/functions/__tests__/submit-inquiry.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');

function withMockedFetch(responses, fn) {
  var original = global.fetch;
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, opts: opts });
    var next = responses.shift();
    if (!next) {
      throw new Error('no more mocked responses configured');
    }
    if (next.throw) {
      throw next.throw;
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async function () {
        return next.body;
      }
    };
  };
  return Promise.resolve()
    .then(function () {
      return fn(calls);
    })
    .finally(function () {
      global.fetch = original;
    });
}

function freshHandler() {
  // submit-inquiry.js and lib/openai-capi.js hold no module-level state, so re-requiring
  // after clearing the cache isn't strictly necessary, but keeps each test's mocked fetch
  // isolated from any other test's require cache assumptions.
  delete require.cache[require.resolve('../submit-inquiry.js')];
  delete require.cache[require.resolve('../lib/openai-capi.js')];
  return require('../submit-inquiry.js');
}

test('rejects a request missing required fields before ever calling fetch', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch([], async function (calls) {
    var handler = freshHandler();
    var res = await handler.handler({
      httpMethod: 'POST',
      body: JSON.stringify({ name: 'Test' }) // no email, no problem
    });
    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });
});

test('passes through Formspree\'s own error status/body on failure', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch(
    [{ status: 422, body: JSON.stringify({ errors: [{ message: 'bad field' }] }) }],
    async function (calls) {
      var handler = freshHandler();
      var res = await handler.handler({
        httpMethod: 'POST',
        body: JSON.stringify({ email: 'a@example.com', problem: 'x' })
      });
      assert.equal(res.statusCode, 422);
      assert.ok(res.body.indexOf('bad field') !== -1);
      assert.equal(calls.length, 1, 'must not attempt an OpenAI call when Formspree itself failed');
    }
  );
});

test('on Formspree success, returns 200 and does not forward to OpenAI outside the production context', async function () {
  process.env.CONTEXT = 'deploy-preview'; // simulate a preview, even with creds "available"
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  try {
    await withMockedFetch(
      [{ status: 200, body: JSON.stringify({ ok: true }) }],
      async function (calls) {
        var handler = freshHandler();
        var res = await handler.handler({
          httpMethod: 'POST',
          body: JSON.stringify({
            email: 'a@example.com',
            problem: 'x',
            oppref: 'TESTOPPREF',
            source_url: 'https://berlinmanagementgroup.ai/contact/'
          })
        });
        assert.equal(res.statusCode, 200);
        // Exactly one network call: to Formspree. The OpenAI call must have been skipped by
        // the production-context guard, not attempted and failed.
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.indexOf('formspree.io') !== -1);
      }
    );
  } finally {
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('on Formspree success in production context with real-shaped credentials, also calls OpenAI', async function () {
  process.env.CONTEXT = 'production';
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  try {
    await withMockedFetch(
      [
        { status: 200, body: JSON.stringify({ ok: true }) }, // Formspree
        { status: 200, body: JSON.stringify({ accepted: true }) } // OpenAI CAPI
      ],
      async function (calls) {
        var handler = freshHandler();
        var res = await handler.handler({
          httpMethod: 'POST',
          body: JSON.stringify({
            email: 'a@example.com',
            problem: 'x',
            oppref: 'TESTOPPREF',
            source_url: 'https://berlinmanagementgroup.ai/contact/'
          })
        });
        assert.equal(res.statusCode, 200);
        assert.equal(calls.length, 2, 'Formspree, then OpenAI');
        assert.ok(calls[0].url.indexOf('formspree.io') !== -1);
        assert.ok(calls[1].url.indexOf('bzr.openai.com') !== -1);
      }
    );
  } finally {
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('an OpenAI-side failure after Formspree succeeds still returns 200 to the browser (lead capture is never blocked by ad tracking)', async function () {
  process.env.CONTEXT = 'production';
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  try {
    await withMockedFetch(
      [
        { status: 200, body: JSON.stringify({ ok: true }) }, // Formspree succeeds
        { throw: new Error('simulated network failure') }, // OpenAI attempt 1
        { throw: new Error('simulated network failure') } // OpenAI attempt 2 (retry)
      ],
      async function (calls) {
        var handler = freshHandler();
        var res = await handler.handler({
          httpMethod: 'POST',
          body: JSON.stringify({ email: 'a@example.com', problem: 'x', source_url: 'https://berlinmanagementgroup.ai/contact/' })
        });
        assert.equal(res.statusCode, 200);
        assert.equal(calls.length, 3, 'Formspree once, OpenAI attempted twice (retry) before giving up');
      }
    );
  } finally {
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('rejects non-POST methods', async function () {
  var handler = freshHandler();
  var res = await handler.handler({ httpMethod: 'GET', body: '' });
  assert.equal(res.statusCode, 405);
});
