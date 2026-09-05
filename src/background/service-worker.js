/*
 * Vantage, service-worker.js
 * Message router, retention enforcement, badge counter.
 * Classic (non-module) worker so the same core files load here and in pages.
 */
/* global importScripts */
importScripts(
  '../core/schema.js',
  '../core/redact.js',
  '../core/classify.js',
  '../core/adapters.js',
  '../core/surfaces.js',
  '../core/db.js',
  '../core/report.js',
  '../core/sign.js',
  '../core/upload.js'
);

const VG = self.VG;

/* ------------------------------ badge ------------------------------ */

async function refreshBadge() {
  try {
    const start = VG.startOfDay(Date.now());
    const n = await VG.db.countRange(start, start + 86400000);
    await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
  } catch (e) {
    /* badge is cosmetic */
  }
}

/* ---------------------------- retention ---------------------------- */

async function enforceRetention() {
  const settings = await VG.settings.get();
  const days = Number(settings.retentionDays) || 0;
  if (days > 0) {
    const removed = await VG.db.purgeOlderThan(days);
    if (removed) console.info(`[Vantage] retention: removed ${removed} events older than ${days}d`);
  }
  // If the capture level was lowered to metadata, drop any text already held.
  if (settings.captureLevel === VG.CAPTURE_LEVELS.METADATA) {
    await VG.db.stripText();
  }
}

/* ----------------------------- upload ------------------------------ *
 * Runs from an alarm in the service worker, so it does not depend on an AI
 * site, or any tab at all, being open. The alarm fires hourly and almost
 * always no-ops; the work only happens when a completed period has not been
 * sent yet and the backoff allows an attempt.
 * ------------------------------------------------------------------- */

async function uploadState() {
  const s = await chrome.storage.local.get('uploadState');
  return s.uploadState || { sentPeriods: [], failures: 0, lastAttemptAt: 0, history: [] };
}

async function setUploadState(patch) {
  const cur = await uploadState();
  const next = Object.assign({}, cur, patch);
  // Keep the sent list bounded; it only needs to cover the catch-up window.
  if (next.sentPeriods && next.sentPeriods.length > 40) {
    next.sentPeriods = next.sentPeriods.slice(-40);
  }
  if (next.history && next.history.length > 20) next.history = next.history.slice(-20);
  await chrome.storage.local.set({ uploadState: next });
  return next;
}

async function endpointPermitted(url) {
  try {
    const origin = new URL(url).origin + '/*';
    return await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

async function runUpload(trigger) {
  const settings = await VG.settings.get();
  if (!settings.uploadEnabled || !settings.uploadUrl) return { skipped: 'disabled' };

  const state = await uploadState();
  if (!VG.uploadBackoffOk(state)) return { skipped: 'backoff' };

  const pending = VG.pendingPeriods(settings, state);
  if (!pending.length) return { skipped: 'nothing due' };

  if (!(await endpointPermitted(settings.uploadUrl))) {
    await setUploadState({
      lastAttemptAt: Date.now(),
      lastStatus: 'no host permission for the configured endpoint'
    });
    return { skipped: 'no-permission' };
  }

  // Oldest missed period first, one per wake, so a long-closed browser catches
  // up steadily instead of firing a burst.
  const period = pending[0];
  const events = await VG.db.range(period.from, period.to);
  const longFrom = VG.addDays(period.to, -90);
  const longEvents = await VG.db.range(Math.min(longFrom, period.from), period.to);
  const prev = await VG.db.range(period.prevFrom, period.from);
  const org = await handlers.GET_ORG();

  const report = VG.buildReport(events, prev, period, settings, longEvents, org);
  const body = await VG.buildUploadPayload({ report, events, settings, org, period });

  const headers = { 'Content-Type': 'application/json' };
  if (settings.uploadAuthHeader) headers.Authorization = settings.uploadAuthHeader;

  try {
    const res = await fetch(settings.uploadUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const next = await uploadState();
    await setUploadState({
      sentPeriods: (next.sentPeriods || []).concat([period.id]),
      failures: 0,
      lastAttemptAt: Date.now(),
      lastUploadAt: Date.now(),
      lastStatus: 'sent ' + period.id + ' (' + report.totals.prompts + ' prompts)',
      history: (next.history || []).concat([{
        at: Date.now(), period: period.id, prompts: report.totals.prompts, ok: true, trigger
      }])
    });
    return { sent: period.id, prompts: report.totals.prompts };
  } catch (err) {
    const next = await uploadState();
    const failures = (next.failures || 0) + 1;
    await setUploadState({
      failures,
      lastAttemptAt: Date.now(),
      lastStatus: 'failed: ' + (err && err.message ? err.message : String(err)) +
        ' (attempt ' + failures + ')',
      history: (next.history || []).concat([{
        at: Date.now(), period: period.id, ok: false, error: String(err && err.message || err), trigger
      }])
    });
    return { error: String(err && err.message || err) };
  }
}

/* ---------------------------- lifecycle ---------------------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  const local = await chrome.storage.local.get('settings');
  if (!local.settings) {
    await chrome.storage.local.set({ settings: Object.assign({}, VG.DEFAULT_SETTINGS) });
  }
  // Mint a local signing key if policy has not pushed one. Reports are
  // tamper-evident from the first export rather than from whenever someone
  // remembers to configure it.
  const cur = await VG.settings.get();
  if (!cur.reportSigningKey) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    await VG.settings.set({ reportSigningKey: hex });
  }

  chrome.alarms.create('vantage-retention', { periodInMinutes: 360, when: Date.now() + 60000 });
  // Hourly rather than daily: a browser that is only open briefly still gets
  // several chances, and a due-check with nothing to do costs nothing.
  chrome.alarms.create('vantage-upload', { periodInMinutes: 60, when: Date.now() + 120000 });
  refreshBadge();

  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options.html#welcome') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('vantage-retention', { periodInMinutes: 360, when: Date.now() + 60000 });
  chrome.alarms.create('vantage-upload', { periodInMinutes: 60, when: Date.now() + 120000 });
  refreshBadge();
  // Catch up immediately on a browser that has been closed for a while.
  runUpload('startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vantage-retention') {
    enforceRetention().then(refreshBadge);
  }
  if (alarm.name === 'vantage-upload') {
    runUpload('alarm').catch((e) => console.error('[Vantage] upload', e));
  }
});

/* --------------------------- message API --------------------------- */

const handlers = {
  async GET_SETTINGS() {
    return { settings: await VG.settings.get() };
  },

  async SET_SETTINGS(msg) {
    const settings = await VG.settings.set(msg.patch || {});
    if (settings.captureLevel === VG.CAPTURE_LEVELS.METADATA) await VG.db.stripText();
    return { settings };
  },

  async EVENT(msg) {
    const settings = await VG.settings.get();
    if (!settings.enabled) return { id: null };
    if (settings.pausedUntil && Date.now() < settings.pausedUntil) return { id: null };

    const ev = msg.event || {};
    // Defence in depth: the content script already stripped text for this
    // level, but never trust a message sender with a storage decision.
    if (settings.captureLevel === VG.CAPTURE_LEVELS.METADATA) ev.promptText = '';
    if (settings.captureLevel === VG.CAPTURE_LEVELS.FULL && !settings.allowFullText) {
      ev.promptText = '';
    }

    const id = await VG.db.add(ev);
    refreshBadge();
    return { id };
  },

  async PATCH_EVENT(msg) {
    if (!msg.id) return { ok: false };
    const ok = await VG.db.update(msg.id, msg.patch || {});
    return { ok };
  },

  async BUMP_EVENT(msg) {
    if (!msg.id || !msg.field) return { ok: false };
    const row = await VG.db.get(msg.id);
    if (!row) return { ok: false };
    const patch = {};
    patch[msg.field] = (row[msg.field] || 0) + (msg.by || 1);
    await VG.db.update(msg.id, patch);
    return { ok: true };
  },

  /* ------------------------- org attribution ------------------------- *
   * Zero manual entry. Agency comes from either a pushed policy value or,
   * where the optional identity permission is granted, from the DOMAIN of the
   * signed-in browser profile mapped through a pushed domain->agency table.
   * The email address itself is hashed for a stable pseudonymous device key
   * and then discarded; only the domain and the hash are ever kept.
   */
  async GET_ORG() {
    const settings = await VG.settings.get();
    const out = {
      agency: settings.orgAgency || '',
      division: settings.orgDivision || '',
      cohort: settings.orgCohort || '',
      source: settings.orgAgency ? 'policy' : 'none',
      userKey: '',
      domain: ''
    };

    if (!settings.deriveIdentity) return out;
    let has = false;
    try {
      has = await chrome.permissions.contains({ permissions: ['identity.email'] });
    } catch (e) { has = false; }
    if (!has || !chrome.identity || !chrome.identity.getProfileUserInfo) return out;

    const info = await new Promise((resolve) => {
      try { chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, resolve); }
      catch (e) { resolve(null); }
    });
    if (!info || !info.email) return out;

    const at = info.email.lastIndexOf('@');
    if (at === -1) return out;
    const domain = info.email.slice(at + 1).toLowerCase();
    out.domain = domain;
    // Stable pseudonymous key so fleet rollups can de-duplicate devices
    // without a login and without carrying an address around.
    out.userKey = await VG.hash('vantage-user|' + info.email.toLowerCase(), 16);

    const map = settings.agencyDomainMap || {};
    const hit = Object.keys(map).find((d) => domain === d || domain.endsWith('.' + d));
    if (hit && !out.agency) { out.agency = map[hit]; out.source = 'domain'; }
    return out;
  },

  async QUICK_STATS() {
    const settings = await VG.settings.get();
    const now = Date.now();
    const dayStart = VG.startOfDay(now);
    const weekStart = VG.startOfWeek(now, settings.weekStartsOn);
    const [today, week] = await Promise.all([
      VG.db.range(dayStart, now + 1),
      VG.db.range(weekStart, now + 1)
    ]);
    const byType = {};
    week.forEach((e) => { byType[e.workType] = (byType[e.workType] || 0) + 1; });
    const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
    return {
      today: today.length,
      week: week.length,
      topWorkType: top ? VG.taxonomyById(top[0]).label : null,
      redactedToday: today.reduce((s, e) => s + (e.redactionCount || 0), 0),
      settings
    };
  },

  /* ---------------- point-of-value micro-survey ---------------- *
   * Rate limiting lives here, not in the page, so a tab reload cannot be used
   * to re-roll the dice and nag someone.
   */
  async CAN_ASK_VALUE() {
    const settings = await VG.settings.get();
    if (!settings.valueSurveyEnabled) return { allowed: false };

    const store = await chrome.storage.local.get('valueAsk');
    const last = (store.valueAsk && store.valueAsk.ts) || 0;
    const cooldown = (Number(settings.valueSurveyCooldownMin) || 240) * 60000;
    if (Date.now() - last < cooldown) return { allowed: false };

    const pctChance = Number(settings.valueSurveySamplePercent);
    const rate = (isNaN(pctChance) ? 7 : Math.min(100, Math.max(1, pctChance))) / 100;
    if (!(Math.random() < rate)) return { allowed: false };

    await chrome.storage.local.set({ valueAsk: { ts: Date.now() } });
    return { allowed: true };
  },

  async VALUE_ANSWER(msg) {
    if (!msg.id) return { ok: false };
    const patch = {};
    if (typeof msg.savedMinutes === 'number') patch.savedMinutes = msg.savedMinutes;
    if (typeof msg.qualityRating === 'number') patch.qualityRating = msg.qualityRating;
    const ok = await VG.db.update(msg.id, patch);
    return { ok };
  },

  /* -------------------------- config health -------------------------- *
   * Records that a covered host loaded and whether the composer selector still
   * resolved. Surfaces selector drift before a month of data is lost.
   */
  async SITE_SEEN(msg) {
    const store = await chrome.storage.local.get('siteHealth');
    const health = store.siteHealth || {};
    const row = health[msg.site] || { seen: 0, composerFound: 0, composerMissing: 0 };
    row.seen++;
    row.lastSeen = Date.now();
    row.host = msg.host;
    row.revision = msg.revision;
    row.source = msg.source;
    if (msg.composerFound) { row.composerFound++; row.lastOk = Date.now(); }
    else { row.composerMissing++; row.lastMiss = Date.now(); }
    health[msg.site] = row;
    await chrome.storage.local.set({ siteHealth: health });
    return { ok: true };
  },

  async GET_HEALTH() {
    const settings = await VG.settings.get();
    const store = await chrome.storage.local.get('siteHealth');
    const health = store.siteHealth || {};
    const since = Date.now() - 14 * 86400000;
    const rows = await VG.db.range(since, Date.now() + 1);
    const captured = {};
    rows.forEach((e) => { captured[e.site] = (captured[e.site] || 0) + 1; });

    return {
      configRevision: VG.CONFIG_REVISION,
      siteConfigVersion: settings.siteConfigVersion || '',
      adapters: VG.adapterList(settings).map((a) => {
        const h = health[a.id] || {};
        const caps = captured[a.id] || 0;
        let status = 'unknown';
        if (h.seen) {
          if (caps > 0) status = 'ok';
          else if (h.composerMissing > 0 && !h.composerFound) status = 'broken';
          else status = 'idle';
        }
        return {
          id: a.id,
          label: a.label,
          hosts: a.hosts,
          source: a.source || 'builtin',
          revision: a.revision || 0,
          pageLoads: h.seen || 0,
          composerMissing: h.composerMissing || 0,
          lastSeen: h.lastSeen || null,
          captures14d: caps,
          status
        };
      })
    };
  },

  async UPLOAD_STATUS() {
    const settings = await VG.settings.get();
    const state = await uploadState();
    const permitted = settings.uploadUrl ? await endpointPermitted(settings.uploadUrl) : false;
    return {
      enabled: !!settings.uploadEnabled,
      description: VG.uploadDescription(settings),
      permitted,
      pending: settings.uploadEnabled ? VG.pendingPeriods(settings, state).map((p) => p.id) : [],
      lastUploadAt: state.lastUploadAt || null,
      lastStatus: state.lastStatus || null,
      failures: state.failures || 0,
      history: (state.history || []).slice(-5).reverse()
    };
  },

  async UPLOAD_NOW() {
    return runUpload('manual');
  },

  async PURGE_ALL() {
    await VG.db.clear();
    refreshBadge();
    return { ok: true };
  },

  async STRIP_TEXT() {
    const n = await VG.db.stripText();
    return { ok: true, n };
  },

  async ENFORCE_RETENTION() {
    await enforceRetention();
    refreshBadge();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg && msg.type];
  if (!fn) return false;
  Promise.resolve(fn(msg, sender))
    .then(sendResponse)
    .catch((err) => {
      console.error('[Vantage]', msg.type, err);
      sendResponse({ error: String(err && err.message ? err.message : err) });
    });
  return true; // async
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'managed' || (area === 'local' && changes.settings)) enforceRetention();
});
