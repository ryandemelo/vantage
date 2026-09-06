/*
 * Vantage, net-hook.js
 *
 * Runs in the page's own JavaScript context, which is the only place a site's
 * fetch and XMLHttpRequest can be observed. Its job is narrow: notice a same
 * origin JSON POST and hand it to the extension. It decides nothing.
 *
 * This exists because reading the prompt out of the rendered page means
 * depending on CSS classes and test ids, which change constantly. The request a
 * site sends to its own API is far more stable, because changing it breaks
 * their own clients.
 *
 * Privacy notes, since this runs with full access to every request the page
 * makes:
 *
 *   - Only same origin POSTs with a small JSON string body are considered.
 *     Uploads, streams, form data and cross origin requests are skipped here,
 *     so they never cross at all.
 *   - What crosses goes to the extension's own isolated world. It cannot leak
 *     to the page, which already holds the body since it is the page's own
 *     request.
 *   - Extraction, redaction, classification and storage all happen on the
 *     extension side. This file makes no decisions and keeps no state beyond a
 *     short startup buffer that is capped and expires.
 *   - Deliberately small. Code running in a page's own context is the most
 *     dangerous code in an extension, so this does as little as possible.
 */
(function () {
  'use strict';
  if (window.__vantageNetHook) return;
  window.__vantageNetHook = true;

  const CHANNEL = 'vantage:net';
  const MAX_BODY = 512 * 1024;     // ignore anything larger, it is not a prompt
  const BUFFER_MAX = 5;
  const BUFFER_TTL_MS = 15000;

  let ready = false;
  let buffer = [];

  /* The extension signals when its isolated world is listening. Until then
   * eligible requests are held briefly, so a prompt sent immediately after page
   * load is not lost to the startup race. */
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.channel !== CHANNEL) return;
    if (e.data.type !== 'ready') return;
    ready = true;
    const held = buffer;
    buffer = [];
    held.forEach((r) => { if (Date.now() - r.at < BUFFER_TTL_MS) post(r.url, r.method, r.body); });
  });

  function post(url, method, body) {
    window.postMessage({ channel: CHANNEL, type: 'request', url, method, body }, window.location.origin);
  }

  function consider(url, method, body) {
    if (!ready) {
      buffer.push({ url, method, body, at: Date.now() });
      if (buffer.length > BUFFER_MAX) buffer.shift();
      return;
    }
    post(url, method, body);
  }

  function eligible(url, method, body) {
    if (String(method || '').toUpperCase() !== 'POST') return false;
    if (typeof body !== 'string' || !body || body.length > MAX_BODY) return false;
    // Same origin only. A prompt going anywhere else is not this site's API.
    try {
      const u = new URL(url, window.location.href);
      if (u.origin !== window.location.origin) return false;
    } catch (e) {
      return false;
    }
    // Cheap shape check before parsing.
    const first = body[0];
    return first === '{' || first === '[';
  }

  /* ------------------------------- fetch -------------------------------- */

  /* A Request object carries its body as a stream rather than a string, and
   * when one is passed without an init there is no string to inspect. Clone it
   * and read the copy, so the original is untouched and the page is unaffected.
   * The clone is only taken for same origin POSTs, never for anything else. */
  function considerRequestObject(req) {
    try {
      if (!req || typeof req.clone !== 'function') return;
      if (String(req.method || '').toUpperCase() !== 'POST') return;
      const u = new URL(req.url, window.location.href);
      if (u.origin !== window.location.origin) return;
      req.clone().text().then((body) => {
        if (eligible(req.url, 'POST', body)) consider(req.url, 'POST', body);
      }).catch(() => {});
    } catch (e) {
      /* observation must never break the page */
    }
  }

  const realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const body = init && init.body;
        if (typeof body === 'string') {
          if (eligible(url, method, body)) consider(url, method, body);
        } else if (input && typeof input === 'object' && typeof input.clone === 'function') {
          considerRequestObject(input);
        }
      } catch (e) {
        /* observation must never break the page */
      }
      return realFetch.apply(this, arguments);
    };
    // Keep the original shape so feature detection and toString checks pass.
    try {
      Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
      window.fetch.toString = () => realFetch.toString();
    } catch (e) { /* non fatal */ }
  }

  /* -------------------------------- XHR --------------------------------- */

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      try {
        this.__vantage = { method, url };
      } catch (e) { /* frozen instance */ }
      return realOpen.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      try {
        const m = this.__vantage;
        if (m && eligible(m.url, m.method, body)) consider(m.url, m.method, body);
      } catch (e) {
        /* observation must never break the page */
      }
      return realSend.apply(this, arguments);
    };
  }
})();
