/*
 * Vantage — capture.js  (content script)
 *
 * Reads the composer at submit time, works out which surface of the platform
 * it was sent to, redacts it in-page, classifies it, and hands a metrics record
 * to the service worker. The raw prompt string never leaves this function
 * scope: `buildEvent` redacts before the object is constructed.
 *
 * Response text is measured, never stored.
 */
(function () {
  'use strict';
  const VG = self.VG;
  if (!VG || window.__vantageLoaded) return;
  window.__vantageLoaded = true;

  const QUIESCE_MS = 1500;
  const MAX_RESPONSE_MS = 180000;
  const DEDUPE_MS = 2500;
  const HEALTH_CHECK_MS = 12000;

  let settings = null;
  let adapter = null;
  let lastHash = '';
  let lastHashTs = 0;
  let lastEventId = null;
  let lastEventMeta = null;
  let currentConversation = '';
  let turnCounter = 0;
  // What this thread has been about so far, so short follow-up turns
  // ("make it shorter", "now in Malay") inherit the topic instead of
  // falling into Uncategorised.
  let threadContext = null;
  let watcher = null;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /*
   * Settings live in the service worker, and an MV3 worker can be cold — the
   * round-trip is sometimes hundreds of milliseconds. Waiting for it before
   * attaching listeners loses the first prompts after a page load, so the
   * adapter is resolved synchronously from the built-ins first and refined
   * once the real settings arrive.
   */
  function resolveSync() {
    adapter = VG.resolveAdapter(location.hostname, VG.DEFAULT_SETTINGS);
    return adapter;
  }

  let settingsPromise = null;
  let attached = false;
  function loadSettings() {
    settingsPromise = send({ type: 'GET_SETTINGS' }).then((res) => {
      settings = (res && res.settings) || VG.DEFAULT_SETTINGS;
      adapter = VG.resolveAdapter(location.hostname, settings);
      // If the real settings say this host is not covered — the adapter was
      // removed, or policy disabled the site — stop listening entirely rather
      // than relying on a downstream guard. Nothing should be read from a page
      // we have decided not to cover.
      if (!adapter) detach();
      mark(adapter ? 'ready' : 'not-covered');
      return adapter;
    });
    return settingsPromise;
  }

  function attach() {
    if (attached) return;
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('copy', onCopy, true);
    attached = true;
  }

  function detach() {
    if (!attached) return;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('copy', onCopy, true);
    attached = false;
  }

  async function ensureSettings() {
    if (settings) return;
    await (settingsPromise || loadSettings());
  }

  // Main-world readiness marker: lets a test, the probe, or a human confirm
  // the content script is attached without reaching into the isolated world.
  function mark(state) {
    try { document.documentElement.setAttribute('data-vantage', state); } catch (e) { /* pre-DOM */ }
  }

  function minimalScope() {
    return !settings || settings.domScope !== 'standard';
  }

  function capturing() {
    if (!settings || !adapter) return false; // snapshot() awaits settings first
    if (!settings.enabled) return false;
    if (settings.pausedUntil && Date.now() < settings.pausedUntil) return false;
    return true;
  }

  /* ---------------------------- DOM access ---------------------------- */

  function composerEl(fromTarget) {
    if (fromTarget) {
      const hit = VG.closestAny(fromTarget, adapter.selectors.composer);
      if (hit) return hit;
    }
    return VG.pick(adapter.selectors.composer);
  }

  function readComposer(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  function modelLabel() {
    const el = VG.pick(adapter.selectors.model);
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  }

  function attachmentCount() { return VG.pickAll(adapter.selectors.attachment).length; }
  function threadRoot() { return VG.pick(adapter.selectors.thread) || document.body; }
  function assistantTurns() { return VG.pickAll(adapter.selectors.assistantTurn, threadRoot()); }
  function userTurnCount() { return VG.pickAll(adapter.selectors.userTurn, threadRoot()).length; }

  function conversationKey() {
    try { return adapter.conversationId(new URL(location.href)); }
    catch (e) { return location.pathname; }
  }

  /* ------------------------------ event ------------------------------ */

  async function buildEvent(rawText) {
    const level = settings.captureLevel;
    const red = VG.redact(rawText, settings);
    const raw = VG.classify(red.text, settings);
    const cls = VG.applyContext(raw, threadContext, turnCounter);
    if (cls.source === 'direct' && cls.id !== 'other' && cls.confidence >= 0.4) {
      threadContext = { workType: cls.id, confidence: cls.confidence };
    }
    const surf = VG.detectSurface(adapter, new URL(location.href), document);

    const ev = VG.newEvent();
    ev.site = adapter.id;
    ev.host = location.hostname;
    ev.model = modelLabel();

    ev.surface = surf.surface;
    ev.surfaceLabel = surf.surfaceLabel;
    ev.surfaceFlags = surf.flags;
    ev.agentType = surf.agentType;
    ev.shared = surf.shared;
    // Agent ids are hashed; the display name is run through the org wordlist so
    // a project called after a classified programme does not leak into reports.
    ev.agentKey = surf.agentIdRaw
      ? await VG.hash(adapter.id + '|' + surf.agentIdRaw, 16)
      : '';
    ev.agentName = surf.agentName ? VG.redact(surf.agentName, settings).text.slice(0, 80) : '';

    ev.conversationHash = await VG.hash(location.hostname + '|' + conversationKey(), 16);
    ev.turn = turnCounter;
    ev.promptChars = rawText.length;
    ev.promptWords = VG.wordCount(rawText);
    ev.workType = cls.id;
    ev.workTypeLabel = cls.label;
    ev.workTypeConfidence = cls.confidence;
    ev.workTypeRunnerUp = cls.runnerUp;
    ev.workTypeSecondary = cls.secondary || '';
    ev.workTypeSource = cls.source || 'direct';
    ev.nonWork = !!cls.nonWork;
    ev.accountTier = VG.detectAccount(adapter, document, settings);
    ev.redactionHits = red.hits;
    ev.redactionCount = red.count;
    ev.attachments = attachmentCount();

    if (level === VG.CAPTURE_LEVELS.REDACTED) ev.promptText = red.text.slice(0, 4000);
    else if (level === VG.CAPTURE_LEVELS.FULL && settings.allowFullText) ev.promptText = rawText.slice(0, 4000);
    else ev.promptText = '';

    return { ev, redactionCount: red.count };
  }

  /* -------------------------- response watch -------------------------- */

  /*
   * Response measurement.
   *
   * Under the default 'minimal' scope this never reads the response. Timing
   * comes from the fact that mutations are happening inside the assistant
   * container and then stop — structural signals, no text pulled into memory.
   * The observer is also scoped to the assistant container where one can be
   * found, rather than the whole thread.
   */
  function watchResponse(eventId, submitTs) {
    if (watcher) watcher.stop();

    const minimal = minimalScope();
    const turnsAtStart = assistantTurns();
    const root = turnsAtStart.length
      ? (turnsAtStart[turnsAtStart.length - 1].parentElement || threadRoot())
      : threadRoot();
    const baseline = turnsAtStart.length;
    // Without turn selectors there is nothing structural to look for, so any
    // mutation has to stand in for "generation started".
    const hasTurnSelectors = (adapter.selectors.assistantTurn || []).length > 0;
    let turnCountCache = { at: 0, n: baseline };
    let firstTokenMs = null;
    let quiesceTimer = null;
    let stopped = false;

    const finish = async () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(quiesceTimer);
      clearTimeout(hardStop);
      obs.disconnect();
      watcher = null;

      const patch = { firstTokenMs, responseMs: Date.now() - submitTs };

      if (!minimal) {
        // Opt-in only: this is the one place the response text is touched.
        const turns = assistantTurns();
        const last = turns[turns.length - 1];
        const text = last ? (last.innerText || '') : '';
        patch.responseChars = text.length;
        patch.responseHasCode = !!(last && (last.querySelector('pre, code') || /```/.test(text)));
      }
      await send({ type: 'PATCH_EVENT', id: eventId, patch });
    };

    const onMutation = () => {
      // Generation has started when a NEW assistant turn element exists.
      // Counting elements is structural — no response content is examined.
      // (Previously any mutation counted once a prior turn existed, which made
      // every turn after the first report a near-zero time to first token.)
      if (firstTokenMs === null) {
        let started;
        if (hasTurnSelectors) {
          const now = Date.now();
          if (now - turnCountCache.at > 120) {
            turnCountCache = { at: now, n: assistantTurns().length };
          }
          started = turnCountCache.n > baseline;
        } else {
          started = true;
        }
        if (started) firstTokenMs = Date.now() - submitTs;
      }
      clearTimeout(quiesceTimer);
      quiesceTimer = setTimeout(finish, QUIESCE_MS);
    };

    const obs = new MutationObserver(onMutation);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    const hardStop = setTimeout(finish, MAX_RESPONSE_MS);
    // Do not leave an observer running on a page the user has left.
    window.addEventListener('pagehide', () => finish(), { once: true });
    watcher = { stop: finish };
  }

  /* ------------------------------ capture ----------------------------- */

  /**
   * `raw` is read by the caller SYNCHRONOUSLY, before the site clears the
   * composer. Everything after that point may await.
   */
  async function snapshot(raw) {
    await ensureSettings();
    // Re-check after settings land: the site may be disabled by policy, or
    // covered by a pushed adapter rather than the built-in one.
    if (!capturing()) return;

    const h = raw.length + ':' + raw.slice(0, 64);
    const now = Date.now();
    if (h === lastHash && now - lastHashTs < DEDUPE_MS) return;
    lastHash = h;
    lastHashTs = now;

    const key = conversationKey();
    if (key !== currentConversation) {
      currentConversation = key;
      turnCounter = 0;
      threadContext = null;
    }
    const domTurns = userTurnCount();
    turnCounter = domTurns > 0 ? domTurns + 1 : turnCounter + 1;

    const { ev, redactionCount } = await buildEvent(raw);
    const res = await send({ type: 'EVENT', event: ev });
    lastEventId = res && res.id ? res.id : null;
    lastEventMeta = { workTypeLabel: ev.workTypeLabel, surfaceLabel: ev.surfaceLabel };

    if (lastEventId) watchResponse(lastEventId, ev.ts);
    if (settings.showCaptureToast) toast(redactionCount, ev);
  }

  /* --------------------------- transparency --------------------------- */

  let toastEl = null;
  function toast(redactions, ev) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-vantage-toast', '');
      Object.assign(toastEl.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
        font: '12px/1.4 -apple-system, Segoe UI, system-ui, sans-serif',
        background: 'rgba(17,24,39,.92)', color: '#fff', padding: '7px 11px',
        borderRadius: '8px', pointerEvents: 'none', opacity: '0',
        transition: 'opacity .18s ease', boxShadow: '0 4px 14px rgba(0,0,0,.25)'
      });
      document.documentElement.appendChild(toastEl);
    }
    const where = ev && ev.surface !== 'chat' ? ` · ${ev.surfaceLabel}` : '';
    toastEl.textContent = redactions
      ? `Vantage: logged${where} · ${redactions} item${redactions === 1 ? '' : 's'} redacted`
      : `Vantage: logged${where}`;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl.__t);
    toastEl.__t = setTimeout(() => { toastEl.style.opacity = '0'; }, 2200);
  }

  /* ---------------------- point-of-value micro-survey ------------------ *
   * Fires only after the user has copied a real chunk of output out of the
   * page — the moment something was actually used. One tap, dismissible,
   * heavily rate limited. This is the only field in the whole system that can
   * support a claim about time saved; everything else is a proxy.
   * -------------------------------------------------------------------- */

  let surveyEl = null;

  function closeSurvey() {
    if (surveyEl) { surveyEl.remove(); surveyEl = null; }
  }

  async function maybeAskValue(eventId) {
    if (!settings.valueSurveyEnabled || !eventId) return;
    const ok = await send({ type: 'CAN_ASK_VALUE' });
    if (!ok || !ok.allowed) return;
    showSurvey(eventId);
  }

  function showSurvey(eventId) {
    closeSurvey();
    const box = document.createElement('div');
    box.setAttribute('data-vantage-survey', '');
    Object.assign(box.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
      font: '13px/1.45 -apple-system, Segoe UI, system-ui, sans-serif',
      background: '#fff', color: '#14181f', padding: '13px 15px',
      border: '1px solid #dfe3e8', borderRadius: '11px', width: '292px',
      boxShadow: '0 8px 28px rgba(0,0,0,.18)'
    });
    if (matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) {
      Object.assign(box.style, { background: '#171c24', color: '#e8ecf2', borderColor: '#2b323d' });
    }

    const q = document.createElement('div');
    q.textContent = 'Roughly how much time did that just save you?';
    q.style.fontWeight = '560';
    q.style.marginBottom = '9px';

    const note = document.createElement('div');
    note.textContent = lastEventMeta
      ? `${lastEventMeta.workTypeLabel} · ${lastEventMeta.surfaceLabel}`
      : '';
    Object.assign(note.style, { fontSize: '11px', opacity: '.6', marginBottom: '9px' });

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });

    [['None', 0], ['<15 min', 15], ['15–60 min', 60], ['>1 hr', 120]].forEach(([label, mins]) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        font: 'inherit', fontSize: '12px', padding: '5px 9px', cursor: 'pointer',
        borderRadius: '7px', border: '1px solid currentColor', opacity: '.85',
        background: 'transparent', color: 'inherit'
      });
      b.addEventListener('click', async () => {
        await send({ type: 'VALUE_ANSWER', id: eventId, savedMinutes: mins });
        q.textContent = 'Logged — thank you.';
        note.textContent = 'Stays on this device with the rest of your data.';
        row.remove();
        setTimeout(closeSurvey, 1400);
      });
      row.appendChild(b);
    });

    const dismiss = document.createElement('button');
    dismiss.textContent = '×';
    Object.assign(dismiss.style, {
      position: 'absolute', top: '7px', right: '9px', border: 'none',
      background: 'transparent', color: 'inherit', opacity: '.45',
      cursor: 'pointer', font: 'inherit', fontSize: '15px', lineHeight: '1'
    });
    dismiss.addEventListener('click', closeSurvey);

    box.append(dismiss, q, note, row);
    document.documentElement.appendChild(box);
    surveyEl = box;
    setTimeout(() => { if (surveyEl === box) closeSurvey(); }, 25000);
  }

  /* ------------------------------ events ------------------------------ */

  // Last-resort composer lookup, used before an adapter is known.
  function genericComposer(target) {
    if (target && target.closest) {
      const hit = target.closest('div[contenteditable="true"], textarea, input[type="text"]');
      if (hit) return hit;
    }
    return document.querySelector('div[contenteditable="true"], textarea');
  }

  /*
   * With Canvas or an Artifact panel open there can be several editable
   * elements on the page, and the first match in document order is not
   * necessarily the composer. Search outwards from the button that was
   * actually clicked before falling back to a document-wide match.
   */
  function composerNear(btn) {
    if (adapter && btn && btn.closest) {
      const scope = btn.closest('form, [role="form"], footer, div[class*="composer" i]');
      if (scope) {
        const hit = VG.pick(adapter.selectors.composer, scope);
        if (hit) return hit;
      }
    }
    return (adapter && composerEl(null)) || genericComposer(btn);
  }

  function onKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    const el = adapter
      ? VG.closestAny(e.target, adapter.selectors.composer)
      : genericComposer(e.target);
    if (!el) return;
    const raw = readComposer(el).trim();
    if (raw) snapshot(raw);
  }

  function onClick(e) {
    if (adapter && VG.closestAny(e.target, adapter.selectors.regenerate) && lastEventId) {
      send({ type: 'BUMP_EVENT', id: lastEventId, field: 'regenerated', by: 1 });
      return;
    }
    const sendSel = adapter ? adapter.selectors.send : VG.GENERIC_ADAPTER.selectors.send;
    const btn = VG.closestAny(e.target, sendSel);
    if (!btn) return;
    const raw = readComposer(composerNear(btn)).trim();
    if (raw) snapshot(raw);
  }

  /*
   * Copy-out. The metric that matters is the RATE — that output was taken into
   * other work — not how many characters. Under the default scope the event
   * alone is recorded and the selection is never materialised.
   */
  /*
   * Is the selection a substantial chunk rather than a word or two? Measured
   * from the selection's rendered geometry, so the answer comes from layout
   * rather than from reading the text. Roughly: more than two lines, or a full
   * wide line.
   */
  function selectionLooksSubstantial() {
    try {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      return rect.height >= 34 || (rect.height >= 14 && rect.width >= 320);
    } catch (e) {
      return false;
    }
  }

  function onCopy() {
    if (!capturing() || !lastEventId) return;
    const id = lastEventId;

    if (minimalScope()) {
      send({ type: 'BUMP_EVENT', id, field: 'copyEvents', by: 1 });
      // Only a substantial copy counts towards the value estimate, otherwise
      // copying a single word inflates the extrapolated hours.
      if (selectionLooksSubstantial()) {
        send({ type: 'BUMP_EVENT', id, field: 'copyLarge', by: 1 });
        setTimeout(() => maybeAskValue(id), 900);
      }
      return;
    }

    const sel = String(window.getSelection ? window.getSelection() : '');
    if (sel.length < 20) return;
    send({ type: 'BUMP_EVENT', id, field: 'copyEvents', by: 1 });
    send({ type: 'BUMP_EVENT', id, field: 'copiedOut', by: sel.length });
    if (sel.length >= 200) {
      send({ type: 'BUMP_EVENT', id, field: 'copyLarge', by: 1 });
      setTimeout(() => maybeAskValue(id), 900);
    }
  }

  /* ------------------------------- health ------------------------------ *
   * Report that a covered host was loaded, and whether the composer selector
   * still resolves. Fleet-wide this is how selector drift is spotted before a
   * month of data is silently lost.
   * -------------------------------------------------------------------- */
  function reportHealth() {
    const found = !!VG.pick(adapter.selectors.composer);
    send({
      type: 'SITE_SEEN',
      site: adapter.id,
      host: location.hostname,
      composerFound: found,
      revision: adapter.revision || 0,
      source: adapter.source || 'builtin'
    });
  }

  /* ------------------------------- probe ------------------------------- *
   * Same check as tools/selector-probe.js, but run against the adapter this
   * device is actually using — including anything pushed by policy, which the
   * standalone snippet cannot know about. Reports selectors only.
   * -------------------------------------------------------------------- */
  function probeGroup(list) {
    for (let i = 0; i < (list || []).length; i++) {
      try {
        const els = document.querySelectorAll(list[i]);
        if (els.length) return { hit: list[i], index: i, count: els.length };
      } catch (e) { /* invalid selector */ }
    }
    return { hit: null, index: -1, count: 0, tried: (list || []).length };
  }

  function runProbe() {
    if (!adapter) return { covered: false, host: location.hostname };
    const groups = ['composer', 'send', 'thread', 'userTurn', 'assistantTurn', 'model', 'regenerate', 'attachment'];
    const critical = { composer: true, send: true };
    const rows = [];
    const broken = [];
    const degraded = [];

    groups.forEach((g) => {
      const r = probeGroup(adapter.selectors[g]);
      rows.push({ group: g, matched: r.hit, index: r.index, count: r.count });
      if (!r.hit && critical[g]) broken.push(g);
      else if (!r.hit) degraded.push(g);
      else if (r.index > 0) degraded.push(g + ' (fallback)');
    });

    const surf = VG.detectSurface(adapter, new URL(location.href), document);
    return {
      covered: true,
      site: adapter.id,
      label: adapter.label,
      source: adapter.source || 'builtin',
      revision: adapter.revision || 0,
      host: location.hostname,
      rows,
      broken,
      degraded,
      surface: surf.surface,
      surfaceLabel: surf.surfaceLabel,
      surfaceFlags: surf.flags,
      agentDetected: !!surf.agentIdRaw,
      agentNamed: !!surf.agentName,
      shared: surf.shared,
      accountTier: VG.detectAccount(adapter, document, settings),
      verdict: broken.length ? 'broken' : degraded.length ? 'degraded' : 'healthy'
    };
  }

  /* -------------------------------- init ------------------------------- */

  function init() {
    // Attach before anything async, so no prompt is lost to a cold worker.
    attach();

    resolveSync();
    mark('armed');
    loadSettings();

    setTimeout(() => { if (adapter) reportHealth(); }, HEALTH_CHECK_MS);

    let href = location.href;
    setInterval(() => {
      if (location.href !== href) {
        href = location.href;
        const key = conversationKey();
        if (key !== currentConversation) {
          currentConversation = key;
          turnCounter = 0;
          threadContext = null;
          lastEventId = null;
          closeSurvey();
        }
      }
    }, 1200);

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'PROBE') { sendResponse(runProbe()); return true; }
      return false;
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if ((area === 'local' && changes.settings) || area === 'managed') loadSettings();
    });
  }

  init();
})();
