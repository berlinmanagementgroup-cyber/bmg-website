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
// OpenAI's docs describe oppref as an opaque identifier the API "does not capture... for
// you" and that advertisers should "pass it unmodified" - there is no documented length cap
// for oppref itself (the 128-char/lowercase/trim normalization is for the separate `user`
// PII-matching object, which this helper never sends). MAX_OPPREF_LENGTH below is a sanity
// ceiling against abuse, not a normal truncation point - see validateOppref.
var MAX_OPPREF_LENGTH = 2048;
var MAX_FIELD_LENGTH = 128; // Used only for fields OpenAI itself documents as normalized.
// A hard abuse ceiling for the *whole* source_url, not a normal truncation point: generous
// enough that it never clips a legitimate URL even with a maximally-sized oppref embedded in
// its own query string (MAX_OPPREF_LENGTH) plus the other attribution params. A URL beyond
// this is rejected outright (sanitizeSourceUrl returns null) rather than truncated, so it
// can never turn into a different, shorter, syntactically-valid URL by accident.
var MAX_URL_LENGTH = 8192;

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

/* oppref is an opaque click-reference token: a truncated copy of it matches nothing on
 * OpenAI's side, which silently throws away attribution rather than reporting a visible
 * error - worse than sending no oppref at all. So this never clips it: a present oppref is
 * either passed through byte-for-byte or dropped entirely, with the reason given back to the
 * caller to log. Dropping only the identifier (not the whole event) matches OpenAI's own
 * schema, where oppref is optional - the conversion itself is still worth reporting without
 * it, just with weaker attribution. */
function validateOppref(oppref) {
  if (oppref === undefined || oppref === null || oppref === '') {
    return { present: false };
  }
  if (typeof oppref !== 'string') {
    return { present: true, ok: false, reason: 'oppref_not_a_string' };
  }
  if (oppref.length > MAX_OPPREF_LENGTH) {
    return { present: true, ok: false, reason: 'oppref_exceeds_sanity_ceiling' };
  }
  return { present: true, ok: true, value: oppref };
}

/* Rebuilds a URL keeping only its origin, path, and the known attribution params - strips
 * any other query parameter, fragment, or credentials before the value ever reaches a log
 * line or a third party. Returns null if the input isn't a parseable absolute URL.
 * Note: a value plugged into one of these query slots (e.g. campaign_id) goes through the
 * generic 128-char clamp below, same as before - only oppref gets the stricter
 * preserve-exactly-or-drop treatment, since oppref is the one field OpenAI's own docs single
 * out as an opaque identifier to pass unmodified. */
function sanitizeSourceUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    // Rejected outright, not truncated: cutting the raw string before parsing could turn it
    // into a different, shorter, still-syntactically-valid URL with a corrupted parameter.
    return null;
  }
  var parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  var clean = new URL(parsed.origin + parsed.pathname);
  KNOWN_URL_PARAMS.forEach(function (key) {
    var v = parsed.searchParams.get(key);
    if (!v) {
      return;
    }
    if (key === 'oppref') {
      var validated = validateOppref(v);
      if (validated.present && validated.ok) {
        clean.searchParams.set('oppref', validated.value);
      }
      // An invalid oppref embedded in source_url's query string is simply omitted from the
      // rebuilt URL; buildConversionPayload separately validates the oppref actually sent as
      // the event's own oppref field below.
      return;
    }
    clean.searchParams.set(key, clampString(v, MAX_FIELD_LENGTH));
  });
  return clean.toString();
}

/* Builds the OpenAI event object. Returns { ok: true, event, droppedOppref? } or
 * { ok: false, error }. Pure function - no network, no env vars - so it's unit-testable on
 * its own. */
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

  var result = { ok: true, event: event };

  var opprefCheck = validateOppref(oppref);
  if (opprefCheck.present) {
    if (opprefCheck.ok) {
      event.oppref = opprefCheck.value; // exact, unmodified
    } else {
      result.droppedOppref = opprefCheck.reason; // present but invalid - dropped, not truncated
    }
  }

  return result;
}

function isProductionContext() {
  // Netlify sets this automatically: "production" | "deploy-preview" | "branch-deploy" | "dev".
  // Checked here, independent of whether OPENAI_PIXEL_ID/OPENAI_CONVERSIONS_API_KEY happen to
  // be scoped correctly in the Netlify dashboard, so a deploy preview can never forward a real
  // conversion even if the secrets are (mis)configured as available to all contexts. This
  // guard reduces the blast radius of a scoping mistake; it is not a substitute for scoping
  // the secrets to Production in the Netlify dashboard, which is still required.
  return process.env.CONTEXT === 'production';
}

/* Sends one event to OpenAI's Conversions API. Accepts `attempts` (default 2) and
 * `timeoutMs` (default 8000, per attempt) so a caller on a tight user-facing latency budget
 * (submit-inquiry.js, chained behind the browser's own 15s AbortController) can pass
 * `attempts: 1, timeoutMs: 5000` to bound the worst case it adds, while a caller with no such
 * constraint (calendly-webhook.js) can use the more patient default. Never marks a failed
 * attempt as final - on failure it logs everything needed to replay the exact same event
 * (same id) by hand later, so a delivery problem degrades to "needs a manual resend," not
 * "silently lost," and never causes the caller to retry the whole inquiry (which would risk
 * a duplicate Formspree submission) just because this leg was slow. */
async function sendConversion(opts) {
  opts = opts || {};
  var pixelId = opts.pixelId;
  var apiKey = opts.apiKey;
  var event = opts.event;
  var logPrefix = opts.logPrefix || '[openai-capi]';
  var attempts = opts.attempts || 2;
  var timeoutMs = opts.timeoutMs || 8000;

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
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs);
    try {
      var resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: body,
        signal: controller.signal
      });
      var text = await resp.text();
      return { status: resp.status, ok: resp.ok, text: text };
    } finally {
      clearTimeout(timer);
    }
  }

  var lastError = null;
  for (var i = 0; i < attempts; i++) {
    try {
      var result = await attempt();
      if (result.ok) {
        console.log(logPrefix, 'OpenAI CAPI accepted event', event.id, 'status', result.status);
        return { sent: true, status: result.status };
      }
      lastError = 'http_' + result.status + ': ' + result.text;
    } catch (err) {
      lastError = (err && err.name === 'AbortError')
        ? 'timed_out_after_' + timeoutMs + 'ms'
        : ((err && err.message) || 'request_failed');
    }
  }

  // All attempts failed. Log the full retryable event (no PII in it) so it can be resent by
  // hand with the exact same id later - this is a delivery miss, not a dropped event.
  console.log(
    logPrefix,
    'OpenAI CAPI delivery failed after', attempts, 'attempt(s); NEEDS MANUAL RESEND with the same event id:',
    JSON.stringify(event),
    'last error:', lastError
  );
  return { sent: false, reason: 'delivery_failed', retryEvent: event };
}

module.exports = {
  ALLOWED_TYPES: ALLOWED_TYPES,
  clampString: clampString,
  validateOppref: validateOppref,
  sanitizeSourceUrl: sanitizeSourceUrl,
  buildConversionPayload: buildConversionPayload,
  isProductionContext: isProductionContext,
  sendConversion: sendConversion
};
