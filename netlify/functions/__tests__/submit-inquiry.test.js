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
        { throw: new Error('simulated network failure') } // OpenAI's single bounded attempt
      ],
      async function (calls) {
        var handler = freshHandler();
        var res = await handler.handler({
          httpMethod: 'POST',
          body: JSON.stringify({ email: 'a@example.com', problem: 'x', source_url: 'https://berlinmanagementgroup.ai/contact/' })
        });
        assert.equal(res.statusCode, 200);
        // submit-inquiry.js deliberately passes attempts:1 to sendConversion (not the
        // library's default of 2) specifically so a slow/failing OpenAI leg can never push
        // this request past the browser's own 15s AbortController after Formspree has
        // *already* accepted the submission - that would show the visitor a false failure
        // and risk a genuine duplicate inquiry on retry. See the comment in submit-inquiry.js.
        assert.equal(calls.length, 2, 'Formspree once, OpenAI attempted exactly once (bounded, no inline retry here)');
      }
    );
  } finally {
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('forwards a Referer matching the visitor\'s real page to Formspree, to stay compatible with "Restrict to Domain"', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch([{ status: 200, body: '{}' }], async function (calls) {
    var handler = freshHandler();
    await handler.handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'a@example.com',
        problem: 'x',
        source_url: 'https://berlinmanagementgroup.ai/contact/?utm_source=chatgpt'
      })
    });
    assert.equal(calls[0].opts.headers.Referer, 'https://berlinmanagementgroup.ai/contact/?utm_source=chatgpt');
  });
});

test('falls back to a safe default Referer when source_url is missing or is not this site (never forwards an attacker-supplied Referer unchecked)', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch([{ status: 200, body: '{}' }], async function (calls) {
    var handler = freshHandler();
    await handler.handler({
      httpMethod: 'POST',
      body: JSON.stringify({
        email: 'a@example.com',
        problem: 'x',
        source_url: 'https://evil.example/not-this-site/'
      })
    });
    assert.equal(calls[0].opts.headers.Referer, 'https://berlinmanagementgroup.ai/contact/');
  });
});

test('a hanging OpenAI call is aborted within its bounded timeout rather than holding the response open', async function () {
  process.env.CONTEXT = 'production';
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  var original = global.fetch;
  try {
    var callCount = 0;
    global.fetch = async function (url, opts) {
      callCount++;
      if (url.indexOf('formspree.io') !== -1) {
        return { ok: true, status: 200, text: async function () { return '{}'; } };
      }
      // Simulate a hang: never resolve on its own, only react to the abort signal - exactly
      // what a real fetch does when its AbortController fires.
      return new Promise(function (resolve, reject) {
        opts.signal.addEventListener('abort', function () {
          var err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    var handler = freshHandler();
    var started = Date.now();
    var res = await handler.handler({
      httpMethod: 'POST',
      body: JSON.stringify({ email: 'a@example.com', problem: 'x', source_url: 'https://berlinmanagementgroup.ai/contact/' })
    });
    var elapsedMs = Date.now() - started;
    assert.equal(res.statusCode, 200, 'the inquiry itself must still succeed');
    assert.equal(callCount, 2, 'Formspree once, OpenAI attempted once');
    // submit-inquiry.js passes timeoutMs: 5000 for this call; allow generous slack for test
    // overhead but this must not have hung indefinitely.
    assert.ok(elapsedMs < 7000, 'must resolve well within the 5s bound plus slack, got ' + elapsedMs + 'ms');
  } finally {
    global.fetch = original;
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('a hanging Formspree call is aborted within its own bounded timeout, not left to hang indefinitely', async function () {
  var original = global.fetch;
  try {
    global.fetch = async function (url, opts) {
      return new Promise(function (resolve, reject) {
        opts.signal.addEventListener('abort', function () {
          var err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    var handler = freshHandler();
    var started = Date.now();
    var res = await handler.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ email: 'a@example.com', problem: 'x' })
    });
    var elapsedMs = Date.now() - started;
    // submit-inquiry.js passes FORMSPREE_TIMEOUT_MS (6000) for this call.
    assert.ok(elapsedMs < 8000, 'must abort within the 6s bound plus slack, got ' + elapsedMs + 'ms');
    assert.equal(res.statusCode, 502, 'must report failure, never hang or silently succeed');
    var body = JSON.parse(res.body);
    assert.ok(body.error, 'must give the visitor something to act on so the UI can offer a retry');
  } finally {
    global.fetch = original;
  }
});

test('no-JS fallback (application/x-www-form-urlencoded body): success redirects to /thank-you/', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch([{ status: 200, body: '{}' }], async function (calls) {
    var handler = freshHandler();
    var res = await handler.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40example.com&problem=x&name=Jane'
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, '/thank-you/');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.indexOf('formspree.io') !== -1);
  });
});

test('no-JS fallback: missing required field redirects back to /contact/ instead of showing raw JSON on a blank page', async function () {
  var handler = freshHandler();
  var res = await handler.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Jane' // no email, no problem
  });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.Location, '/contact/');
});

test('no-JS fallback: a Formspree-side error also redirects back to /contact/, not a raw JSON body', async function () {
  await withMockedFetch([{ status: 422, body: JSON.stringify({ errors: [{ message: 'bad' }] }) }], async function () {
    var handler = freshHandler();
    var res = await handler.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40example.com&problem=x'
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.Location, '/contact/');
  });
});

test('the JSON path (normal JS-enabled submit) is unaffected by the form-encoded support added for the no-JS fallback', async function () {
  delete process.env.CONTEXT;
  await withMockedFetch([{ status: 200, body: '{"ok":true}' }], async function (calls) {
    var handler = freshHandler();
    var res = await handler.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', problem: 'x' })
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(calls.length, 1);
  });
});

test('rejects non-POST methods', async function () {
  var handler = freshHandler();
  var res = await handler.handler({ httpMethod: 'GET', body: '' });
  assert.equal(res.statusCode, 405);
});
