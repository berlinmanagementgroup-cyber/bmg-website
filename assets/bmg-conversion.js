/* BMG conversion relay (ChatGPT Ads pilot, 2026-10-30).
 * Fire-and-forget forward of a conversion event to a Netlify Function, which relays it
 * server-side to OpenAI's Ads Conversions API (the API key never reaches the browser; see
 * netlify/functions/report-conversion.js). Never blocks the page's own redirect or UX -
 * failures are swallowed. Sends no PII: just an event type, a generated event id, the
 * campaign attribution captured by bmg-attribution.js, and the current page URL.
 */
(function (w) {
  'use strict';

  function uuid() {
    if (w.crypto && w.crypto.randomUUID) {
      return w.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* Reports an event at most once per browser session per type, so a page reload or
   * back-button return to /thank-you/ cannot double-count a lead. */
  function report(type, extra) {
    try {
      var dedupeKey = 'bmg_sent_' + type;
      if (w.sessionStorage && w.sessionStorage.getItem(dedupeKey)) {
        return;
      }
      var attribution = (w.BMG_ATTR && w.BMG_ATTR.get()) || {};
      var eventId = uuid();
      var payload = JSON.stringify({
        type: type,
        event_id: eventId,
        attribution: attribution,
        source_url: w.location.href,
        extra: extra || {}
      });

      if (w.sessionStorage) {
        w.sessionStorage.setItem(dedupeKey, eventId);
      }

      if (w.navigator && w.navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        w.navigator.sendBeacon('/.netlify/functions/report-conversion', blob);
      } else if (w.fetch) {
        w.fetch('/.netlify/functions/report-conversion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(function () { /* best-effort */ });
      }
    } catch (e) {
      /* best-effort only - never let tracking break the page */
    }
  }

  w.BMG_CONVERSION = { report: report };
})(window);
