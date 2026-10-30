/* netlify/functions/report-conversion.js
 *
 * Receives a conversion event from the browser (assets/bmg-conversion.js, fired from
 * /contact/'s successful-submission handler) and relays it server-side to OpenAI's Ads
 * Conversions API, so the Conversions API key never reaches the browser.
 *
 * Reference: https://developers.openai.com/ads/conversions-api
 *            https://developers.openai.com/ads/conversion-tracking
 *
 * Requires two environment variables, set in Netlify (Site configuration -> Environment
 * variables), neither of which exists yet as of 2026-10-30:
 *   OPENAI_PIXEL_ID              - from Ads Manager -> Conversions tab -> data source
 *   OPENAI_CONVERSIONS_API_KEY   - from the same tab, "Manage conversion keys"
 *
 * Until both are set, this function accepts the call (so the page's own flow never errors)
 * but does not forward anything, and says so in the response and the function log.
 *
 * Deliberately sends no PII: no name, email, phone, or form content. Only the event type,
 * a client-generated event id (for pixel/CAPI de-duplication per OpenAI's docs), the OpenAI
 * oppref click reference when present, and the page URL.
 */

var ALLOWED_TYPES = ['lead_created', 'appointment_scheduled'];

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  var type = payload.type;
  var eventId = payload.event_id;
  var attribution = payload.attribution || {};
  var sourceUrl = payload.source_url;

  if (!type || ALLOWED_TYPES.indexOf(type) === -1) {
    return { statusCode: 400, body: 'Unsupported or missing event type' };
  }
  if (!eventId) {
    return { statusCode: 400, body: 'Missing event_id' };
  }

  var pixelId = process.env.OPENAI_PIXEL_ID;
  var apiKey = process.env.OPENAI_CONVERSIONS_API_KEY;

  if (!pixelId || !apiKey) {
    console.log(
      '[report-conversion] Not configured (missing OPENAI_PIXEL_ID / OPENAI_CONVERSIONS_API_KEY). ' +
      'Received but did not forward:', type, eventId
    );
    return {
      statusCode: 200,
      body: JSON.stringify({ forwarded: false, reason: 'not_configured' })
    };
  }

  var oaiEvent = {
    id: eventId,
    type: type,
    timestamp_ms: Date.now(),
    action_source: 'web',
    data: { type: 'customer_action' }
  };
  if (attribution.oppref) {
    oaiEvent.oppref = attribution.oppref;
  }
  if (sourceUrl) {
    oaiEvent.source_url = sourceUrl;
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
    console.log('[report-conversion] OpenAI CAPI response', resp.status, text);

    return {
      statusCode: 200,
      body: JSON.stringify({ forwarded: true, openai_status: resp.status })
    };
  } catch (err) {
    console.log('[report-conversion] OpenAI CAPI request failed:', err && err.message);
    return {
      statusCode: 502,
      body: JSON.stringify({ forwarded: false, reason: 'capi_request_failed' })
    };
  }
};
