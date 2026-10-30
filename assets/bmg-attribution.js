/* BMG ad-attribution capture (ChatGPT Ads pilot, 2026-10-30).
 * Captures utm_source/utm_medium/utm_campaign/utm_content/utm_term, OpenAI's campaign_id
 * and ad_id macros, and OpenAI's oppref click reference from the landing URL, and persists
 * them for the rest of the browser session so later pages (e.g. /contact/, /thank-you/)
 * still have them even though internal links on this site carry no query string.
 *
 * Does not collect or store anything the visitor typed (name, email, message, phone).
 */
(function (w, d) {
  'use strict';

  var STORE_KEY = 'bmg_attr_v1';
  var FIELDS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'campaign_id', 'ad_id', 'oppref'
  ];

  function readStored() {
    try {
      var raw = w.sessionStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function writeStored(obj) {
    try {
      w.sessionStorage.setItem(STORE_KEY, JSON.stringify(obj));
    } catch (e) {
      /* sessionStorage unavailable (privacy mode, etc.) - attribution just won't persist */
    }
  }

  function fromQuery() {
    var out = {};
    try {
      var params = new URLSearchParams(w.location.search);
      FIELDS.forEach(function (f) {
        var v = params.get(f);
        if (v) {
          out[f] = v;
        }
      });
    } catch (e) {
      /* URLSearchParams unsupported - no capture on this load */
    }
    return out;
  }

  var merged = readStored();
  var fresh = fromQuery();
  var sawFreshParams = false;
  for (var k in fresh) {
    if (fresh[k]) {
      merged[k] = fresh[k];
      sawFreshParams = true;
    }
  }
  if (sawFreshParams) {
    writeStored(merged);
  }

  function get() {
    return readStored();
  }

  /* Builds a Calendly URL carrying whatever attribution is on hand. Calendly only stores a
   * fixed set of passthrough fields on the invitee record (utm_source/medium/campaign/
   * content/term, plus a generic "salesforce_uuid" identifier field; see Calendly's
   * documented event tracking parameters). utm_campaign is already taken by the ad's own
   * utm_campaign=phoenix_pilot, so OpenAI's campaign_id/ad_id macros ride in utm_content/
   * utm_term instead, and OpenAI's oppref click reference rides in salesforce_uuid so the
   * Calendly webhook can hand it back to the OpenAI Conversions API unchanged. */
  function calendlyUrl(base) {
    var a = get();
    var qp = [];
    if (a.utm_source) { qp.push('utm_source=' + encodeURIComponent(a.utm_source)); }
    if (a.utm_medium) { qp.push('utm_medium=' + encodeURIComponent(a.utm_medium)); }
    if (a.utm_campaign) { qp.push('utm_campaign=' + encodeURIComponent(a.utm_campaign)); }
    if (a.campaign_id) { qp.push('utm_content=' + encodeURIComponent(a.campaign_id)); }
    if (a.ad_id) { qp.push('utm_term=' + encodeURIComponent(a.ad_id)); }
    if (a.oppref) { qp.push('salesforce_uuid=' + encodeURIComponent(a.oppref)); }
    if (!qp.length) {
      return base;
    }
    return base + (base.indexOf('?') === -1 ? '?' : '&') + qp.join('&');
  }

  /* Adds/updates hidden inputs on a form so Brad's Formspree inbox shows which campaign a
   * lead came from. Only ever writes the attribution fields above - never touches or reads
   * any field the visitor filled in. */
  function hiddenFieldsInto(form) {
    var a = get();
    FIELDS.forEach(function (f) {
      if (!a[f]) {
        return;
      }
      var existing = form.querySelector('input[name="' + f + '"]');
      if (existing) {
        existing.value = a[f];
        return;
      }
      var input = d.createElement('input');
      input.type = 'hidden';
      input.name = f;
      input.value = a[f];
      form.appendChild(input);
    });
  }

  w.BMG_ATTR = { get: get, calendlyUrl: calendlyUrl, hiddenFieldsInto: hiddenFieldsInto };
})(window, document);
