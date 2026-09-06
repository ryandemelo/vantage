/*
 * Vantage, page context hook tests.
 *
 *   node tools/e2e-nethook.js
 *
 * net-hook.js patches fetch and XMLHttpRequest inside the site's own
 * JavaScript context. A mistake there does not degrade a metric, it breaks the
 * site for the person using it. These checks cover both halves of that: the
 * page must keep working exactly as before, and only the requests that should
 * cross may cross.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const HEADED = process.env.HEADED === '1';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'nethook.html'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  console.log('\nlaunching with the extension loaded');
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    executablePath: chromium.executablePath(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      ...(HEADED ? [] : ['--headless=new', '--disable-gpu']),
      '--no-sandbox',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ],
    timeout: 60000
  });

  const admin = await context.newPage();
  await admin.goto('chrome://extensions/');
  await admin.waitForTimeout(1200);
  const loaded = await admin.evaluate(() => {
    const m = document.querySelector('extensions-manager');
    const l = m && m.shadowRoot.querySelector('extensions-item-list');
    return l ? [...l.shadowRoot.querySelectorAll('extensions-item')].length : 0;
  });
  await admin.close();
  if (!loaded) {
    console.log('  extension was rejected, nothing below can pass');
    await context.close();
    process.exit(1);
  }

  // Serve the fixture at the real hostname so the content scripts attach, and
  // answer the API calls the fixture makes.
  await context.route('https://chatgpt.com/**', (route) => {
    const url = route.request().url();
    if (url.indexOf('/backend-api/') !== -1) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE });
  });
  await context.route('https://other.test.internal/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto('https://chatgpt.com/c/abc');
  await page.waitForSelector('html[data-vantage]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  const out = await page.evaluate(() => window.__run());
  const r = out.results;
  const fwd = out.forwarded;
  const bodies = fwd.map((f) => f.body || '').join('\n');

  console.log('\nthe page must keep working');
  check('fetch returns the real response', r.fetchStatus === 200 && r.fetchBody === true,
    JSON.stringify({ status: r.fetchStatus, body: r.fetchBody }));
  check('a Request object still works', r.requestObjectStatus === 200, String(r.requestObjectStatus));
  check('XMLHttpRequest still works', r.xhrStatus === 200, String(r.xhrStatus));
  check('a failing request still rejects', r.failuresStillReject === true, String(r.failuresStillReject));
  check('fetch still reports itself as native', r.fetchLooksNative === true, String(r.fetchLooksNative));
  check('fetch keeps its name', r.fetchName === 'fetch', String(r.fetchName));
  check('no page errors', pageErrors.length === 0, pageErrors[0]);

  console.log('\nonly what should cross, crosses');
  check('the prompt POST is forwarded', bodies.indexOf('hello there') !== -1, String(fwd.length) + ' forwarded');
  check('a Request object body is forwarded', bodies.indexOf('via request object') !== -1, '');
  check('an XHR body is forwarded', bodies.indexOf('sent by xhr') !== -1, '');

  check('cross origin never crosses', bodies.indexOf('secret') === -1, '');
  check('form data never crosses', bodies.indexOf('file contents that must not cross') === -1, '');
  check('a non JSON body never crosses', bodies.indexOf('plain text') === -1, '');
  check('an oversized body never crosses', bodies.indexOf('xxxxxxxxxx') === -1, '');
  check('a GET never crosses', fwd.every((f) => String(f.method).toUpperCase() === 'POST'),
    fwd.map((f) => f.method).join(','));
  check('every forwarded request is same origin',
    fwd.every((f) => {
      try { return new URL(f.url, 'https://chatgpt.com').origin === 'https://chatgpt.com'; }
      catch (e) { return false; }
    }), fwd.map((f) => f.url).join(' '));

  // Whatever was forwarded, the extension must only have stored the prompts.
  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 8000 });
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/ui/reports.html`);
  await ext.waitForTimeout(700);
  const stored = await ext.evaluate(async () => await window.VG.db.all());

  console.log('\nwhat reached storage');
  const storedText = JSON.stringify(stored);
  check('only prompts were stored', stored.length === 3, String(stored.length));
  check('nothing that was skipped reached storage',
    storedText.indexOf('secret') === -1 &&
    storedText.indexOf('file contents') === -1 &&
    storedText.indexOf('plain text') === -1, '');
  check('stored rows record the network path',
    stored.length > 0 && stored.every((e) => e.captureSource === 'network'),
    stored.map((e) => e.captureSource).join(','));

  await context.close();
  console.log(failures ? `\n${failures} failure(s)\n` : '\nall page context checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err && err.message ? err.message : err);
  process.exit(2);
});
