/* netlify/functions/calendly-webhook.js
 *
 * Receives Calendly's "invitee.created" webhook - a real, verified completed booking, as
 * opposed to a mere click on the booking link - and relays it to OpenAI's Ads Conversions
 * API as an "appointment_scheduled" conversion, carrying forward the ad attribution that
 * assets/bmg-attribution.js attached to the Calendly link as utm_content (campaign_id),
 * utm_term (ad_id), and salesforce_uuid (OpenAI's oppref click reference).
 *
 * NOT YET ACTIVE. Three things must happen before this does anything:
 *
 *   1. Confirm Brad's Calendly plan includes the Webhook Subscriptions API. As of this
 *      writing that has required a paid Calendly plan (Standard/Teams or above) - verify
 *      against Calendly's current plan comparison, since this can change.
 *   2. Create a Calendly webhook subscription for the invitee.created event, pointed at
 *      this function's deployed URL, and set its signing secret as the Netlify environment
 *      variable CALENDLY_WEBHOOK_SIGNING_KEY. Until that variable is set, this function
 *      refuses every request rather than trusting an unauthenticated caller.
 *   3. Set OPENAI_PIXEL_ID and OPENAI_CONVERSIONS_API_KEY (same two variables
 *      submit-inquiry.js needs), scoped to the Production context only.
 *
 * Reference: https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures
 *            https://developers.openai.com/ads/conversions-api
 */

var crypto = require('crypto');
var capi = require('./lib/openai-capi');

var REPLAY_TOLERANCE_SECONDS = 180; // Matches Calendly's own documented example tolerance.

/* Parses "t=<unix>,v1=<hex>" into { t, v1 }. Returns null if either part is missing. */
function parseSignatureHeader(signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return null;
  }
  var parts = {};
  signatureHeader.split(',').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq > -1) {
      parts[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  });
  if (!parts.t || !parts.v1) {
    return null;
  }
  return parts;
}

/* True only if `t` is a finite Unix-seconds timestamp within toleranceSeconds of `nowMs`
 * (exported separately from verifySignature so both directions - stale and excessively
 * future, and malformed/non-finite - can be unit-tested without an HMAC key at all). */
function isTimestampFresh(t, toleranceSeconds, nowMs) {
  var n = Number(t);
  if (!Number.isFinite(n)) {
    return false;
  }
  var nowSeconds = (typeof nowMs === 'number' ? nowMs : Date.now()) / 1000;
  return Math.abs(nowSeconds - n) <= toleranceSeconds;
}

/* Verifies a Calendly webhook signature: HMAC-SHA256 over "{t}.{rawBody}" with the
 * subscription's signing key, timing-safe compared against v1, with the timestamp checked
 * against replay (too old or implausibly future) per Calendly's documented recommendation.
 * Pure aside from Date.now() (overridable via nowMs) - no network, no Netlify - so every
 * branch is unit-testable with a synthetic key. */
function verifySignature(signatureHeader, rawBody, signingKey, opts) {
  opts = opts || {};
  var toleranceSeconds = opts.toleranceSeconds || REPLAY_TOLERANCE_SECONDS;

  var parts = parseSignatureHeader(signatureHeader);
  if (!parts) {
    return { valid: false, reason: 'missing_or_malformed_header' };
  }
  if (!isTimestampFresh(parts.t, toleranceSeconds, opts.nowMs)) {
    return { valid: false, reason: 'stale_or_invalid_timestamp' };
  }

  var expected = crypto
    .createHmac('sha256', signingKey)
    .update(parts.t + '.' + rawBody)
    .digest('hex');

  var a = Buffer.from(expected, 'hex');
  var b = Buffer.from(parts.v1, 'hex');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var signingKey = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) {
    console.log('[calendly-webhook] CALENDLY_WEBHOOK_SIGNING_KEY not set; refusing request.');
    return { statusCode: 501, body: 'Webhook not configured' };
  }

  var signatureHeader =
    event.headers['calendly-webhook-signature'] || event.headers['Calendly-Webhook-Signature'];
  var rawBody = event.body || '';

  var verification = verifySignature(signatureHeader, rawBody, signingKey);
  if (!verification.valid) {
    console.log('[calendly-webhook] Rejected:', verification.reason);
    return { statusCode: 401, body: 'Invalid signature' };
  }

  var payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (payload.event !== 'invitee.created') {
    return { statusCode: 200, body: 'Ignored (not invitee.created)' };
  }

  var invitee = payload.payload || {};
  var tracking = invitee.tracking || {};
  var eventId = 'calendly_' + (invitee.uri ? invitee.uri.split('/').pop() : crypto.randomUUID());

  var built = capi.buildConversionPayload({
    type: 'appointment_scheduled',
    eventId: eventId,
    oppref: tracking.salesforce_uuid,
    // The real "web" location of this action is the booking page itself, not a Calendly
    // API URI (invitee.uri/scheduled_event.uri are API resource references, not web pages).
    sourceUrl: 'https://calendly.com/brad-berlinmanagementgroup/30min-discovery'
  });

  if (!built.ok) {
    console.log('[calendly-webhook] Not forwarding to OpenAI - ' + built.error, 'event id', eventId);
    return { statusCode: 200, body: JSON.stringify({ forwarded: false, reason: built.error }) };
  }

  var result = await capi.sendConversion({
    pixelId: process.env.OPENAI_PIXEL_ID,
    apiKey: process.env.OPENAI_CONVERSIONS_API_KEY,
    event: built.event,
    logPrefix: '[calendly-webhook]'
  });

  return { statusCode: 200, body: JSON.stringify(result) };
};

module.exports.verifySignature = verifySignature;
module.exports.isTimestampFresh = isTimestampFresh;
module.exports.parseSignatureHeader = parseSignatureHeader;
