/* Unit tests for the OpenAI-CAPI payload helper. No network, no credentials. Run with:
 *   node --test netlify/functions/__tests__/openai-capi.test.js
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var capi = require('../lib/openai-capi.js');

test('builds a valid lead_created event with a clean source_url and oppref', function () {
  var result = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: 'inquiry_abc123',
    oppref: 'TESTOPPREF789',
    sourceUrl: 'https://berlinmanagementgroup.ai/contact/?utm_source=chatgpt&campaign_id=C1&ad_id=A1'
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.id, 'inquiry_abc123');
  assert.equal(result.event.type, 'lead_created');
  assert.equal(result.event.action_source, 'web');
  assert.equal(result.event.data.type, 'customer_action');
  assert.equal(result.event.oppref, 'TESTOPPREF789');
  assert.equal(
    result.event.source_url,
    'https://berlinmanagementgroup.ai/contact/?utm_source=chatgpt&campaign_id=C1&ad_id=A1'
  );
});

test('rejects an unsupported event type', function () {
  var result = capi.buildConversionPayload({
    type: 'totally_made_up',
    eventId: 'x',
    sourceUrl: 'https://berlinmanagementgroup.ai/contact/'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported_type');
});

test('rejects a missing event id', function () {
  var result = capi.buildConversionPayload({
    type: 'lead_created',
    sourceUrl: 'https://berlinmanagementgroup.ai/contact/'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_event_id');
});

test('rejects a missing source_url (required when action_source is web)', function () {
  var result = capi.buildConversionPayload({ type: 'lead_created', eventId: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_or_invalid_source_url');
});

test('rejects an unparseable source_url', function () {
  var result = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: 'x',
    sourceUrl: 'not a url'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_or_invalid_source_url');
});

test('sanitizeSourceUrl strips arbitrary query parameters, keeping only known attribution params', function () {
  var dirty = 'https://berlinmanagementgroup.ai/contact/' +
    '?utm_source=chatgpt&email=someone%40example.com&name=Jane+Doe&campaign_id=C1&unexpected=xyz';
  var clean = capi.sanitizeSourceUrl(dirty);
  assert.ok(clean.indexOf('email=') === -1, 'must not carry through an email-shaped param');
  assert.ok(clean.indexOf('name=') === -1, 'must not carry through a name-shaped param');
  assert.ok(clean.indexOf('unexpected=') === -1, 'must not carry through an unlisted param');
  assert.ok(clean.indexOf('utm_source=chatgpt') !== -1, 'must keep known attribution params');
  assert.ok(clean.indexOf('campaign_id=C1') !== -1, 'must keep known attribution params');
});

test('sanitizeSourceUrl drops the fragment and any embedded credentials', function () {
  var dirty = 'https://user:pass@berlinmanagementgroup.ai/contact/?utm_source=chatgpt#secret-section';
  var clean = capi.sanitizeSourceUrl(dirty);
  assert.ok(clean.indexOf('#') === -1, 'must not carry a fragment');
  assert.ok(clean.indexOf('user:pass') === -1, 'must not carry embedded credentials');
});

test('sanitizeSourceUrl rejects non-http(s) schemes', function () {
  assert.equal(capi.sanitizeSourceUrl('javascript:alert(1)'), null);
  assert.equal(capi.sanitizeSourceUrl('file:///etc/passwd'), null);
});

test('clampString caps length and trims', function () {
  var long = 'x'.repeat(500);
  assert.equal(capi.clampString(long, 128).length, 128);
  assert.equal(capi.clampString('  padded  ', 128), 'padded');
});

test('a well-formed oppref is preserved byte-for-byte, including past the 128-char field limit used elsewhere', function () {
  // 150 chars: longer than the 128-char limit that applies to other normalized fields, to
  // prove specifically that oppref is exempt from that limit, not just under it by luck.
  var longButPlausibleOppref = 'gAAAAAb' + '1'.repeat(143);
  assert.equal(longButPlausibleOppref.length, 150);
  var result = capi.buildConversionPayload({
    type: 'appointment_scheduled',
    eventId: 'calendly_xyz',
    oppref: longButPlausibleOppref,
    sourceUrl: 'https://calendly.com/brad-berlinmanagementgroup/30min-discovery'
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.oppref, longButPlausibleOppref, 'must be byte-for-byte identical, not truncated');
  assert.equal(result.droppedOppref, undefined);
});

test('an oppref past the sanity ceiling is dropped, not truncated - the rest of the event still sends', function () {
  var absurdOppref = 'o'.repeat(5000);
  var result = capi.buildConversionPayload({
    type: 'appointment_scheduled',
    eventId: 'calendly_xyz',
    oppref: absurdOppref,
    sourceUrl: 'https://calendly.com/brad-berlinmanagementgroup/30min-discovery'
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.oppref, undefined, 'must not send a truncated fragment of it');
  assert.equal(result.droppedOppref, 'oppref_exceeds_sanity_ceiling');
});

test('a non-string oppref is dropped, not coerced or truncated', function () {
  var result = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: 'inquiry_xyz',
    oppref: 12345,
    sourceUrl: 'https://berlinmanagementgroup.ai/contact/'
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.oppref, undefined);
  assert.equal(result.droppedOppref, 'oppref_not_a_string');
});

test('an absent oppref is simply absent - not an error, no droppedOppref flag', function () {
  var result = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: 'inquiry_xyz',
    sourceUrl: 'https://berlinmanagementgroup.ai/contact/'
  });
  assert.equal(result.ok, true);
  assert.equal(result.event.oppref, undefined);
  assert.equal(result.droppedOppref, undefined);
});

test('validateOppref directly: present/ok/reason shape for each case', function () {
  assert.deepEqual(capi.validateOppref(undefined), { present: false });
  assert.deepEqual(capi.validateOppref(''), { present: false });
  assert.deepEqual(capi.validateOppref('abc'), { present: true, ok: true, value: 'abc' });
  assert.equal(capi.validateOppref(42).ok, false);
  assert.equal(capi.validateOppref('x'.repeat(3000)).ok, false);
});

test('an invalid oppref riding inside source_url\'s own query string is omitted from the rebuilt URL, not truncated into it', function () {
  var dirty = 'https://berlinmanagementgroup.ai/contact/?oppref=' + 'o'.repeat(5000);
  var clean = capi.sanitizeSourceUrl(dirty);
  assert.ok(clean.indexOf('oppref=') === -1);
});

test('isProductionContext reflects process.env.CONTEXT exactly', function () {
  var original = process.env.CONTEXT;
  try {
    process.env.CONTEXT = 'production';
    assert.equal(capi.isProductionContext(), true);
    process.env.CONTEXT = 'deploy-preview';
    assert.equal(capi.isProductionContext(), false);
    delete process.env.CONTEXT;
    assert.equal(capi.isProductionContext(), false);
  } finally {
    if (original === undefined) {
      delete process.env.CONTEXT;
    } else {
      process.env.CONTEXT = original;
    }
  }
});
