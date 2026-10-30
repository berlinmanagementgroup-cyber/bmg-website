/* Unit tests for calendly-webhook.js's full handler (not just verifySignature), with
 * global.fetch mocked. No real Calendly or OpenAI credentials - CALENDLY_WEBHOOK_SIGNING_KEY
 * below is a synthetic test value generated for this test file only.
 * Run with: node --test netlify/functions/__tests__/calendly-webhook-handler.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');

var SYNTHETIC_SIGNING_KEY = 'test-only-synthetic-signing-key-never-used-for-real-traffic';

function sign(timestampSeconds, body, key) {
  var hmac = crypto
    .createHmac('sha256', key || SYNTHETIC_SIGNING_KEY)
    .update(timestampSeconds + '.' + body)
    .digest('hex');
  return 't=' + timestampSeconds + ',v1=' + hmac;
}

function withMockedFetch(responses, fn) {
  var original = global.fetch;
  var calls = [];
  global.fetch = async function (url, opts) {
    calls.push({ url: url, opts: opts });
    var next = responses.shift();
    if (!next) {
      throw new Error('no more mocked responses configured');
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
  delete require.cache[require.resolve('../calendly-webhook.js')];
  delete require.cache[require.resolve('../lib/openai-capi.js')];
  return require('../calendly-webhook.js');
}

test('refuses every request when no signing key is configured', async function () {
  delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  var handler = freshHandler();
  var res = await handler.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 501);
});

test('rejects an unsigned request once a signing key exists', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  try {
    var handler = freshHandler();
    var res = await handler.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
    assert.equal(res.statusCode, 401);
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  }
});

test('rejects a correctly-formed but wrongly-signed request', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  try {
    var body = JSON.stringify({ event: 'invitee.created', payload: { uri: 'x' } });
    var header = sign(Math.floor(Date.now() / 1000), body, 'wrong-key');
    var handler = freshHandler();
    var res = await handler.handler({
      httpMethod: 'POST',
      headers: { 'calendly-webhook-signature': header },
      body: body
    });
    assert.equal(res.statusCode, 401);
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  }
});

test('ignores a validly-signed event that is not invitee.created, without calling OpenAI', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  try {
    var body = JSON.stringify({ event: 'invitee.canceled', payload: {} });
    var header = sign(Math.floor(Date.now() / 1000), body);
    await withMockedFetch([], async function (calls) {
      var handler = freshHandler();
      var res = await handler.handler({
        httpMethod: 'POST',
        headers: { 'calendly-webhook-signature': header },
        body: body
      });
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 0);
    });
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  }
});

test('a valid, fresh, signed invitee.created forwards appointment_scheduled to OpenAI in production, carrying oppref from tracking.salesforce_uuid', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  process.env.CONTEXT = 'production';
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  try {
    var body = JSON.stringify({
      event: 'invitee.created',
      payload: {
        uri: 'https://api.calendly.com/scheduled_events/AAA/invitees/BBB',
        tracking: { salesforce_uuid: 'TESTOPPREF789', utm_content: 'C1', utm_term: 'A1' }
      }
    });
    var header = sign(Math.floor(Date.now() / 1000), body);
    await withMockedFetch(
      [{ status: 200, body: JSON.stringify({ accepted: true }) }],
      async function (calls) {
        var handler = freshHandler();
        var res = await handler.handler({
          httpMethod: 'POST',
          headers: { 'calendly-webhook-signature': header },
          body: body
        });
        assert.equal(res.statusCode, 200);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].url.indexOf('bzr.openai.com') !== -1);
        var sentBody = JSON.parse(calls[0].opts.body);
        assert.equal(sentBody.events[0].type, 'appointment_scheduled');
        assert.equal(sentBody.events[0].oppref, 'TESTOPPREF789');
        assert.equal(sentBody.events[0].id, 'calendly_BBB');
      }
    );
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('a valid signed invitee.created outside production does not call OpenAI', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  process.env.CONTEXT = 'deploy-preview';
  process.env.OPENAI_PIXEL_ID = 'fake-pixel-for-test-only';
  process.env.OPENAI_CONVERSIONS_API_KEY = 'fake-key-for-test-only';
  try {
    var body = JSON.stringify({
      event: 'invitee.created',
      payload: { uri: 'https://api.calendly.com/scheduled_events/AAA/invitees/CCC', tracking: {} }
    });
    var header = sign(Math.floor(Date.now() / 1000), body);
    await withMockedFetch([], async function (calls) {
      var handler = freshHandler();
      var res = await handler.handler({
        httpMethod: 'POST',
        headers: { 'calendly-webhook-signature': header },
        body: body
      });
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 0, 'production-context guard must block the OpenAI call entirely');
    });
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    delete process.env.CONTEXT;
    delete process.env.OPENAI_PIXEL_ID;
    delete process.env.OPENAI_CONVERSIONS_API_KEY;
  }
});

test('a replayed (stale) but correctly signed invitee.created is rejected before ever reaching OpenAI logic', async function () {
  process.env.CALENDLY_WEBHOOK_SIGNING_KEY = SYNTHETIC_SIGNING_KEY;
  process.env.CONTEXT = 'production';
  try {
    var body = JSON.stringify({ event: 'invitee.created', payload: { uri: 'x' } });
    var staleSeconds = Math.floor(Date.now() / 1000) - 3600; // an hour old
    var header = sign(staleSeconds, body);
    await withMockedFetch([], async function (calls) {
      var handler = freshHandler();
      var res = await handler.handler({
        httpMethod: 'POST',
        headers: { 'calendly-webhook-signature': header },
        body: body
      });
      assert.equal(res.statusCode, 401);
      assert.equal(calls.length, 0);
    });
  } finally {
    delete process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
    delete process.env.CONTEXT;
  }
});
