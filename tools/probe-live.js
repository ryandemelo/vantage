/*
 * Vantage, live selector check against the real, signed-in sites.
 *
 * Opens a real browser window with the extension loaded and a profile that
 * persists between runs, so you sign in ONCE. It then checks every selector on
 * every covered site and writes a report.
 *
 *   node tools/probe-live.js                 # all built-in sites
 *   node tools/probe-live.js claude chatgpt  # only these
 *   SEND=1 node tools/probe-live.js          # also send one throwaway prompt
 *                                            # per site and verify capture
 *
 * The window stays open and waits for you to sign in. Nothing is sent anywhere;
 * the report lists CSS selectors and counts, never prompt or response text.
 *
 * The profile lives in .playwright-profile/, it holds real session cookies,
 * so it is gitignored and should be deleted when you are done:
 *   rm -rf .playwright-profile
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, '.playwright-profile');
const OUT = path.join(__dirname, 'probe-report.txt');
const SEND = process.env.SEND === '1';
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS || 300000); // 5 min per site

const TEST_PROMPT =
  'Summarise the key points of a two page policy note in five bullets. ' +
  '(Ignore this, automated selector check.)';

const SITES = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  copilot: 'https://m365.cloud.microsoft/chat'
};

const wanted = process.argv.slice(2).filter((a) => SITES[a]);
const targets = wanted.length ? wanted : Object.keys(SITES);

(async () => {
  console.log('\nVantage live probe');
  console.log('profile : ' + PROFILE + '   (delete it when you are done)');
  console.log('sites   : ' + targets.join(', '));
  console.log('\nA browser window will open. Sign in on each site when asked.\n');

  const browserCtx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    executablePath: chromium.executablePath(),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ],
    viewport: null,
    timeout: 60000
  });

  const admin = await browserCtx.newPage();
  await admin.goto('chrome://extensions/');
  await admin.waitForTimeout(1200);
  const loaded = await admin.evaluate(() => {
    const m = document.querySelector('extensions-manager');
    const l = m && m.shadowRoot.querySelector('extensions-item-list');
    const items = l ? [...l.shadowRoot.querySelectorAll('extensions-item')] : [];
    return items.map((i) => i.id);
  });
  if (!loaded.length) {
    console.log('Chrome rejected the manifest, nothing can be probed. Fix that first.');
    await browserCtx.close();
    process.exit(1);
  }
  const extId = loaded[0];
  await admin.close();

  const blocks = [];

  for (const key of targets) {
    const url = SITES[key];
    console.log(`\n── ${key} ─────────────────────────────`);
    const page = await browserCtx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // The content script marks the document once it is attached.
    await page.waitForSelector('html[data-vantage]', { timeout: 20000 }).catch(() => {});

    console.log('  waiting for a usable composer. SIGN IN in the window if prompted…');
    await page.bringToFront().catch(() => {});

    /*
     * The terminal is not where the person is looking, and when this runs in
     * the background they never see it at all. Put the instructions on the
     * page instead, and keep them there until a composer appears.
     */
    const banner = async () => {
      await page.evaluate((site) => {
        if (document.getElementById('vantage-probe-banner')) return;
        const b = document.createElement('div');
        b.id = 'vantage-probe-banner';
        b.style.cssText = [
          'position:fixed', 'inset:0 0 auto 0', 'z-index:2147483647',
          'background:#111827', 'color:#fff', 'padding:14px 18px',
          'font:14px/1.5 -apple-system,Segoe UI,system-ui,sans-serif',
          'box-shadow:0 2px 14px rgba(0,0,0,.35)'
        ].join(';');
        b.innerHTML =
          '<div style="font-weight:650;margin-bottom:6px">Vantage selector check, waiting on you (' + site + ')</div>' +
          '<div style="opacity:.9">1. Sign in.&nbsp;&nbsp;' +
          '2. Open a conversation that <b>already has a reply in it</b>, not a new chat.&nbsp;&nbsp;' +
          '3. Type a few characters in the message box and leave them there.</div>' +
          '<div style="opacity:.65;margin-top:6px;font-size:12px">' +
          'This banner disappears by itself once the page is ready. Nothing is sent anywhere.</div>';
        document.documentElement.appendChild(b);
      }, key).catch(() => {});
    };

    let ready = false;
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline && !ready) {
      await banner();   // survives navigation, so re-apply each pass
      ready = await page.evaluate(() => {
        const el = document.querySelector('div[contenteditable="true"], textarea');
        if (!el) return false;
        // A visible, interactive box. Search fields on a marketing page do not
        // count, and neither does a hidden one.
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 20;
      }).catch(() => false);
      if (!ready) await page.waitForTimeout(2000);
    }

    // Is this a signed out page? Worth knowing, because a missing composer on
    // a marketing page is not a stale selector.
    const auth = await page.evaluate(() => {
      const t = (document.body.innerText || '').slice(0, 4000).toLowerCase();
      const hasLogin = /\blog ?in\b|\bsign ?up\b|\bsign ?in\b/.test(t);
      const hasComposer = !!document.querySelector('div[contenteditable="true"], textarea');
      return { hasLogin, hasComposer, path: location.pathname };
    }).catch(() => ({ hasLogin: false, hasComposer: false, path: '' }));
    const signedOut = auth.hasLogin && !auth.hasComposer;

    await page.evaluate(() => {
      const b = document.getElementById('vantage-probe-banner');
      if (b) b.remove();
    }).catch(() => {});
    if (!ready) {
      const why = signedOut
        ? 'the page is showing a sign in screen'
        : 'no usable composer appeared';
      console.log('  skipped: ' + why);
      blocks.push(`### ${key}\nNOT CHECKED, ${why} within ${LOGIN_TIMEOUT_MS / 1000}s ` +
        `(path ${auth.path}).\nThis says nothing about whether the selectors are correct. ` +
        `Sign in, open a conversation with a reply in it, and re-run.\n`);
      await page.close();
      continue;
    }
    if (signedOut) {
      console.log('  warning: this looks like a signed out page, results may be misleading');
    }
    await page.waitForTimeout(2500);

    /*
     * Context matters more than it looks. Several of these UIs only render the
     * send button once the composer has text in it, and turn / regenerate /
     * attachment selectors cannot possibly match on an empty new chat. Probing
     * blind produces a page of MISSING lines that send you chasing selectors
     * that were never broken.
     *
     * So: type a character to reveal the send control, and record whether the
     * page even contains a conversation, then judge each group against what
     * this context can actually support.
     */
    let typed = false;
    try {
      const composer = await page.$('div[contenteditable="true"], textarea');
      if (composer) {
        await composer.click();
        await page.keyboard.type('x');
        await page.waitForTimeout(700);
        typed = true;
      }
    } catch (e) { /* some composers refuse programmatic focus */ }

    const context = await page.evaluate(() => {
      const anyTurn = document.querySelectorAll(
        '[data-message-author-role],[data-turn],[data-testid*="message" i],' +
        'user-query,model-response,div[class*="font-claude" i],div[class*="font-user" i]'
      ).length;
      return { turns: anyTurn, path: location.pathname };
    }).catch(() => ({ turns: 0, path: '' }));
    const hasConversation = context.turns > 0;

    const res = await probeViaExtension(browserCtx, extId, page);
    if (!res || !res.covered) {
      blocks.push(`### ${key}\nNO ADAPTER for ${page.url()}\n`);
      await page.close();
      continue;
    }

    // What this page can actually answer for. Anything else is not evidence.
    const answerable = {
      composer: true,
      send: true,
      thread: true,
      model: true,
      userTurn: hasConversation,
      assistantTurn: hasConversation,
      regenerate: hasConversation,
      attachment: false          // needs a file attached; never assume
    };

    const lines = [];
    lines.push(`### ${key}`);
    lines.push(`adapter : ${res.label} (${res.site} rev ${res.revision}, ${res.source})`);
    lines.push(`host    : ${res.host}`);
    lines.push(`path    : ${new URL(page.url()).pathname.replace(/[0-9a-f-]{8,}/gi, '<id>')}`);
    lines.push(`context : ${hasConversation ? context.turns + ' turns visible' : 'EMPTY CHAT, turn selectors cannot match here'}` +
      `${typed ? ', typed a character to reveal the send control' : ', could not type into the composer'}`);
    lines.push('');
    const realBroken = [];
    const realDegraded = [];
    res.rows.forEach((r) => {
      let status;
      if (r.matched) status = r.index === 0 ? 'OK      ' : 'FALLBACK';
      else if (!answerable[r.group]) status = 'n/a     ';
      else status = 'MISSING ';

      if (status === 'MISSING ') {
        if (r.group === 'composer' || r.group === 'send') realBroken.push(r.group);
        else realDegraded.push(r.group);
      } else if (status === 'FALLBACK') {
        realDegraded.push(r.group + ' (fallback ' + r.index + ')');
      }

      lines.push('  ' + status + ' ' + r.group.padEnd(14) +
        (r.matched ? 'x' + r.count + '  <- ' + r.matched
          : (answerable[r.group] ? 'none of the selectors matched'
            : 'not checkable in this context')));
    });
    lines.push('');
    lines.push(`  surface : ${res.surfaceLabel}${res.surfaceFlags.length ? ' + ' + res.surfaceFlags.join(', ') : ''}`);
    lines.push(`  agent   : ${res.agentDetected ? (res.agentNamed ? 'detected, named' : 'detected, unnamed') : 'none'}`);
    lines.push(`  shared  : ${res.shared ? 'yes' : 'no'}`);
    lines.push(`  account : ${res.accountTier}`);
    lines.push('');
    const verdict = realBroken.length ? 'BROKEN' : realDegraded.length ? 'WORKS, DEGRADED' : 'HEALTHY';
    lines.push('  VERDICT: ' + verdict +
      (realBroken.length ? ', ' + realBroken.join(', ') + ' did not resolve' : '') +
      (!realBroken.length && realDegraded.length ? ', ' + realDegraded.join(', ') : ''));
    if (!hasConversation) {
      lines.push('  NOTE: this was an empty chat. Re-run with a conversation open to check');
      lines.push('        the turn, regenerate and attachment selectors.');
    }

    if (SEND && !realBroken.length) {
      const before = await countEvents(browserCtx, extId);
      const composer = await page.$('div[contenteditable="true"], textarea');
      if (composer) {
        await composer.click();
        await page.keyboard.type(TEST_PROMPT, { delay: 8 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(6000);
        const after = await countEvents(browserCtx, extId);
        lines.push('');
        lines.push('  CAPTURE TEST: ' + (after > before
          ? `captured (${before} -> ${after} events)`
          : `NOT captured (still ${after} events), the composer or send hook did not fire`));
      }
    }

    if (typed) {
      await page.keyboard.press('Backspace').catch(() => {});
    }
    console.log(lines.join('\n'));
    blocks.push(lines.join('\n') + '\n');
    await page.close();
  }

  const report = [
    'VANTAGE LIVE PROBE',
    'generated ' + new Date().toISOString(),
    'selectors and counts only, no prompt or response text',
    ''
  ].concat(blocks).join('\n');

  fs.writeFileSync(OUT, report);
  console.log('\nreport written to ' + path.relative(process.cwd(), OUT));
  console.log('Close the browser window when you are done, then: rm -rf .playwright-profile\n');

  if (process.env.KEEP_OPEN !== '0') {
    console.log('Leaving the window open. Ctrl-C to exit.');
    await new Promise(() => {});
  }
  await browserCtx.close();
})().catch((err) => {
  console.error('\nharness error:', err && err.message ? err.message : err);
  process.exit(2);
});

/* Ask the extension's own content script to probe, so the adapter under test
 * is exactly the one this device would use, policy-pushed entries included. */
async function probeViaExtension(context, extId, page) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/ui/popup.html`);
  await ext.waitForTimeout(400);
  const targetUrl = page.url();
  const res = await ext.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === u) || tabs.find((t) => t.url && t.url.startsWith(u.split('?')[0]));
    if (!tab) return null;
    try { return await chrome.tabs.sendMessage(tab.id, { type: 'PROBE' }); }
    catch (e) { return null; }
  }, targetUrl).catch(() => null);
  await ext.close();
  return res;
}

async function countEvents(context, extId) {
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/src/ui/reports.html`);
  await ext.waitForTimeout(400);
  const n = await ext.evaluate(() => window.VG.db.count()).catch(() => 0);
  await ext.close();
  return n;
}
