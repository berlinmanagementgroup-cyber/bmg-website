/* netlify/functions/submit-inquiry.js
 *
 * Replaces a direct browser-to-Formspree submission. The browser posts the contact form's
 * fields (plus the ad attribution bmg-attribution.js injected as hidden fields, plus the
 * current page URL) here as JSON; this function forwards them to Formspree server-side and
 * only reports a lead_created conversion to OpenAI's Ads Conversions API once Formspree
 * itself has confirmed the submission was accepted.
 *
 * This exists specifically to close a hole the browser-only design had: nothing used to
 * verify a real submission occurred before reporting a conversion, so anyone who found the
 * old public endpoint could POST a fabricated lead_created directly. Here, the only way to
 * cause an OpenAI event is to make Formspree actually accept a submission (which lands in
 * Brad's real inbox) - the same floor every public contact form has, and no lower.
 *
 * Formspree's JSON endpoint accepts a plain POST with Accept/Content-Type: application/json
 * from any origin, including non-browser callers (documented as working "cross-origin"; see
 * https://help.formspree.io/hc/en-us/articles/360013470814). No separate Formspree
 * authentication is required for this - the form id (f/xgonjavo) is the only identifier.
 *
 * The event id used for OpenAI de-duplication is generated here, once, only after Formspree
 * confirms success - not supplied by the browser - so its validity window exactly matches
 * the one real, confirmed event it describes.
 */

var crypto = require('crypto');
var capi = require('./lib/openai-capi');

var FORMSPREE_URL = 'https://formspree.io/f/xgonjavo';

// Fields the real contact form sends; anything else in the request body is dropped rather
// than blindly forwarded, so this can't become an open relay for arbitrary POST bodies to
// Formspree. Attribution fields are listed separately since they are not user-entered.
var FORM_FIELDS = ['name', 'email', 'company', 'problem', 'hurting_most', 'heard_from', 'phone'];
var ATTRIBUTION_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'campaign_id', 'ad_id', 'oppref'
];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Minimal shape check mirroring the HTML form's own `required` fields. Formspree's own
  // spam/content handling applies after this; this is not meant to replace it.
  if (!payload.email || !payload.problem) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required field' }) };
  }

  var forwardBody = {};
  FORM_FIELDS.forEach(function (f) {
    if (typeof payload[f] === 'string') {
      forwardBody[f] = payload[f];
    }
  });
  var oppref;
  ATTRIBUTION_FIELDS.forEach(function (f) {
    if (typeof payload[f] === 'string' && payload[f]) {
      forwardBody[f] = payload[f];
      if (f === 'oppref') {
        oppref = payload[f];
      }
    }
  });

  var formspreeResp;
  try {
    formspreeResp = await fetch(FORMSPREE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(forwardBody)
    });
  } catch (err) {
    console.log('[submit-inquiry] Formspree request failed:', err && err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'Could not reach Formspree' }) };
  }

  var formspreeText = await formspreeResp.text();

  if (!formspreeResp.ok) {
    // Pass Formspree's own error through so the existing client-side error message still
    // makes sense (e.g. validation errors Formspree itself rejects).
    return { statusCode: formspreeResp.status, body: formspreeText };
  }

  // Formspree has now genuinely accepted this submission. Only now does a conversion exist
  // to report, and only now is an event id minted for it.
  var eventId = 'inquiry_' + crypto.randomUUID();
  var built = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: eventId,
    oppref: oppref,
    sourceUrl: typeof payload.source_url === 'string' ? payload.source_url : null
  });

  if (built.ok) {
    try {
      await capi.sendConversion({
        pixelId: process.env.OPENAI_PIXEL_ID,
        apiKey: process.env.OPENAI_CONVERSIONS_API_KEY,
        event: built.event,
        logPrefix: '[submit-inquiry]'
      });
    } catch (err) {
      // Never let an OpenAI-side problem fail the lead capture itself - Formspree already
      // has the real submission regardless of what happens here.
      console.log('[submit-inquiry] Unexpected error forwarding to OpenAI:', err && err.message);
    }
  } else {
    console.log('[submit-inquiry] Not forwarding to OpenAI - ' + built.error, 'event id', eventId);
  }

  return { statusCode: 200, body: formspreeText };
};
