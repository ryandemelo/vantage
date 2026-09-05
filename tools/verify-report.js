/*
 * Vantage — verify an exported report.
 *
 *   node tools/verify-report.js <report.md> --key <signing key>
 *   VANTAGE_KEY=<key> node tools/verify-report.js <report.md>
 *
 * The key is the one shown in Settings → Report integrity, or the
 * `reportSigningKey` pushed by policy. With the org key pushed centrally, one
 * verifier checks reports from every device.
 *
 * Exit codes: 0 intact · 1 altered · 2 unmarked or usage error.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
['schema', 'redact', 'classify', 'adapters', 'surfaces', 'report', 'sign'].forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src', 'core', f + '.js'), 'utf8'), { filename: f + '.js' });
});
const VG = globalThis.VG;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const keyIdx = args.indexOf('--key');
const key = keyIdx !== -1 ? args[keyIdx + 1] : process.env.VANTAGE_KEY;

if (!file) {
  console.error('usage: node tools/verify-report.js <report.md> --key <signing key>');
  process.exit(2);
}
if (!key) {
  console.error('No key given. Pass --key or set VANTAGE_KEY.');
  process.exit(2);
}

(async () => {
  const text = fs.readFileSync(file, 'utf8');
  const res = await VG.verifyReportText(text, key);

  console.log('\n' + path.basename(file));
  console.log('─'.repeat(Math.max(20, path.basename(file).length)));
  console.log('verdict         : ' + res.verdict.toUpperCase().replace('-', ' '));
  console.log('                  ' + res.explanation);
  console.log('');
  console.log('reference code  : ' + res.ref +
    (res.foundRef ? '   found ' + res.foundRef + ', expected ' + res.expectedRef : '   none in document'));
  console.log('watermark       : ' + res.watermark);
  console.log('phrasing        : ' + res.phrasing +
    '   (' + res.phrasingDetail.matched + ' of ' + res.phrasingDetail.checked + ' wordings agree)');
  console.log('figures read    : ' + res.figuresFound);
  console.log('');

  if (res.verdict === 'altered') {
    console.log('Treat this document as unreliable. Ask for the original export.');
  }
  process.exit(res.verdict === 'altered' ? 1 : res.verdict === 'unmarked' ? 2 : 0);
})().catch((e) => { console.error('error:', e.message); process.exit(2); });
