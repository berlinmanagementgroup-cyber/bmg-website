/* Unit tests for calendly-webhook.js's signature/replay verification. No network, no
 * Netlify, no real Calendly credentials - signingKey below is a synthetic test value
 * generated for this test file only and used nowhere else. Run with:
 *   node --test netlify/functions/__tests__/calendly-webhook.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('crypto');
var calendlyWebhook = require('../calendly-webhook.js');

var verifySignature = calendlyWebhook.verifySignature;
var isTimestampFresh = calendlyWebhook.isTimestampFresh;

var SYNTHETIC_SIGNING_KEY = 'test-only-synthetic-signing-key-never-used-for-real-traffic';
var TOLERANCE = 180;

function sign(timestampSeconds, body, key) {
  var hmac = crypto
    .createHmac('sha256', key || SYNTHETIC_SIGNING_KEY)
    .update(timestampSeconds + '.' + body)
    .digest('hex');
  return 't=' + timestampSeconds + ',v1=' + hmac;
}

test('valid signature with a fresh timestamp is accepted', function () {
  var body = JSON.stringify({ event: 'invitee.created', payload: { uri: 'x' } });
  var nowSeconds = Math.floor(Date.now() / 1000);
  var header = sign(nowSeconds, body);
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, true);
});

test('invalid signature (wrong key) is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var nowSeconds = Math.floor(Date.now() / 1000);
  var header = sign(nowSeconds, body, 'a-completely-different-key');
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('altered body after signing is rejected', function () {
  var originalBody = JSON.stringify({ event: 'invitee.created', payload: { uri: 'x' } });
  var nowSeconds = Math.floor(Date.now() / 1000);
  var header = sign(nowSeconds, originalBody);
  var tamperedBody = JSON.stringify({ event: 'invitee.created', payload: { uri: 'y' } });
  var result = verifySignature(header, tamperedBody, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('a correctly signed but stale timestamp (older than tolerance) is rejected - replay protection', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var staleSeconds = Math.floor(Date.now() / 1000) - (TOLERANCE + 60); // well past tolerance
  var header = sign(staleSeconds, body);
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'stale_or_invalid_timestamp');
});

test('a correctly signed but excessively future timestamp is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var futureSeconds = Math.floor(Date.now() / 1000) + (TOLERANCE + 60);
  var header = sign(futureSeconds, body);
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'stale_or_invalid_timestamp');
});

test('a timestamp just inside the tolerance window is accepted', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var borderlineSeconds = Math.floor(Date.now() / 1000) - (TOLERANCE - 5);
  var header = sign(borderlineSeconds, body);
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, true);
});

test('malformed (non-numeric) timestamp is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var header = 't=not-a-number,v1=' + crypto
    .createHmac('sha256', SYNTHETIC_SIGNING_KEY)
    .update('not-a-number.' + body)
    .digest('hex');
  var result = verifySignature(header, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'stale_or_invalid_timestamp');
});

test('non-finite timestamp (Infinity/NaN-shaped input) is rejected', function () {
  assert.equal(isTimestampFresh('Infinity', TOLERANCE), false);
  assert.equal(isTimestampFresh('NaN', TOLERANCE), false);
  assert.equal(isTimestampFresh('', TOLERANCE), false);
  assert.equal(isTimestampFresh(undefined, TOLERANCE), false);
});

test('missing signature header is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var result = verifySignature(null, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_or_malformed_header');
});

test('signature header missing the v1 part is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created' });
  var nowSeconds = Math.floor(Date.now() / 1000);
  var result = verifySignature('t=' + nowSeconds, body, SYNTHETIC_SIGNING_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing_or_malformed_header');
});

test('replay: a captured valid header replayed after the tolerance window has passed is rejected', function () {
  var body = JSON.stringify({ event: 'invitee.created', payload: { uri: 'replay-test' } });
  var originalSeconds = Math.floor(Date.now() / 1000) - 10; // was valid 10s ago
  var header = sign(originalSeconds, body);
  // Still within tolerance right now:
  assert.equal(verifySignature(header, body, SYNTHETIC_SIGNING_KEY).valid, true);
  // Simulate the same captured header/body being replayed long after the fact by checking
  // freshness against a later "now" directly (isTimestampFresh takes nowMs explicitly).
  var muchLaterMs = (originalSeconds + TOLERANCE + 3600) * 1000;
  assert.equal(isTimestampFresh(originalSeconds, TOLERANCE, muchLaterMs), false);
});
