/* Vantage, popup.js */
(function () {
  'use strict';
  const VG = self.VG;
  const $ = (id) => document.getElementById(id);

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function setStatus(settings) {
    const dot = $('dot');
    const paused = settings.pausedUntil && Date.now() < settings.pausedUntil;
    dot.className = 'dot' + (!settings.enabled ? ' off' : paused ? ' paused' : '');
    $('pause').textContent = paused ? 'Resume' : 'Pause';
    $('pause').dataset.paused = paused ? '1' : '';
  }

  async function currentSite(settings) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return 'not tracked';
    let host;
    try { host = new URL(tab.url).hostname; } catch (e) { return 'not tracked'; }
    const a = VG.resolveAdapter(host, settings);
    return a ? a.label + ' · tracked' : 'not tracked';
  }

  async function load() {
    const stats = await send({ type: 'QUICK_STATS' });
    if (!stats) return;
    $('today').textContent = stats.today;
    $('week').textContent = stats.week;
    $('topType').textContent = stats.topWorkType || 'No activity yet';
    $('redacted').textContent = stats.redactedToday
      ? `${stats.redactedToday} item${stats.redactedToday === 1 ? '' : 's'} redacted today`
      : '';
    setStatus(stats.settings);
    $('site').textContent = await currentSite(stats.settings);
  }

  $('openReports').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/reports.html') });
    window.close();
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('pause').addEventListener('click', async () => {
    const paused = $('pause').dataset.paused === '1';
    await send({ type: 'SET_SETTINGS', patch: { pausedUntil: paused ? 0 : Date.now() + 3600000 } });
    load();
  });

  $('probe').addEventListener('click', async () => {
    const out = $('probeOut');
    out.style.display = '';
    out.textContent = 'Checking…';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { out.textContent = 'No active tab.'; return; }

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'PROBE' });
    } catch (e) {
      out.textContent = 'No Vantage content script on this page.\n\n' +
        'Either the site is not covered, or the page was open before the extension ' +
        'loaded, reload the tab and try again.';
      return;
    }
    if (!res) { out.textContent = 'No response from the page. Reload the tab and retry.'; return; }
    if (!res.covered) { out.textContent = 'No adapter covers ' + res.host + '.'; return; }

    const L = [];
    L.push(res.label + '  (' + res.site + ' rev ' + res.revision + ', ' + res.source + ')');
    L.push(res.host);
    L.push('');
    res.rows.forEach((r) => {
      const status = !r.matched ? 'MISSING ' : r.index === 0 ? 'OK      ' : 'FALLBACK';
      L.push(status + ' ' + r.group.padEnd(14) + (r.matched ? 'x' + r.count : 'none'));
    });
    L.push('');
    L.push('surface  : ' + res.surfaceLabel + (res.surfaceFlags.length ? ' + ' + res.surfaceFlags.join(', ') : ''));
    L.push('agent    : ' + (res.agentDetected ? (res.agentNamed ? 'detected, named' : 'detected, unnamed') : 'none'));
    L.push('shared   : ' + (res.shared ? 'yes' : 'no'));
    L.push('account  : ' + res.accountTier);
    L.push('');
    L.push('VERDICT: ' + res.verdict.toUpperCase() +
      (res.broken.length ? ', ' + res.broken.join(', ') + ' did not resolve' : '') +
      (!res.broken.length && res.degraded.length ? ', ' + res.degraded.join(', ') : ''));

    out.textContent = L.join('\n');
    try { await navigator.clipboard.writeText(L.join('\n')); out.textContent += '\n\n(copied to clipboard)'; }
    catch (e) { /* clipboard may be unavailable in the popup */ }
  });

  load();
})();
