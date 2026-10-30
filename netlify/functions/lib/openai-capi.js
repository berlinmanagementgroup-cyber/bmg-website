/* netlify/functions/lib/openai-capi.js
 *
 * Shared helper for forwarding a verified conversion to OpenAI's Ads Conversions API.
 * Used only by server-verified callers: submit-inquiry.js (after Formspree itself confirms
 * acceptance) and calendly-webhook.js (after a signed, fresh Calendly webhook). Neither
 * caller trusts anything the browser merely asserts.
 *
 * Reference: https://developers.openai.com/ads/conversions-api
 */

var ALLOWED_TYPES = ['lead_created', 'appointment_scheduled'];
var MAX_FIELD_LENGTH = 128; // OpenAI's own docs: normalized values are capped at 128 chars.
var MAX_URL_LENGTH = 512;

/* Known attribution query parameters this site's bmg-attribution.js ever sets. Used to
 * rebuild source_url from only these - never pass through an arbitrary query string, so a
 * stray parameter someone appended (accidentally or not) can't carry personal data to
 * OpenAI. */
var KNOWN_URL_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'campaign_id', 'ad_id', 'oppref'
];

function clampString(value, maxLen) {
  if (typeof value !== 'string') {
    return '';
  }
  var trimmed = value.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/* Rebuilds a URL keeping only its origin, path, and the known attribution params - strips
 * any other query parameter, fragment, or credentials before the value ever reaches a log
 * line or a third party. Returns null if the input isn't a parseable absolute URL. */
function sanitizeSourceUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }
  var parsed;
  try {
    parsed = new URL(clampString(rawUrl, MAX_URL_LENGTH));
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  var clean = new URL(parsed.origin + parsed.pathname);
  KNOWN_URL_PARAMS.forEach(function (key) {
    var v = parsed.searchParams.get(key);
    if (v) {
      clean.searchParams.set(key, clampString(v, MAX_FIELD_LENGTH));
    }
  });
  return clean.toString();
}

/* Builds the OpenAI event object. Returns { ok: true, event } or { ok: false, error }.
 * Pure function - no network, no env vars - so it's unit-testable on its own. */
function buildConversionPayload(opts) {
  opts = opts || {};
  var type = opts.type;
  var eventId = opts.eventId;
  var oppref = opts.oppref;
  var sourceUrl = opts.sourceUrl;

  if (!type || ALLOWED_TYPES.indexOf(type) === -1) {
    return { ok: false, error: 'unsupported_type' };
  }
  if (!eventId || typeof eventId !== 'string') {
    return { ok: false, error: 'missing_event_id' };
  }

  // source_url is required by OpenAI whenever action_source is "web" (this helper always
  // sends action_source: "web"), so an event without one is rejected here rather than sent
  // to OpenAI and failing there.
  var cleanSourceUrl = sanitizeSourceUrl(sourceUrl);
  if (!cleanSourceUrl) {
    return { ok: false, error: 'missing_or_invalid_source_url' };
  }

  var event = {
    id: clampString(eventId, MAX_FIELD_LENGTH),
    type: type,
    timestamp_ms: Date.now(),
    action_source: 'web',
    source_url: cleanSourceUrl,
    data: { type: 'customer_action' }
  };

  var cleanOppref = clampString(oppref, MAX_FIELD_LENGTH);
  if (cleanOppref) {
    event.oppref = cleanOppref;
  }

  return { ok: true, event: event };
}

function isProductionContext() {
  // Netlify sets this automatically: "production" | "deploy-preview" | "branch-deploy" | "dev".
  // Checked here, independent of whether OPENAI_PIXEL_ID/OPENAI_CONVERSIONS_API_KEY happen to
  // be scoped correctly in the Netlify dashboard, so a deploy preview can never forward a real
  // conversion even if the secrets are (mis)configured as available to all contexts.
  return process.env.CONTEXT === 'production';
}

/* Sends one event to OpenAI's Conversions API, with one immediate in-process retry on
 * network failure or a non-2xx response. Never marks a failed attempt as final - on failure
 * it logs everything needed to replay the exact same event (same id) by hand later, so a
 * delivery problem degrades to "needs a manual resend," not "silently lost." */
async function sendConversion(opts) {
  opts = opts || {};
  var pixelId = opts.pixelId;
  var apiKey = opts.apiKey;
  var event = opts.event;
  var logPrefix = opts.logPrefix || '[openai-capi]';

  if (!isProductionContext()) {
    console.log(logPrefix, 'Skipped: not running in the production context (CONTEXT=' +
      process.env.CONTEXT + '). Event not sent:', event && event.id);
    return { sent: false, reason: 'not_production_context' };
  }

  if (!pixelId || !apiKey) {
    console.log(logPrefix, 'Skipped: OPENAI_PIXEL_ID / OPENAI_CONVERSIONS_API_KEY not set. ' +
      'Event not sent:', event && event.id);
    return { sent: false, reason: 'not_configured' };
  }

  var url = 'https://bzr.openai.com/v1/events?pid=' + encodeURIComponent(pixelId);
  var body = JSON.stringify({ validate_only: false, events: [event] });

  async function attempt() {
    var resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: body
    });
    var text = await resp.text();
    return { status: resp.status, ok: resp.ok, text: text };
  }

  var lastError = null;
  for (var i = 0; i < 2; i++) {
    try {
      var result = await attempt();
      if (result.ok) {
        console.log(logPrefix, 'OpenAI CAPI accepted event', event.id, 'status', result.status);
        return { sent: true, status: result.status };
      }
      lastError = 'http_' + result.status + ': ' + result.text;
    } catch (err) {
      lastError = (err && err.message) || 'request_failed';
    }
  }

  // Both attempts failed. Log the full retryable event (no PII in it) so it can be resent
  // by hand with the exact same id later - this is a delivery miss, not a dropped event.
  console.log(
    logPrefix,
    'OpenAI CAPI delivery failed after retry; NEEDS MANUAL RESEND with the same event id:',
    JSON.stringify(event),
    'last error:', lastError
  );
  return { sent: false, reason: 'delivery_failed', retryEvent: event };
}

module.exports = {
  ALLOWED_TYPES: ALLOWED_TYPES,
  clampString: clampString,
  sanitizeSourceUrl: sanitizeSourceUrl,
  buildConversionPayload: buildConversionPayload,
  isProductionContext: isProductionContext,
  sendConversion: sendConversion
};
