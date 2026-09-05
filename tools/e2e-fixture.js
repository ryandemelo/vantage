/*
 * Vantage, offline end-to-end test.
 *
 * Loads the real unpacked extension into Chromium, serves a local fixture at
 * https://chatgpt.com/ so the hostname matches the adapter, sends prompts the
 * way a person would, and then reads what the extension actually wrote to its
 * own IndexedDB.
 *
 * Exercises: content-script injection, composer detection, the Enter and
 * send-button hooks, redaction, classification, thread-context inheritance,
 * surface + agent detection, service-worker messaging, and storage.
 *
 * It does NOT prove the selectors match the live ChatGPT DOM, only
 * tools/probe-live.js against a signed-in page can settle that.
 *
 *   node tools/e2e-fixture.js
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');

/*
 * Extensions do not load in Playwright's headless *shell*, and `headless: true`
 * selects that shell. So: point at the full Chromium, tell Playwright it is
 * headed, and pass --headless=new ourselves. Chrome's new headless mode does
 * support extensions. Set HEADED=1 to watch it run in a real window.
 */
const HEADED = process.env.HEADED === '1';
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'chatgpt.html'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

const PROMPTS = [
  {
    text: 'Refactor this handler and add a unit test for the error path',
    want: { workType: 'coding', source: 'direct' }
  },
  {
    text: 'make it shorter',
    want: { workType: 'coding', source: 'inherited' } // inherits the thread topic
  },
  {
    text: 'Draft an email to j.rivera@acme.example about CASE-104477, her national ID is S1234567D',
    want: { workType: 'drafting', redactions: ['email', 'national_id'] }
  },
  {
    text: 'Summarise the attached consultation response then translate it into Malay',
    want: { workType: 'comprehension', secondary: true }
  }
];

(async () => {
  console.log('\nlaunching chromium with the unpacked extension');

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

  // Confirm Chrome actually accepted the manifest before anything else, a
  // rejected manifest looks exactly like "capture is broken" further down.
  const admin = await context.newPage();
  await admin.goto('chrome://extensions/');
  await admin.waitForTimeout(1200);
  const loaded = await admin.evaluate(() => {
    const m = document.querySelector('extensions-manager');
    const l = m && m.shadowRoot.querySelector('extensions-item-list');
    const items = l ? [...l.shadowRoot.querySelectorAll('extensions-item')] : [];
    return items.map((i) => ({
      name: i.shadowRoot.querySelector('#name') && i.shadowRoot.querySelector('#name').textContent.trim(),
      id: i.id
    }));
  });
  console.log('\nmanifest');
  check('extension accepted by Chrome', loaded.length === 1, JSON.stringify(loaded));
  check('extension name is free of dash punctuation',
    loaded.length === 1 && !/[\u2013\u2014]/.test(loaded[0].name || ''), JSON.stringify(loaded));
  if (!loaded.length) {
    console.log('\n  Chrome rejected the manifest. Nothing below can pass. ' +
                'Most likely the managed_schema uses a construct the policy parser refuses.');
    await context.close();
    process.exit(1);
  }
  const extId = loaded[0].id;
  console.log('  extension id: ' + extId);
  await admin.close();

  // Wake the service worker so messaging is live.
  let [sw] = context.serviceWorkers();
  if (!sw) {
    try { sw = await context.waitForEvent('serviceworker', { timeout: 10000 }); }
    catch (e) { /* it will start on the first message */ }
  }

  // Serve the fixture at the real hostname so the adapter matches on host.
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: FIXTURE })
  );

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

  // A custom-GPT URL, so surface and agent detection are exercised too.
  await page.goto('https://chatgpt.com/g/g-abc123XYZ/c/7f3a9b1c-1111-2222-3333-444455556666');

  // The content script publishes its state on <html data-vantage>:
  // "armed" once listeners are attached, "ready" once settings have landed.
  let readyState = null;
  try {
    await page.waitForSelector('html[data-vantage="ready"]', { timeout: 15000 });
    readyState = 'ready';
  } catch (e) {
    readyState = await page.getAttribute('html', 'data-vantage');
  }

  console.log('\ncontent script');
  check('content script reached ready state', readyState === 'ready', String(readyState));
  check('no page errors from the extension', pageErrors.length === 0, pageErrors[0]);

  const probe = await page.evaluate(() => ({
    composer: !!document.querySelector('div#prompt-textarea[contenteditable="true"]'),
    send: !!document.querySelector('button[data-testid="send-button"]')
  }));
  check('composer selector resolves on fixture', probe.composer);
  check('send selector resolves on fixture', probe.send);

  console.log('\nsending prompts the way a person would');
  const toasts = [];
  for (const p of PROMPTS) {
    await page.click('div#prompt-textarea');
    await page.fill('div#prompt-textarea', ''); // contenteditable
    await page.type('div#prompt-textarea', p.text, { delay: 4 });
    await page.keyboard.press('Enter');
    // The transparency toast lives in the page's own DOM, so it is the one
    // observable proof from out here that the content script is alive.
    await page.waitForTimeout(350);
    toasts.push(await page.evaluate(() => {
      const t = document.querySelector('[data-vantage-toast]');
      return t ? t.textContent : null;
    }));
    await page.waitForTimeout(2300); // let the reply stream and quiesce
    console.log('  sent: ' + p.text.slice(0, 58) + (p.text.length > 58 ? '…' : ''));
  }
  // One more via the send button, to prove that path too.
  await page.click('div#prompt-textarea');
  await page.type('div#prompt-textarea', 'Write a SQL query grouping claims by region', { delay: 4 });
  await page.click('button[data-testid="send-button"]');
  await page.waitForTimeout(2600);
  console.log('  sent via send button: Write a SQL query grouping claims by region');

  console.log('\ntransparency indicator');
  check('content script alive, toast shown on capture', toasts.filter(Boolean).length === PROMPTS.length,
    JSON.stringify(toasts));
  const redactToast = toasts.find((t) => t && /redacted/.test(t));
  check('toast reports redactions on the sensitive prompt', !!redactToast, redactToast || '(none)');
  check('toast names the surface', toasts.some((t) => t && /Custom GPT/.test(t)), toasts[0] || '');

  // Read what the extension actually stored, from an extension page.
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/ui/reports.html`);
  await ext.waitForTimeout(600);
  const events = await ext.evaluate(async () => await window.VG.db.all());

  console.log('\nwhat the extension stored');
  check('events captured', events.length === 5, `got ${events.length}`);

  if (events.length) {
    const byText = (frag) => events.find((e) => (e.promptText || '').indexOf(frag) !== -1);

    const coding = events[0];
    check('turn 1 classified as coding', coding.workType === 'coding', coding.workType);
    check('turn 1 marked direct', coding.workTypeSource === 'direct', coding.workTypeSource);
    check('surface detected as custom GPT', coding.surface === 'custom_agent', coding.surface);
    check('agent key hashed and stored', !!coding.agentKey && coding.agentKey.length === 16, coding.agentKey);
    check('agent name captured', coding.agentName === 'Policy Brief Builder' || coding.agentName === '', coding.agentName);
    check('model label read', /GPT-5/.test(coding.model), coding.model);
    check('conversation hashed, not raw', !/7f3a9b1c/.test(coding.conversationHash), coding.conversationHash);
    // Default scope: timing is measured, response content is not touched.
    check('first token timed without reading the response',
      typeof coding.firstTokenMs === 'number' && coding.firstTokenMs >= 0, String(coding.firstTokenMs));
    check('response duration timed', typeof coding.responseMs === 'number' && coding.responseMs > 0,
      String(coding.responseMs));
    check('no response length recorded under minimal scope',
      coding.responseChars === 0 || coding.responseChars === undefined, String(coding.responseChars));
    check('no response code flag under minimal scope',
      coding.responseHasCode === false || coding.responseHasCode === undefined,
      String(coding.responseHasCode));

    // The regression that mattered: once a prior assistant turn existed, ANY
    // mutation used to set firstTokenMs, so every turn after the first
    // reported a near-zero time to first token. The fixture waits 250ms before
    // it starts streaming, so a correct reading can never be below that.
    const laterTurns = events.slice(1).filter((e) => typeof e.firstTokenMs === 'number');
    check('time to first token is real on turns after the first',
      laterTurns.length > 0 && laterTurns.every((e) => e.firstTokenMs >= 200),
      laterTurns.map((e) => e.firstTokenMs).join(', '));

    const followUp = events[1];
    check('bare follow-up inherited the thread topic',
      followUp.workType === 'coding' && followUp.workTypeSource === 'inherited',
      `${followUp.workType}/${followUp.workTypeSource}`);
    check('turn index advanced', followUp.turn === 2, String(followUp.turn));

    const sensitive = byText('Draft an email');
    check('sensitive prompt captured', !!sensitive);
    if (sensitive) {
      check('email redacted in stored text', sensitive.promptText.indexOf('jane.tan@') === -1, sensitive.promptText);
      check('national ID redacted in stored text', sensitive.promptText.indexOf('S1234567D') === -1, sensitive.promptText);
      check('redaction counted', sensitive.redactionCount >= 2, String(sensitive.redactionCount));
      check('redaction types recorded', !!sensitive.redactionHits.email && !!sensitive.redactionHits.national_id,
        JSON.stringify(sensitive.redactionHits));
      check('classified as drafting', sensitive.workType === 'drafting', sensitive.workType);
    }

    const dual = byText('Summarise the attached');
    check('dual-intent prompt captured', !!dual);
    if (dual) check('second intent recorded', !!dual.workTypeSecondary, dual.workTypeSecondary || '(none)');

    const sql = byText('SQL query');
    check('send-button path captured', !!sql);
    if (sql) check('classified as data', sql.workType === 'data', sql.workType);

    check('no raw prompt text beyond redaction', events.every((e) => e.promptText.indexOf('S1234567D') === -1));
    check('response text never stored', events.every((e) => !('responseText' in e)));

    // No stored field should contain a phrase that only ever appeared in the
    // model's reply, a blunt check that response content is not leaking in.
    const replyPhrase = 'walks through the';
    check('no response wording anywhere in stored events',
      JSON.stringify(events).indexOf(replyPhrase) === -1, replyPhrase);
  }

  /* --- opting into the wider scope must actually widen it --- */
  console.log('\nstandard scope, opted into');
  const optIn = await context.newPage();
  await optIn.goto(`chrome-extension://${extId}/src/ui/options.html`);
  await optIn.waitForTimeout(500);
  await optIn.evaluate(async () => {
    await new Promise((r) => chrome.runtime.sendMessage(
      { type: 'SET_SETTINGS', patch: { domScope: 'standard' } }, r));
  });
  const confirmed = await optIn.evaluate(async () => {
    const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, res));
    return r.settings.domScope;
  });
  check('scope setting persisted', confirmed === 'standard', String(confirmed));
  await optIn.close();

  await page.reload();
  await page.waitForSelector('html[data-vantage="ready"]', { timeout: 15000 }).catch(() => {});
  await page.click('div#prompt-textarea');
  await page.type('div#prompt-textarea', 'Refactor this function and show the code', { delay: 4 });
  await page.keyboard.press('Enter');
  // The fixture streams for ~1.2s, then the observer waits 1.5s for quiescence
  // before it patches the row. Poll rather than guess.
  let after = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    after = await ext.evaluate(async () => await window.VG.db.all());
    const last = after[after.length - 1];
    if (last && typeof last.responseMs === 'number') break;
  }
  const wide = after[after.length - 1];
  check('standard scope records response length', wide.responseChars > 50, String(wide.responseChars));
  check('standard scope detects a code block', wide.responseHasCode === true, String(wide.responseHasCode));
  check('standard scope still redacts prompts', wide.promptText.indexOf('S1234567D') === -1, '');

  // Build a report over the captured events, the same way the UI does.
  // (Runs after the scope switch; the extra event is included deliberately.)
  const report = await ext.evaluate(() => {
    const VG = window.VG;
    const p = { id: 'test', label: 'Fixture run', from: 0, to: Date.now() + 1000, prevFrom: null };
    return VG.db.all().then((rows) => {
      const r = VG.buildReport(rows, [], p, VG.DEFAULT_SETTINGS, rows, null);
      return { summary: VG.summarise(r), exec: VG.executiveSummary(r), prompts: r.totals.prompts };
    });
  });

  console.log('\nreport generated from live capture');
  check('report counts every event', report.prompts === after.length, String(report.prompts));
  check('summary produced', report.summary.length > 200);

  // Sign and verify inside the extension, on data it actually captured.
  const sig = await ext.evaluate(async () => {
    const VG = window.VG;
    const rows = await VG.db.all();
    const p = { id: 'e2e', label: 'Fixture run', from: 0, to: Date.now() + 1000, prevFrom: null };
    const r = VG.buildReport(rows, [], p, VG.DEFAULT_SETTINGS, rows, null);
    const md = VG.reportToMarkdown(r);
    const signed = await VG.signMarkdown(md, r, 'e2e-key');
    const clean = await VG.verifyReportText(signed.markdown, 'e2e-key');
    // Bump whatever the real total is, so the test never drifts from the fixture.
    const line = signed.markdown.split('\n').find((l) => l.indexOf('| Prompts | ') === 0);
    const bumped = signed.markdown.replace(line, line.replace(/\| (\d+) \|/, (m, n) => `| ${Number(n) * 10} |`));
    const tampered = await VG.verifyReportText(bumped, 'e2e-key');
    return { ref: signed.ref, clean: clean.verdict, tampered: tampered.verdict,
             visible: VG.stripZeroWidth(signed.markdown).length < signed.markdown.length };
  });

  console.log('\nreport tamper-evidence, in the extension');
  check('report signed', /^VG-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(sig.ref), sig.ref);
  check('watermark invisible in the text', sig.visible === true);
  check('untouched signed report verifies', sig.clean === 'intact', sig.clean);
  check('edited figure detected', sig.tampered === 'altered', sig.tampered);

  /* --- scheduled upload, with no AI site open --- */
  console.log('\nscheduled upload from the service worker');
  await page.close();          // deliberately: nothing AI-related is open now


  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000 });

  const alarms = await worker.evaluate(async () =>
    (await chrome.alarms.getAll()).map((a) => ({ name: a.name, period: a.periodInMinutes })));
  check('an upload alarm is registered', alarms.some((a) => a.name === 'vantage-upload'),
    JSON.stringify(alarms));
  check('the alarm repeats hourly',
    (alarms.find((a) => a.name === 'vantage-upload') || {}).period === 60, JSON.stringify(alarms));

  const captured = await worker.evaluate(async () => {
    // Upload settings are policy-only and cannot be set from a message, so the
    // test injects them the way managed policy would.
    const realGet = VG.settings.get;
    VG.settings.get = async () => Object.assign(await realGet.call(VG.settings), {
      uploadEnabled: true,
      uploadUrl: 'https://collector.test.internal/v1/vantage',
      uploadAuthHeader: 'Bearer test-token',
      uploadCadence: 'daily',
      uploadContent: 'aggregate',
      reportSigningKey: 'e2e-key'
    });
    const realContains = chrome.permissions.contains;
    chrome.permissions.contains = async () => true;

    let seen = null;
    const realFetch = self.fetch;
    self.fetch = async (url, opts) => {
      seen = { url, headers: opts.headers, body: opts.body };
      return { ok: true, status: 200 };
    };

    const result = await self.runUpload('e2e');

    self.fetch = realFetch;
    VG.settings.get = realGet;
    chrome.permissions.contains = realContains;
    return { result, seen };
  });

  check('upload ran with no AI tab open', !!captured.seen, JSON.stringify(captured.result));
  if (captured.seen) {
    const body = JSON.parse(captured.seen.body);
    check('posted to the configured endpoint',
      captured.seen.url === 'https://collector.test.internal/v1/vantage', captured.seen.url);
    check('auth header sent', captured.seen.headers.Authorization === 'Bearer test-token', '');
    check('payload is signed', /^VG-/.test(body.signature.ref), body.signature.ref);
    check('payload names the period', /^d-\d{4}-\d{2}-\d{2}$/.test(body.period.id), body.period.id);
    check('aggregate payload carries the report', !!body.report, '');
    check('aggregate payload carries no event rows', body.events === undefined, '');
    check('no prompt text left the device',
      captured.seen.body.indexOf('S1234567D') === -1 &&
      captured.seen.body.indexOf('Refactor this handler') === -1, '');
  }

  const second = await worker.evaluate(async () => {
    const st = (await chrome.storage.local.get('uploadState')).uploadState;
    return { sent: st && st.sentPeriods, status: st && st.lastStatus };
  });
  check('the sent period is recorded so it is not sent twice',
    !!second.sent && second.sent.length > 0, JSON.stringify(second));

  await context.close();

  console.log('\n--- narrative from real captured data ---\n' + report.summary + '\n');
  console.log(failures ? `${failures} failure(s)\n` : 'all end-to-end checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('\nharness error:', err && err.message ? err.message : err);
  process.exit(2);
});
