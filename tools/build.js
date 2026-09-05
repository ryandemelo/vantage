/*
 * Vantage, build.
 *
 *   node tools/build.js                                   # zip + crx + updates.xml
 *   CODEBASE=https://intranet.acme.example/vantage node tools/build.js
 *
 * Produces, in dist/:
 *   vantage-<version>.zip   upload to the Edge Add-ons or Chrome Web Store
 *   vantage-<version>.crx   signed package for self-hosted force-install
 *   updates.xml             update manifest the ExtensionInstallForcelist points at
 *
 * The private key lives in keys/vantage.pem and is gitignored. It is what fixes
 * the extension ID, and the ID is what every policy you write is keyed on. Back
 * it up somewhere your team can get at it. Lose it and you get a new ID, and
 * every deployed policy silently stops applying.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const KEY = path.join(ROOT, 'keys', 'vantage.pem');
const CODEBASE = process.env.CODEBASE || 'https://REPLACE-ME.internal/vantage';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

/* ---- the extension id is derived from the public key, not from the path ---- */
function extensionId() {
  if (!manifest.key) return null;
  const der = Buffer.from(manifest.key, 'base64');
  const hash = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/* ---- refuse to ship something obviously broken ---- */
function preflight() {
  const problems = [];
  if (!manifest.key) problems.push('manifest has no "key", the extension id will not be stable');
  if (!fs.existsSync(KEY)) problems.push('keys/vantage.pem is missing, cannot sign a crx');

  const csp = (manifest.content_security_policy || {}).extension_pages || '';
  const hosts = manifest.host_permissions || [];
  // If upload is going to be used, the endpoint origin has to be reachable.
  if (csp.indexOf('https:') === -1) {
    problems.push('CSP does not allow https:, scheduled upload will be blocked');
  }
  if (!hosts.some((h) => h.indexOf('claude.ai') !== -1)) {
    problems.push('host_permissions no longer covers claude.ai');
  }

  ['src', 'icons', 'policy'].forEach((d) => {
    if (!fs.existsSync(path.join(ROOT, d))) problems.push('missing directory: ' + d);
  });
  return problems;
}

function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ stdio: 'pipe', encoding: 'utf8' }, opts || {}));
}

/* ------------------------------------------------------------------ */

const problems = preflight();
if (problems.length) {
  console.error('\nBuild refused:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
const id = extensionId();

/* ---- zip for the stores ---- */
const zipName = `vantage-${version}.zip`;
const zipPath = path.join(DIST, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
run('zip', [
  '-r', '-q', zipPath,
  'manifest.json', 'src', 'icons', 'policy', 'README.md',
  '-x', '*.DS_Store'
], { cwd: ROOT });
console.log('zip        dist/' + zipName + '   ' + (fs.statSync(zipPath).size / 1024).toFixed(0) + ' KB');

/* ---- signed crx for self-hosting ---- */
let crxPath = null;
try {
  const { chromium } = require('playwright');
  const staging = path.join(DIST, 'pkg');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  ['manifest.json', 'src', 'icons', 'policy'].forEach((f) => {
    fs.cpSync(path.join(ROOT, f), path.join(staging, f), { recursive: true });
  });
  run(chromium.executablePath(), [
    '--no-sandbox',
    `--pack-extension=${staging}`,
    `--pack-extension-key=${KEY}`
  ]);
  const built = path.join(DIST, 'pkg.crx');
  crxPath = path.join(DIST, `vantage-${version}.crx`);
  if (fs.existsSync(built)) {
    fs.renameSync(built, crxPath);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(path.join(DIST, 'pkg.pem'), { force: true });
    console.log('crx        dist/' + path.basename(crxPath) + '   ' +
      (fs.statSync(crxPath).size / 1024).toFixed(0) + ' KB');
  } else {
    console.log('crx        not produced (Chrome did not emit one)');
    crxPath = null;
  }
} catch (e) {
  console.log('crx        skipped: ' + e.message.split('\n')[0]);
}

/* ---- update manifest for ExtensionInstallForcelist ---- */
const updates =
`<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${CODEBASE}/vantage-${version}.crx' version='${version}' />
  </app>
</gupdate>
`;
fs.writeFileSync(path.join(DIST, 'updates.xml'), updates);
console.log('updates    dist/updates.xml');

/* ---- what the platform team actually needs ---- */
console.log('\n' + '─'.repeat(64));
console.log('EXTENSION ID   ' + id);
console.log('VERSION        ' + version);
console.log('─'.repeat(64));
console.log(`
Force-install (Windows registry, or the Intune / GPO equivalent):

  HKLM\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist
    1 = "${id};${CODEBASE}/updates.xml"

Configuration:

  HKLM\\Software\\Policies\\Microsoft\\Edge\\3rdparty\\extensions\\${id}\\policy

Allow the upload endpoint without a user prompt:

  HKLM\\Software\\Policies\\Microsoft\\Edge\\ExtensionSettings
    {"${id}": {"runtime_allowed_hosts": ["*://collector.example.com"]}}

Chrome is identical with \\Google\\Chrome in place of \\Microsoft\\Edge.
Host the crx and updates.xml at ${CODEBASE}/ .
`);
