/* Vantage, options.js */
(function () {
  'use strict';
  const VG = self.VG;
  const $ = (id) => document.getElementById(id);
  let settings = null;

  function send(msg) {
    return new Promise((r) => chrome.runtime.sendMessage(msg, r));
  }

  async function save(patch) {
    const res = await send({ type: 'SET_SETTINGS', patch });
    settings = res.settings;
    return settings;
  }

  const locked = (key) => (settings.__locked || []).includes(key);

  function lockPill() {
    const s = document.createElement('span');
    s.className = 'pill locked';
    s.textContent = 'set by policy';
    return s;
  }

  function applyLocks() {
    const map = {
      captureLevel: '#levels input',
      domScope: '#scopes input',
      retentionDays: '#retention',
      weekStartsOn: '#weekStart',
      enabled: '#enabled',
      showCaptureToast: '#toast',
      sensitiveWordlist: '#wordlist',
      customRedactors: '#customRedactors',
      extraTaxonomyTerms: '#extraTerms',
      reportEmailTo: '#emailTo',
      disabledSites: '#sites input',
      customAdapters: '#addSite',
      valueSurveyEnabled: '#valueSurvey',
      valueSurveySamplePercent: '#valueRate',
      valueSurveyCooldownMin: '#valueCooldown'
    };
    Object.entries(map).forEach(([key, sel]) => {
      if (!locked(key)) return;
      document.querySelectorAll(sel).forEach((el) => { el.disabled = true; });
    });
    if ((settings.__locked || []).length) {
      $('policyNote').textContent =
        'All data stays on this device. Some settings are managed by your organisation and cannot be changed here.';
    }
  }

  /* --------------------------- capture --------------------------- */

  const LEVELS = [
    {
      id: VG.CAPTURE_LEVELS.METADATA,
      title: 'Metadata only',
      sub: 'Counts, timings and work category. No prompt text is stored at all. Lowest risk; the report can still show everything except example prompts.'
    },
    {
      id: VG.CAPTURE_LEVELS.REDACTED,
      title: 'Redacted prompt text (recommended)',
      sub: 'Prompt text is stored after identifiers and secrets are replaced with placeholders. Lets you sanity-check how prompts were categorised.'
    },
    {
      id: VG.CAPTURE_LEVELS.FULL,
      title: 'Full prompt text',
      sub: 'Stores exactly what you typed. Only available when explicitly unlocked; not appropriate for regulated or classified work.'
    }
  ];

  function renderLevels() {
    const wrap = $('levels');
    wrap.textContent = '';
    LEVELS.forEach((lv) => {
      const disabled = lv.id === VG.CAPTURE_LEVELS.FULL && !settings.allowFullText;
      const label = document.createElement('label');
      label.className = 'opt' + (settings.captureLevel === lv.id ? ' sel' : '');
      label.innerHTML =
        `<input type="radio" name="lvl" value="${lv.id}" ${settings.captureLevel === lv.id ? 'checked' : ''} ${disabled ? 'disabled' : ''}>` +
        `<span><span class="t">${lv.title}</span>` +
        `<span class="s">${lv.sub}${disabled ? ' <em>Locked. Enable “allow full text” via policy to use this.</em>' : ''}</span></span>`;
      label.querySelector('input').addEventListener('change', async () => {
        await save({ captureLevel: lv.id });
        renderLevels();
        applyLocks();
        refreshStats();
      });
      wrap.appendChild(label);
    });
  }

  const SCOPES = [
    {
      id: 'minimal',
      title: 'Composer only (recommended)',
      sub: 'Reads the box you type in, and nothing else. Response timing comes from the fact that the page is changing, not from the reply itself. Copy-out is counted from the copy event alone. Account type comes from the plan badge, never from your address.'
    },
    {
      id: 'standard',
      title: 'Also read replies, selections and the account address',
      sub: 'Adds response length and code detection, copied character counts, and corporate-vs-personal detection from the account menu domain. The reply is pulled into memory to be measured. Only turn this on if you need those three numbers.'
    }
  ];

  function renderScopes() {
    const wrap = $('scopes');
    wrap.textContent = '';
    SCOPES.forEach((sc) => {
      const label = document.createElement('label');
      label.className = 'opt' + ((settings.domScope || 'minimal') === sc.id ? ' sel' : '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'scope';
      input.checked = (settings.domScope || 'minimal') === sc.id;
      const span = document.createElement('span');
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = sc.title;
      const sub = document.createElement('span');
      sub.className = 's';
      sub.textContent = sc.sub;
      span.append(t, sub);
      label.append(input, span);
      input.addEventListener('change', async () => {
        await save({ domScope: sc.id });
        renderScopes();
        applyLocks();
      });
      wrap.appendChild(label);
    });
  }

  /* ---------------------------- sites ---------------------------- */

  const SOURCE_LABEL = { policy: 'pushed by your organisation', custom: 'added by you', builtin: 'shipped with the extension' };
  const STATUS_LABEL = {
    ok: ['capturing', 'var(--good)'],
    idle: ['visited, nothing captured yet', 'var(--muted)'],
    broken: ['composer not found, selector may be stale', 'var(--bad)'],
    unknown: ['not visited yet', 'var(--faint)']
  };

  let healthById = {};

  function renderSites() {
    const wrap = $('sites');
    wrap.textContent = '';

    VG.adapterList(settings).forEach((a) => {
      const on = !(settings.disabledSites || []).includes(a.id);
      const h = healthById[a.id] || {};
      // Built from nodes rather than innerHTML: labels and hostnames can come
      // from admin policy or user input and must never be parsed as markup.
      const row = document.createElement('div');
      row.className = 'sitecard';

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = /^#[0-9a-f]{3,8}$/i.test(a.colour || '') ? a.colour : '#64748b';

      const info = document.createElement('div');
      info.className = 'grow';

      const nameRow = document.createElement('div');
      nameRow.style.display = 'flex';
      nameRow.style.alignItems = 'center';
      nameRow.style.gap = '7px';
      const nameEl = document.createElement('div');
      nameEl.style.fontWeight = '560';
      nameEl.textContent = a.label;
      nameRow.appendChild(nameEl);
      if (a.source === 'policy') {
        const pill = document.createElement('span');
        pill.className = 'pill locked';
        pill.textContent = 'policy';
        nameRow.appendChild(pill);
      }

      const hostEl = document.createElement('div');
      hostEl.className = 'faint';
      hostEl.textContent = a.hosts.join(', ') + ' · ' + (SOURCE_LABEL[a.source] || a.source) +
        (a.revision ? ' · rev ' + a.revision : '');

      const statusEl = document.createElement('div');
      statusEl.style.fontSize = '12px';
      statusEl.style.marginTop = '2px';
      const st = STATUS_LABEL[h.status || 'unknown'];
      statusEl.style.color = st[1];
      statusEl.textContent = st[0] +
        (h.pageLoads ? ` · ${h.pageLoads} page load${h.pageLoads === 1 ? '' : 's'}, ${h.captures14d} captured in 14d` : '');

      info.append(nameRow, hostEl, statusEl);

      const toggle = document.createElement('label');
      toggle.className = 'chk';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = on;
      box.disabled = a.source === 'policy' && locked('disabledSites');
      toggle.append(box, document.createTextNode(' on'));

      row.append(dot, info, toggle);
      box.addEventListener('change', async (e) => {
        const list = new Set(settings.disabledSites || []);
        if (e.target.checked) list.delete(a.id); else list.add(a.id);
        await save({ disabledSites: Array.from(list) });
      });

      if (a.source === 'custom') {
        const del = document.createElement('button');
        del.className = 'sm danger';
        del.textContent = 'Remove';
        del.addEventListener('click', async () => {
          const next = (settings.customAdapters || []).filter((c) => c.id !== a.rawId);
          await save({ customAdapters: next });
          try { await chrome.scripting.unregisterContentScripts({ ids: ['vantage-' + a.rawId] }); } catch (e) { /* not registered */ }
          renderSites();
        });
        row.appendChild(del);
      }
      wrap.appendChild(row);
    });
  }

  /*
   * Transparency panel. If reports leave the device, the person they are about
   * must be able to see that, where they go, how often and what they contain ,
   * without digging. Shown whenever upload is enabled and never hideable.
   */
  async function loadUpload() {
    const st = await send({ type: 'UPLOAD_STATUS' });
    if (!st || !st.enabled || !st.description) {
      $('uploadSection').style.display = 'none';
      return;
    }
    $('uploadSection').style.display = '';

    const d = st.description;
    const box = $('uploadBox');
    box.textContent = '';

    const lead = document.createElement('p');
    lead.style.margin = '2px 0 10px';
    lead.textContent =
      `Your organisation has configured this extension to send reports to ${d.host}, ${d.when}. ` +
      `Each upload contains ${d.what}.`;
    box.appendChild(lead);

    if (st.description.what.indexOf('INCLUDING') !== -1) {
      const warn = document.createElement('p');
      warn.style.color = 'var(--warn)';
      warn.style.margin = '0 0 10px';
      warn.textContent = 'Prompt text is included in these uploads. It is redacted first, but it does leave this device.';
      box.appendChild(warn);
    }

    const rows = [
      ['Destination', d.host],
      ['Frequency', d.when],
      ['Contents', d.what],
      ['Endpoint permitted', st.permitted ? 'yes' : 'NO, nothing can be sent until this is granted'],
      ['Waiting to send', st.pending.length ? st.pending.join(', ') : 'nothing outstanding'],
      ['Last sent', st.lastUploadAt ? new Date(st.lastUploadAt).toLocaleString() : 'never'],
      ['Last result', st.lastStatus || 'nothing yet']
    ];
    const table = document.createElement('table');
    const tb = document.createElement('tbody');
    rows.forEach(([k, v]) => {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = k;
      th.style.color = 'var(--muted)';
      th.style.width = '190px';
      const td = document.createElement('td');
      td.textContent = v;
      if (k === 'Endpoint permitted' && !st.permitted) td.style.color = 'var(--bad)';
      tr.append(th, td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);

    $('grantEndpoint').style.display = st.permitted ? 'none' : '';

    const hist = $('uploadHistory');
    hist.textContent = st.history.length
      ? st.history.map((h) =>
          new Date(h.at).toLocaleString() + '  ' + (h.ok ? 'sent ' + h.period : 'FAILED ' + (h.error || ''))
        ).join('\n')
      : '';
  }

  async function loadOrg() {
    const org = await send({ type: 'GET_ORG' });
    if (!org) return;
    const bits = [];
    if (org.agency) bits.push('Agency: ' + org.agency + ' (' + org.source + ')');
    else bits.push('Agency: not set');
    if (org.division) bits.push('Division: ' + org.division);
    if (org.cohort) bits.push('Cohort: ' + org.cohort);
    if (org.domain) bits.push('Profile domain: ' + org.domain);
    if (org.userKey) bits.push('Device key: ' + org.userKey);
    $('orgBox').textContent = bits.join(' · ');
    $('grantIdentity').style.display = settings.deriveIdentity && !org.userKey ? '' : 'none';
  }

  async function loadHealth() {
    const h = await send({ type: 'GET_HEALTH' });
    if (!h) return;
    healthById = {};
    (h.adapters || []).forEach((a) => { healthById[a.id] = a; });
    $('cfgRev').textContent = 'built-in config rev ' + h.configRevision;
    $('cfgVer').textContent = h.siteConfigVersion
      ? 'pushed config: ' + h.siteConfigVersion
      : 'no pushed config';
  }

  async function addCustomSite() {
    const name = $('cName').value.trim();
    const host = $('cHost').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!name || !host) { alert('Name and hostname are both required.'); return; }

    const granted = await chrome.permissions.request({
      origins: [`https://${host}/*`, `https://*.${host}/*`],
      permissions: ['scripting']
    }).catch(() => false);
    if (!granted) { alert('Permission for that host was not granted, so the site cannot be tracked.'); return; }

    const id = host.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const entry = { id, label: name, hosts: [host], selectors: {} };
    if ($('cComposer').value.trim()) entry.selectors.composer = [$('cComposer').value.trim()];
    if ($('cSend').value.trim()) entry.selectors.send = [$('cSend').value.trim()];

    const next = (settings.customAdapters || []).filter((c) => c.id !== id).concat([entry]);
    await save({ customAdapters: next });

    try {
      await chrome.scripting.registerContentScripts([{
        id: 'vantage-' + id,
        matches: [`https://${host}/*`, `https://*.${host}/*`],
        js: [
          'src/core/schema.js', 'src/core/redact.js', 'src/core/classify.js',
          'src/core/adapters.js', 'src/core/surfaces.js', 'src/content/capture.js'
        ],
        runAt: 'document_idle'
      }]);
    } catch (e) {
      /* already registered, fine */
    }

    ['cName', 'cHost', 'cComposer', 'cSend'].forEach((k) => { $(k).value = ''; });
    renderSites();
  }

  /* -------------------------- redaction -------------------------- */

  function renderRedactors() {
    const wrap = $('redactors');
    wrap.textContent = '';
    VG.REDACTORS.forEach((r) => {
      const optIn = r.default === false;
      const on = optIn
        ? (settings.redactorsOn || []).includes(r.id)
        : !(settings.redactorsOff || []).includes(r.id);
      const lab = document.createElement('label');
      lab.className = 'chk';
      lab.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>` +
        `<span>${r.label}${optIn ? ' <span class="faint">(opt-in)</span>' : ''}</span>`;
      lab.querySelector('input').addEventListener('change', async (e) => {
        if (optIn) {
          const set = new Set(settings.redactorsOn || []);
          e.target.checked ? set.add(r.id) : set.delete(r.id);
          await save({ redactorsOn: Array.from(set) });
        } else {
          const set = new Set(settings.redactorsOff || []);
          e.target.checked ? set.delete(r.id) : set.add(r.id);
          await save({ redactorsOff: Array.from(set) });
        }
      });
      wrap.appendChild(lab);
    });
  }

  function renderTaxonomy() {
    const wrap = $('taxonomy');
    wrap.textContent = '';
    VG.TAXONOMY.filter((c) => c.id !== 'other').forEach((c) => {
      const d = document.createElement('div');
      d.className = 'chk';
      d.innerHTML = `<span class="dot" style="width:9px;height:9px;border-radius:2px;background:${c.colour};display:inline-block"></span>` +
        `<span>${c.label} <span class="faint">${c.id}</span></span>`;
      wrap.appendChild(d);
    });
  }

  /* --------------------------- json fields --------------------------- */

  function bindJson(id, key, isArray) {
    const el = $(id);
    el.value = JSON.stringify(settings[key] || (isArray ? [] : {}), null, 2);
    el.addEventListener('blur', async () => {
      const raw = el.value.trim();
      if (!raw) { await save({ [key]: isArray ? [] : {} }); return; }
      try {
        const parsed = JSON.parse(raw);
        await save({ [key]: parsed });
        el.style.borderColor = '';
      } catch (e) {
        el.style.borderColor = 'var(--bad)';
      }
    });
  }

  /* ----------------------------- data ----------------------------- */

  async function refreshStats() {
    const count = await VG.db.count();
    const first = await VG.db.first();
    const withText = settings.captureLevel !== VG.CAPTURE_LEVELS.METADATA;
    $('dataStats').textContent =
      `${count} event${count === 1 ? '' : 's'} stored` +
      (first ? `, oldest ${VG.fmtDate(first.ts)}` : '') +
      `. Prompt text: ${withText ? (settings.captureLevel === 'full' ? 'stored in full' : 'stored redacted') : 'not stored'}.`;
  }

  /* ----------------------------- init ----------------------------- */

  async function init() {
    const res = await send({ type: 'GET_SETTINGS' });
    settings = res.settings;

    if (location.hash === '#welcome') $('welcome').style.display = '';

    renderLevels();
    renderScopes();
    await loadHealth();
    await loadOrg();
    await loadUpload();
    renderSites();
    renderRedactors();
    renderTaxonomy();

    $('retention').value = settings.retentionDays;
    $('retention').addEventListener('change', (e) =>
      save({ retentionDays: Math.max(1, Number(e.target.value) || 180) }).then(refreshStats));

    $('weekStart').value = String(settings.weekStartsOn);
    $('weekStart').addEventListener('change', (e) => save({ weekStartsOn: Number(e.target.value) }));

    $('toast').checked = !!settings.showCaptureToast;
    $('toast').addEventListener('change', (e) => save({ showCaptureToast: e.target.checked }));

    $('enabled').checked = !!settings.enabled;
    $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));

    $('valueSurvey').checked = !!settings.valueSurveyEnabled;
    $('valueSurvey').addEventListener('change', (e) => save({ valueSurveyEnabled: e.target.checked }));
    $('valueRate').value = settings.valueSurveySamplePercent || 7;
    $('valueRate').addEventListener('change', (e) =>
      save({ valueSurveySamplePercent: Math.min(100, Math.max(1, Number(e.target.value) || 7)) }));
    $('valueCooldown').value = settings.valueSurveyCooldownMin || 240;
    $('valueCooldown').addEventListener('change', (e) =>
      save({ valueSurveyCooldownMin: Math.max(15, Number(e.target.value) || 240) }));

    $('emailTo').value = settings.reportEmailTo || '';
    $('emailTo').addEventListener('change', (e) => save({ reportEmailTo: e.target.value.trim() }));

    $('wordlist').value = (settings.sensitiveWordlist || []).join('\n');
    $('wordlist').addEventListener('blur', (e) =>
      save({ sensitiveWordlist: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }));

    bindJson('customRedactors', 'customRedactors', true);
    bindJson('extraTerms', 'extraTaxonomyTerms', false);

    $('grantIdentity').addEventListener('click', async () => {
      const ok = await chrome.permissions.request({ permissions: ['identity.email'] }).catch(() => false);
      if (!ok) { alert('Permission not granted, so the agency cannot be derived automatically.'); return; }
      await loadOrg();
    });

    // --- report integrity ---
    const keyPill = () => {
      const k = settings.reportSigningKey || '';
      $('keyState').textContent = k
        ? (locked('reportSigningKey') ? 'key: pushed by policy' : 'key: local to this device')
        : 'key: none, reports will not be marked';
    };
    keyPill();

    $('copyKey').addEventListener('click', async () => {
      if (!settings.reportSigningKey) { alert('No signing key set.'); return; }
      await navigator.clipboard.writeText(settings.reportSigningKey);
      alert('Signing key copied. Anyone holding this key can verify, and can also produce, a report that passes.');
    });

    $('rotateKey').addEventListener('click', async () => {
      if (locked('reportSigningKey')) { alert('The key is set by policy and cannot be changed here.'); return; }
      if (!confirm('Generate a new key? Reports already exported will no longer verify against this device.')) return;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
      await save({ reportSigningKey: hex });
      keyPill();
    });

    $('verifyBtn').addEventListener('click', async () => {
      const text = $('verifyIn').value;
      const out = $('verifyOut');
      if (!text.trim()) { out.textContent = 'Paste a report first.'; return; }
      const res = await VG.verifyReportText(text, settings.reportSigningKey);
      const colour = res.verdict === 'altered' ? 'var(--bad)'
        : res.verdict === 'intact' ? 'var(--good)'
        : res.verdict === 'intact-partial' ? 'var(--warn)' : 'var(--muted)';
      out.innerHTML = '';
      const head = document.createElement('div');
      head.style.color = colour;
      head.style.fontWeight = '600';
      head.textContent = res.verdict.toUpperCase().replace('-', ' ');
      const body = document.createElement('div');
      body.style.marginTop = '4px';
      body.textContent = res.explanation;
      const detail = document.createElement('div');
      detail.style.marginTop = '6px';
      detail.className = 'mono';
      detail.textContent =
        'reference code: ' + res.ref +
        ' · watermark: ' + res.watermark +
        ' · phrasing: ' + res.phrasing +
        ' (' + res.phrasingDetail.matched + '/' + res.phrasingDetail.checked + ')' +
        ' · figures read: ' + res.figuresFound;
      out.append(head, body, detail);
    });

    $('uploadNow').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await send({ type: 'UPLOAD_NOW' });
      e.target.disabled = false;
      alert(r && r.sent ? `Sent ${r.sent} (${r.prompts} prompts).`
        : r && r.error ? 'Failed: ' + r.error
        : 'Nothing to send: ' + ((r && r.skipped) || 'unknown'));
      loadUpload();
    });

    $('grantEndpoint').addEventListener('click', async () => {
      const st = await send({ type: 'UPLOAD_STATUS' });
      if (!st || !st.description) return;
      const ok = await chrome.permissions.request({
        origins: ['https://' + st.description.host + '/*']
      }).catch(() => false);
      if (!ok) alert('Permission not granted, nothing will be sent.');
      loadUpload();
    });

    $('addSite').addEventListener('click', addCustomSite);
    $('openReports').addEventListener('click', () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/reports.html') }));

    $('exportAll').addEventListener('click', async () => {
      const rows = await VG.db.all();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings, events: rows }, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vantage-export-${VG.localDay(Date.now())}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });

    $('stripText').addEventListener('click', async () => {
      if (!confirm('Delete the stored text of every captured prompt? Counts and categories are kept.')) return;
      const r = await send({ type: 'STRIP_TEXT' });
      alert(`Removed prompt text from ${r.n} event(s).`);
      refreshStats();
    });

    $('purgeNow').addEventListener('click', async () => {
      await send({ type: 'ENFORCE_RETENTION' });
      refreshStats();
    });

    $('loadDemo').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const rows = VG.generateDemo(5, settings);
      await VG.db.clearDemo();
      const n = await VG.db.addMany(rows);
      e.target.disabled = false;
      await refreshStats();
      if (confirm(`Added ${n} sample events. Open the reports page?`)) {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/reports.html') });
      }
    });

    $('clearDemo').addEventListener('click', async () => {
      const n = await VG.db.clearDemo();
      alert(`Removed ${n} sample event(s). Your own data is untouched.`);
      refreshStats();
    });

    $('wipe').addEventListener('click', async () => {
      if (!confirm('Delete all captured data permanently? This cannot be undone.')) return;
      await send({ type: 'PURGE_ALL' });
      refreshStats();
    });

    applyLocks();
    refreshStats();
  }

  init();
})();
