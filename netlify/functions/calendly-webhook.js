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
 *      report-conversion.js needs).
 *
 * Reference: https://developer.calendly.com/api-docs/db8674e86351c-webhook-subscriptions
 *            https://developers.openai.com/ads/conversions-api
 */

var crypto = require('crypto');

function verifySignature(signatureHeader, rawBody, signingKey) {
  if (!signatureHeader) {
    return false;
  }
  var parts = {};
  signatureHeader.split(',').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq > -1) {
      parts[part.slice(0, eq)] = part.slice(eq + 1);
    }
  });
  if (!parts.t || !parts.v1) {
    return false;
  }
  var expected = crypto
    .createHmac('sha256', signingKey)
    .update(parts.t + '.' + rawBody)
    .digest('hex');
  // Constant-time compare.
  var a = Buffer.from(expected);
  var b = Buffer.from(parts.v1);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
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

  if (!verifySignature(signatureHeader, rawBody, signingKey)) {
    console.log('[calendly-webhook] Missing or invalid signature; rejecting.');
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

  var pixelId = process.env.OPENAI_PIXEL_ID;
  var apiKey = process.env.OPENAI_CONVERSIONS_API_KEY;

  if (!pixelId || !apiKey) {
    console.log('[calendly-webhook] Booking verified but OpenAI credentials not configured; not forwarded.');
    return { statusCode: 200, body: JSON.stringify({ forwarded: false, reason: 'not_configured' }) };
  }

  var eventId = 'calendly_' + (invitee.uri ? invitee.uri.split('/').pop() : crypto.randomUUID());

  var oaiEvent = {
    id: eventId,
    type: 'appointment_scheduled',
    timestamp_ms: Date.now(),
    action_source: 'web',
    data: { type: 'customer_action' }
  };
  if (tracking.salesforce_uuid) {
    oaiEvent.oppref = tracking.salesforce_uuid;
  }

  try {
    var resp = await fetch(
      'https://bzr.openai.com/v1/events?pid=' + encodeURIComponent(pixelId),
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ validate_only: false, events: [oaiEvent] })
      }
    );
    var text = await resp.text();
    console.log('[calendly-webhook] OpenAI CAPI response', resp.status, text);
    return { statusCode: 200, body: JSON.stringify({ forwarded: true, openai_status: resp.status }) };
  } catch (err) {
    console.log('[calendly-webhook] OpenAI CAPI request failed:', err && err.message);
    return { statusCode: 502, body: JSON.stringify({ forwarded: false }) };
  }
};
