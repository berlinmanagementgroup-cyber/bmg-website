/* netlify/functions/submit-inquiry.js
 *
 * Replaces a direct browser-to-Formspree submission. The browser posts the contact form's
 * fields (plus the ad attribution bmg-attribution.js injected as hidden fields, plus the
 * current page URL) here; this function forwards them to Formspree server-side and only
 * reports a lead_created conversion to OpenAI's Ads Conversions API once Formspree itself
 * has confirmed the submission was accepted.
 *
 * This exists specifically to close a hole the browser-only design had: nothing used to
 * verify a real submission occurred before reporting a conversion, so anyone who found the
 * old public endpoint could POST a fabricated lead_created directly. Here, the only way to
 * cause an OpenAI event is to make Formspree actually accept a submission (which lands in
 * Brad's real inbox) - the same floor every public contact form has, and no lower.
 *
 * Accepts two request shapes:
 *   - application/json (the normal path: contact/index.html's JS-enhanced submit handler)
 *   - application/x-www-form-urlencoded (the browser's own native form POST, used only if
 *     JS/fetch/AbortController are unavailable - see the fallback check in contact/index.html.
 *     Without this, that no-JS path would silently break: this function only used to
 *     understand JSON, so a plain form POST here would 400 on a blank page instead of
 *     reaching Formspree at all).
 *
 * Formspree's JSON endpoint accepts a plain POST with Accept/Content-Type: application/json
 * from any origin, including non-browser callers (documented as working "cross-origin"; see
 * https://help.formspree.io/hc/en-us/articles/360013470814). No separate Formspree
 * authentication is required for this - the form id (f/xgonjavo) is the only identifier.
 *
 * The event id used for OpenAI de-duplication is generated here, once, only after Formspree
 * confirms success - not supplied by the browser - so its validity window exactly matches
 * the one real, confirmed event it describes.
 *
 * Latency budget: contact/index.html's JS path aborts the whole request at 15s. Both network
 * legs here (Formspree, then OpenAI) carry their own bounded timeout so neither can run that
 * budget out on its own - and so neither can let the browser time out and show the visitor a
 * false failure *after* Formspree has already accepted a real submission, which would invite
 * a genuine duplicate on retry. Formspree 6s + OpenAI 3s leaves real margin under both the
 * browser's 15s ceiling and Netlify's own function execution limit (commonly ~10s on
 * standard plans) - confirm the latter against Brad's actual Netlify plan before relying on
 * it for a traffic spike; this code can't see that limit from here.
 */

var crypto = require('crypto');
var capi = require('./lib/openai-capi');

var FORMSPREE_URL = 'https://formspree.io/f/xgonjavo';
var SITE_HOSTNAME = 'berlinmanagementgroup.ai';
var DEFAULT_REFERER = 'https://' + SITE_HOSTNAME + '/contact/';
var FORMSPREE_TIMEOUT_MS = 6000;
var OPENAI_TIMEOUT_MS = 3000;

/* Formspree's "Restrict to Domain" setting (if Brad has it enabled on this form) checks the
 * Referer header on every submission and routes anything that doesn't match to the spam
 * folder instead of the inbox - silently, with no error back to the caller. A direct
 * browser-to-Formspree submission always carried a real Referer; this server-side relay
 * does not unless it sets one explicitly. Using the visitor's own real page (when it's
 * genuinely this site) keeps that behaviour equivalent instead of silently routing every
 * submission as unexpected-origin.
 *
 * Known residual gap (flagged by review, not fully closable here): this only checks that the
 * claimed source_url's *hostname* is this site - anyone POSTing to this function directly
 * (bypassing the real form) can still supply any berlinmanagementgroup.ai URL and pass. That
 * narrows "Restrict to Domain" to filtering only genuinely different domains, same as it
 * would for any scripted caller hitting Formspree directly before this PR existed; it does
 * not, by itself, rate-limit or CAPTCHA-gate this endpoint, which this PR does not add. */
function refererFor(sourceUrl) {
  if (typeof sourceUrl === 'string') {
    try {
      var parsed = new URL(sourceUrl);
      if (parsed.hostname === SITE_HOSTNAME) {
        return sourceUrl;
      }
    } catch (e) {
      // fall through to default
    }
  }
  return DEFAULT_REFERER;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// Fields the real contact form sends; anything else in the request body is dropped rather
// than blindly forwarded, so this can't become an open relay for arbitrary POST bodies to
// Formspree. Attribution fields are listed separately since they are not user-entered.
var FORM_FIELDS = ['name', 'email', 'company', 'problem', 'hurting_most', 'heard_from', 'phone'];
var ATTRIBUTION_FIELDS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'campaign_id', 'ad_id', 'oppref'
];

function redirectOrJson(isFormEncoded, redirectPath, statusCode, jsonBody) {
  if (isFormEncoded) {
    return { statusCode: 302, headers: { Location: redirectPath }, body: '' };
  }
  return { statusCode: statusCode, body: jsonBody };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var headers = event.headers || {};
  var contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  var isFormEncoded = contentType.indexOf('application/x-www-form-urlencoded') !== -1;

  var payload = {};
  if (isFormEncoded) {
    try {
      new URLSearchParams(event.body || '').forEach(function (value, key) {
        payload[key] = value;
      });
    } catch (e) {
      return { statusCode: 400, body: 'Invalid form body' };
    }
  } else {
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
  }

  // Minimal shape check mirroring the HTML form's own `required` fields. Formspree's own
  // spam/content handling applies after this; this is not meant to replace it.
  if (!payload.email || !payload.problem) {
    return redirectOrJson(
      isFormEncoded, '/contact/', 400, JSON.stringify({ error: 'Missing required field' })
    );
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

  var sourceUrl = typeof payload.source_url === 'string' ? payload.source_url : null;

  var formspreeResp;
  try {
    formspreeResp = await fetchWithTimeout(
      FORMSPREE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Referer: refererFor(sourceUrl)
        },
        body: JSON.stringify(forwardBody)
      },
      FORMSPREE_TIMEOUT_MS
    );
  } catch (err) {
    var reason = err && err.name === 'AbortError' ? 'timed_out' : (err && err.message);
    console.log('[submit-inquiry] Formspree request failed:', reason);
    return redirectOrJson(
      isFormEncoded, '/contact/', 502, JSON.stringify({ error: 'Could not reach Formspree' })
    );
  }

  var formspreeText = await formspreeResp.text();

  if (!formspreeResp.ok) {
    // Pass Formspree's own error through so the existing client-side error message still
    // makes sense (e.g. validation errors Formspree itself rejects).
    return redirectOrJson(isFormEncoded, '/contact/', formspreeResp.status, formspreeText);
  }

  // Formspree has now genuinely accepted this submission. Only now does a conversion exist
  // to report, and only now is an event id minted for it.
  var eventId = 'inquiry_' + crypto.randomUUID();
  var built = capi.buildConversionPayload({
    type: 'lead_created',
    eventId: eventId,
    oppref: oppref,
    sourceUrl: sourceUrl
  });

  if (built.ok) {
    if (built.droppedOppref) {
      console.log('[submit-inquiry] oppref present but invalid (' + built.droppedOppref +
        '); dropped, not truncated. Event still sent without it:', eventId);
    }
    try {
      await capi.sendConversion({
        pixelId: process.env.OPENAI_PIXEL_ID,
        apiKey: process.env.OPENAI_CONVERSIONS_API_KEY,
        event: built.event,
        logPrefix: '[submit-inquiry]',
        attempts: 1,
        timeoutMs: OPENAI_TIMEOUT_MS
      });
    } catch (err) {
      // Never let an OpenAI-side problem fail the lead capture itself - Formspree already
      // has the real submission regardless of what happens here.
      console.log('[submit-inquiry] Unexpected error forwarding to OpenAI:', err && err.message);
    }
  } else {
    console.log('[submit-inquiry] Not forwarding to OpenAI - ' + built.error, 'event id', eventId);
  }

  return redirectOrJson(isFormEncoded, '/thank-you/', 200, formspreeText);
};
