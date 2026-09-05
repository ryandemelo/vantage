/*
 * Vantage — smoke test.
 * Runs the pure core (redact / classify / report) outside the browser so the
 * pipeline can be checked without loading the extension.
 *
 *   node tests/smoke.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
['schema', 'redact', 'classify', 'adapters', 'surfaces', 'netrules', 'report', 'sign', 'upload'].forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'src', 'core', f + '.js'), 'utf8'), { filename: f + '.js' });
});
const VG = globalThis.VG;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ok   ' + name); }
  else { failures++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}

/* ------------------------------ redaction ------------------------------ */
console.log('\nredaction');
{
  const s = Object.assign({}, VG.DEFAULT_SETTINGS, {
    sensitiveWordlist: ['Project Kingfisher'],
    customRedactors: [{ id: 'case_ref', label: 'Case reference', pattern: '\\bCASE-\\d{6}\\b', replacement: '[CASE_REF]' }]
  });

  const r1 = VG.redact('Email j.rivera@acme.example about CASE-104477 for Project Kingfisher', s);
  check('email masked', !r1.text.includes('jane.tan@'), r1.text);
  check('custom pattern masked', r1.text.includes('[CASE_REF]'), r1.text);
  check('wordlist masked', r1.text.includes('[RESTRICTED]'), r1.text);

  const r2 = VG.redact('My national ID is S1234567D and card 4242 4242 4242 4242', s);
  check('valid card masked', r2.text.includes('[CARD]'), r2.text);

  const r3 = VG.redact('Call me on +65 9123 4567 or 6123-4567', s);
  check('phone masked', (r3.hits.phone || 0) >= 1, JSON.stringify(r3.hits));

  const r4 = VG.redact('The answer is 42 and the total was 1500 units', s);
  check('plain numbers untouched', r4.count === 0, r4.text);

  const r5 = VG.redact('key: sk-ant-api03-AbCdEf0123456789xyz and AKIAIOSFODNN7EXAMPLE', s);
  check('api key masked', r5.text.includes('[API_KEY]') || r5.text.includes('[SECRET]'), r5.text);
  check('aws key masked', r5.text.includes('[AWS_KEY]'), r5.text);

  const r6 = VG.redact('password = hunter2butlonger', s);
  check('assigned secret masked', r6.text.includes('[SECRET]'), r6.text);
}

/* ----------------------------- classifier ----------------------------- */
console.log('\nclassification');
{
  const s = VG.DEFAULT_SETTINGS;
  const cases = [
    ['Refactor this function and add a unit test, here is the stack trace', 'coding'],
    ['Draft an email to the director summarising the meeting minutes', 'drafting'],
    ['Write a SQL query to group by region and sum the totals from the claims table', 'data'],
    ['Summarise the key points of the attached policy document in bullet points', 'comprehension'],
    ['Translate this notice into simplified Chinese and Malay', 'translation'],
    ['Draft evaluation criteria for the tender and review the vendor SOW', 'procurement'],
    ['Explain how the transformer architecture works in simple terms', 'learning'],
    ['Reply to this customer enquiry about their refund request', 'support'],
    ['Draft a job description and interview questions for the new analyst role', 'hr'],
    ['Give me a legal opinion on our indemnity and liability exposure here', 'legal'],
    ['Suggest a recipe for dinner and a workout for tomorrow', 'personal'],
    ['asdf', 'other']
  ];
  cases.forEach(([text, want]) => {
    const got = VG.classify(text, s);
    check(`"${text.slice(0, 42)}…" → ${want}`, got.id === want, `got ${got.id} (${JSON.stringify(got.scores)})`);
  });
}

/* --------------------- classifier disambiguation ---------------------- */
console.log('\nclassifier logic');
{
  const s = VG.DEFAULT_SETTINGS;

  // "policy" collides badly with engineering vocabulary in a enterprise.
  const iam = VG.classify('Fix this IAM policy, the bucket policy denies access\n```json\n{}\n```', s);
  check('IAM policy is coding, not policy', iam.id === 'coding', iam.id);

  const contract = VG.classify('Debug my smart contract, the function reverts\n```solidity\n```', s);
  check('smart contract is coding, not procurement', contract.id === 'coding', contract.id);

  const holiday = VG.classify('Draft the organisation circular on public holiday arrangements for the division', s);
  check('business unit vocabulary beats personal', holiday.id !== 'personal', holiday.id);

  // Two jobs in one prompt keeps the second intent.
  const two = VG.classify('Summarise the attached consultation response then translate the summary into Malay', s);
  check('secondary intent captured', !!two.secondary, JSON.stringify(two.scores));

  // Long pastes must not drift on volume alone.
  const filler = ' the quick brown fox jumps over the lazy dog'.repeat(30);
  const longDraft = VG.classify('Draft a reply to this email.' + filler, s);
  check('long prompt still classified', longDraft.id === 'drafting', longDraft.id);

  // Non-work flag rides along with the category.
  check('non-work flagged', VG.classify('Plan my vacation itinerary and book a hotel in Tokyo', s).nonWork === true, '');

  // Short follow-up turns inherit the thread topic instead of dying in `other`.
  const weak = VG.classify('make it shorter', s);
  check('bare follow-up is weak on its own', weak.id === 'other', weak.id);
  const inherited = VG.applyContext(weak, { workType: 'drafting', confidence: 0.8 }, 3);
  check('follow-up inherits thread topic', inherited.id === 'drafting' && inherited.source === 'inherited', inherited.id);
  const firstTurn = VG.applyContext(weak, { workType: 'drafting', confidence: 0.8 }, 1);
  check('turn 1 never inherits', firstTurn.source === 'direct' && firstTurn.id === 'other', firstTurn.id);
  const strong = VG.classify('Write a SQL query grouping by region', s);
  check('confident turn does not inherit', VG.applyContext(strong, { workType: 'drafting', confidence: 0.9 }, 4).id === 'data', '');
}

/* --------------------------- account tier ----------------------------- */
console.log('\naccount tier');
{
  const adapter = { account: { emailFrom: ['#email'], planFrom: ['#plan'] } };
  const doc = (map) => ({ querySelector: (sel) => (map[sel] ? { innerText: map[sel] } : null) });
  const minimal = Object.assign({}, VG.DEFAULT_SETTINGS, { corporateDomains: ['acme.example'] });
  const standard = Object.assign({}, minimal, { domScope: 'standard' });

  // Default scope: the account menu address is never read.
  let touched = 0;
  const spyDoc = (map) => ({
    querySelector: (sel) => {
      if (sel === '#email') touched++;
      return map[sel] ? { innerText: map[sel] } : null;
    }
  });
  const r1 = VG.detectAccount(adapter, spyDoc({ '#email': 'j.rivera@acme.example' }), minimal);
  check('default scope never reads the account address', touched === 0, 'selector hit ' + touched + 'x');
  check('default scope falls back to unknown without a badge', r1 === 'unknown', r1);
  check('default scope still reads the plan badge',
    VG.detectAccount(adapter, doc({ '#plan': 'Enterprise workspace' }), minimal) === 'enterprise', '');

  // Standard scope, opted into explicitly.
  check('corporate domain -> enterprise',
    VG.detectAccount(adapter, doc({ '#email': 'j.rivera@acme.example' }), standard) === 'enterprise', '');
  check('subdomain of corporate domain -> enterprise',
    VG.detectAccount(adapter, doc({ '#email': 'j@eng.acme.example' }), standard) === 'enterprise', '');
  check('outside domain -> personal',
    VG.detectAccount(adapter, doc({ '#email': 'someone@gmail.com' }), standard) === 'personal', '');
  check('nothing readable -> unknown',
    VG.detectAccount(adapter, doc({}), standard) === 'unknown', '');
}

/* ------------------------ dom scope is the default -------------------- */
console.log('\ndom scope');
{
  check('minimal is the shipped default', VG.DEFAULT_SETTINGS.domScope === 'minimal',
    VG.DEFAULT_SETTINGS.domScope);
  check('scope is pinnable by policy', VG.MANAGED_KEYS.indexOf('domScope') !== -1, '');

  // copy-out rate must work from the event count alone, with no character
  // count available — that is the whole point of the minimal scope.
  const s = VG.DEFAULT_SETTINGS;
  const now = Date.now();
  const mk = (extra) => Object.assign(VG.newEvent(), {
    ts: now, day: VG.localDay(now), site: 'claude', host: 'claude.test',
    conversationHash: 'c1', turn: 1, workType: 'coding',
    workTypeLabel: 'Software engineering'
  }, extra || {});
  const ev = [
    mk({ copyEvents: 1, copyLarge: 1 }),                       // substantial
    mk({ conversationHash: 'c2', copyEvents: 1 }),             // trivial: a word or two
    mk({ conversationHash: 'c3' }),
    mk({ conversationHash: 'c4' })
  ];
  const period = { id: 't', label: 'Scope test', from: now - 86400000, to: now + 86400000, prevFrom: null };
  const rep = VG.buildReport(ev, [], period, s, ev, null);
  check('copy rate counts every copy', rep.usability.copyRate === 50,
    String(rep.usability.copyRate));
  check('copied characters reported as not measured under minimal scope',
    rep.usability.copiedCharsMeasured === false, String(rep.usability.copiedOutChars));
  check('response length reported as not measured under minimal scope',
    rep.usability.responseCharsMeasured === false, '');
  // The value estimate multiplies by this number, so a one-word copy must not
  // enter it — that is how a defensible figure becomes an inflated one.
  check('only substantial copies are value-eligible',
    rep.value.eligibleMoments === 1, String(rep.value.eligibleMoments));
  check('substantial copies surfaced as their own metric',
    rep.usability.substantialCopies === 1, String(rep.usability.substantialCopies));
}

/* --------------------------- network capture -------------------------- */
console.log('\nnetwork request extraction');
{
  const chatgpt = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'chatgpt');
  const claude = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'claude');
  const gemini = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'gemini');

  const cg = VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'POST',
    JSON.stringify({ action: 'next', conversation_id: '7f3a-9b1c',
      messages: [{ author: { role: 'user' }, content: { content_type: 'text', parts: ['Refactor this handler'] } }] }));
  check('chatgpt prompt extracted', cg && cg.prompt === 'Refactor this handler', JSON.stringify(cg));
  check('chatgpt conversation id extracted', cg && cg.conversationId === '7f3a-9b1c', '');

  const cl = VG.readRequest(claude.net, 'https://claude.ai/api/organizations/x/chat_conversations/y/completion', 'POST',
    JSON.stringify({ prompt: 'Summarise the attached note', conversation_uuid: 'abc-123' }));
  check('claude prompt extracted', cl && cl.prompt === 'Summarise the attached note', JSON.stringify(cl));

  check('gemini has no rule, so it stays on the page path', gemini.net.length === 0, '');

  // Requests that are not prompts must be ignored.
  check('same endpoint without a prompt is ignored',
    VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'POST', '{"action":"variant"}') === null, '');
  check('a different endpoint is ignored',
    VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/settings', 'POST', '{"a":1}') === null, '');
  check('a GET is ignored',
    VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'GET', '{"messages":[]}') === null, '');
  check('a non JSON body is ignored',
    VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'POST', 'not json') === null, '');
  check('an empty rule set matches nothing',
    VG.readRequest([], 'https://chatgpt.com/backend-api/conversation', 'POST', '{}') === null, '');

  // Multi part messages join rather than losing everything after the first.
  const multi = VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'POST',
    JSON.stringify({ messages: [{ content: { parts: ['first line', 'second line'] } }] }));
  check('multi part content is joined', multi.prompt === 'first line\nsecond line', JSON.stringify(multi));

  // A wildcard must walk arrays and objects without throwing on odd shapes.
  const odd = VG.readRequest(chatgpt.net, 'https://chatgpt.com/backend-api/conversation', 'POST',
    JSON.stringify({ messages: [{ content: { parts: [null, 12, { nested: 'x' }, 'real text'] } }] }));
  check('non string parts are skipped', odd && odd.prompt === 'real text', JSON.stringify(odd));

  check('rules survive the policy normaliser',
    (VG.normaliseCustomAdapter({ id: 'x', label: 'X', hosts: ['x.test'],
      net: [{ id: 'r', url: '/api', paths: ['p'] }] }).net || []).length === 1, '');
}

/* ------------------------------ surfaces ------------------------------ */
console.log('\nsurfaces');
{
  const fakeDoc = (hits) => ({
    querySelector: (sel) => (hits.includes(sel) ? { innerText: 'Policy Brief Builder' } : null)
  });
  const chatgpt = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'chatgpt');
  const claude = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'claude');
  const gemini = VG.BUILTIN_ADAPTERS.find((a) => a.id === 'gemini');

  let r = VG.detectSurface(chatgpt, new URL('https://chatgpt.com/g/g-abc123XYZ/c/111'), fakeDoc(['header h1']));
  check('custom GPT detected', r.surface === 'custom_agent' && r.agentType === 'gpt', r.surface);
  check('GPT id captured', r.agentIdRaw === 'g-abc123XYZ', r.agentIdRaw);
  check('GPT name read', r.agentName === 'Policy Brief Builder', r.agentName);

  r = VG.detectSurface(chatgpt, new URL('https://chatgpt.com/g/g-p-9911/project'), fakeDoc([]));
  check('project beats GPT rule', r.surface === 'project' && r.agentType === 'project', r.surface);

  r = VG.detectSurface(chatgpt, new URL('https://chatgpt.com/c/abc'), fakeDoc(['[data-testid="canvas-panel"]']));
  check('plain chat + canvas flag', r.surface === 'chat' && r.flags.includes('canvas'), r.surface + ' ' + r.flags.join(','));

  r = VG.detectSurface(claude, new URL('https://claude.ai/project/xy12ab34'), fakeDoc([]));
  check('claude project detected', r.surface === 'project', r.surface);

  r = VG.detectSurface(gemini, new URL('https://gemini.google.com/gem/abcd1234'), fakeDoc([]));
  check('gemini gem detected', r.surface === 'custom_agent' && r.agentType === 'gem', r.surface);

  r = VG.detectSurface(claude, new URL('https://claude.ai/chat/abc'), fakeDoc([]));
  check('default is plain chat', r.surface === 'chat' && !r.agentIdRaw, r.surface);
}

/* ------------------------- config precedence -------------------------- */
console.log('\nconfig sources');
{
  const s = Object.assign({}, VG.DEFAULT_SETTINGS, {
    policyAdapters: [{ id: 'internal', label: 'Internal Assistant', hosts: ['ai.acme.example'], revision: 4 }],
    customAdapters: [
      { id: 'internal', label: 'User copy that must lose', hosts: ['ai.acme.example'] },
      { id: 'mine', label: 'My tool', hosts: ['tool.example'] }
    ]
  });
  const a = VG.resolveAdapter('ai.acme.example', s);
  check('policy wins over user for same id', a && a.label === 'Internal Assistant', a && a.label);
  check('policy entry marked', a && a.source === 'policy', a && a.source);
  const b = VG.resolveAdapter('tool.example', s);
  check('user adapter still resolves', b && b.source === 'custom', b && b.source);
  const c = VG.resolveAdapter('claude.ai', s);
  check('builtin still resolves', c && c.id === 'claude' && c.source === 'builtin', c && c.source);
  const list = VG.adapterList(s);
  check('no duplicate ids', new Set(list.map((x) => x.id)).size === list.length, String(list.length));
  const disabled = VG.resolveAdapter('claude.ai', Object.assign({}, s, { disabledSites: ['claude'] }));
  check('disabled site not resolved', disabled === null, disabled && disabled.id);
}

/* ------------------------------- report ------------------------------- */
console.log('\nreport');
{
  const s = VG.DEFAULT_SETTINGS;
  const now = Date.now();
  const day = 86400000;
  const mk = (offsetDays, site, workType, extra) => Object.assign(VG.newEvent(), {
    ts: now - offsetDays * day,
    day: VG.localDay(now - offsetDays * day),
    site, host: site + '.test',
    conversationHash: 'c' + Math.floor(offsetDays),
    turn: 1, promptChars: 120, promptWords: 22,
    workType, workTypeLabel: VG.taxonomyById(workType).label,
    firstTokenMs: 900, responseChars: 800
  }, extra || {});

  const events = [
    mk(1, 'claude', 'coding', { redactionCount: 2, redactionHits: { email: 1, phone: 1 },
      surface: 'project', surfaceLabel: 'Project', agentKey: 'k1', agentName: 'Codebase Q&A', agentType: 'project', shared: true }),
    mk(1, 'claude', 'coding', { turn: 2, copiedOut: 340, savedMinutes: 60,
      surface: 'project', surfaceLabel: 'Project', agentKey: 'k1', agentName: 'Codebase Q&A', agentType: 'project', shared: true }),
    mk(2, 'chatgpt', 'drafting', { copiedOut: 900, savedMinutes: 15, surfaceFlags: ['canvas'] }),
    mk(3, 'gemini', 'comprehension', { regenerated: 1 }),
    mk(3, 'claude', 'data', { attachments: 1 }),
    mk(4, 'chatgpt', 'personal', { nonWork: true, accountTier: 'personal' })
  ];
  const period = { id: 'test', label: 'Test window', from: now - 7 * day, to: now + day, prevFrom: now - 14 * day };
  const r = VG.buildReport(events, [], period, s);

  check('prompt total', r.totals.prompts === 6, String(r.totals.prompts));
  check('non-work counted', r.compliance.nonWorkPrompts === 1, String(r.compliance.nonWorkPrompts));
  check('personal account counted', r.compliance.personalAccountRate > 0, String(r.compliance.personalAccountRate));
  check('classifier quality block', typeof r.classifier.uncategorisedRate === 'number', '');
  check('tools counted', r.totals.tools === 3, String(r.totals.tools));
  check('work types ranked', r.workTypes[0].id === 'coding', r.workTypes[0].id);
  check('sensitive share', r.risk.pctWithSensitive === 16.7, String(r.risk.pctWithSensitive));
  check('copy rate present', r.usability.copyRate > 0, String(r.usability.copyRate));
  check('trend length', r.trend.length >= 7, String(r.trend.length));

  // platform surfaces + named assets
  check('project surface counted', r.platform.surfaces.some((x) => x.id === 'project' && x.count === 2), JSON.stringify(r.platform.surfaces.map((x) => x.id)));
  check('canvas flag counted', r.platform.surfaces.some((x) => x.id === 'flag:canvas'), '');
  check('agent aggregated', r.platform.agents.length === 1 && r.platform.agents[0].prompts === 2, String(r.platform.agents.length));
  check('agent marked shared', r.platform.agents[0].shared === true, '');
  check('reuse rate', r.platform.agentReuseRate === 33.3, String(r.platform.agentReuseRate));

  // self-reported value
  check('value responses', r.value.responses === 2, String(r.value.responses));
  check('value mean', r.value.meanMinutes === 37.5, String(r.value.meanMinutes));
  check('value flagged insufficient', r.value.confidence === 'insufficient', r.value.confidence);
  check('value interval present', r.value.estHoursHigh >= r.value.estHours, '');

  // sustained use
  check('adoption computed', typeof r.adoption.activeWeeksOf6 === 'number', '');
  check('weekly series', r.adoption.weekly.length === 8, String(r.adoption.weekly.length));

  // workflows
  check('workflow block present', Array.isArray(r.workflows.sequences), '');

  // executive summary
  const ex = VG.executiveSummary(r);
  check('exec summary rows well formed', ex.length >= 5 && ex.every((x) => x.k && x.v && x.method),
    String(ex.length));
  const worth = ex.find((x) => x.k.indexOf('worth') !== -1);
  check('exec names its method', !!worth && worth.method.indexOf('Self-report') >= 0,
    worth ? worth.method : '(row missing)');
  check('low volume leads with the sample size',
    ex[0].k.indexOf('How much is there to go on') !== -1, ex[0].k);

  const summary = VG.summarise(r);
  check('summary non-trivial', summary.length > 220, summary.slice(0, 90));
  const md = VG.reportToMarkdown(r);
  check('markdown has tables', md.includes('| Metric | Value |'), '');
  const csv = VG.toCSV(events, false);
  check('csv rows', csv.split('\n').length === 7, String(csv.split('\n').length));
  check('csv omits text column', !csv.split('\n')[0].includes('promptText'), '');

  check('summary mentions sustained use', summary.indexOf('Sustained use') >= 0, '');
  check('summary mentions named assets', summary.indexOf('named Project') >= 0, '');
  check('markdown has caveats', md.indexOf('cannot tell you') >= 0, '');
  check('markdown has governance', md.indexOf('## Governance') >= 0, '');
  check('csv has surface columns', csv.split('\n')[0].indexOf('agentName') >= 0, '');

  console.log('\n--- executive summary ---');
  VG.executiveSummary(r).forEach((row) => console.log(`  ${row.k}\n    ${row.v}\n    method: ${row.method}`));
  console.log('\n--- narrative ---\n' + summary + '\n');
}

/* --------------------------- low volume ------------------------------- */
console.log('\nlow volume behaviour');
{
  const st = VG.DEFAULT_SETTINGS;
  const now = Date.now(), day = 86400000;
  const mk = (off, wt, extra) => Object.assign(VG.newEvent(), {
    ts: now - off * day, day: VG.localDay(now - off * day), site: 'claude',
    host: 'claude.test', conversationHash: 'c' + off, turn: 1, promptWords: 9,
    workType: wt, workTypeLabel: VG.taxonomyById(wt).label
  }, extra || {});
  const period = (from, to) => ({ id: 'lv', label: 'Low volume', from, to, prevFrom: null });

  // Five prompts. A share here is noise with a percent sign on it.
  const few = [mk(1, 'coding'), mk(2, 'coding'), mk(3, 'drafting'), mk(4, 'coding'), mk(5, 'policy')];
  const rFew = VG.buildReport(few, [], period(now - 30 * day, now + day), st, few, null);
  check('five prompts band as too-few', rFew.volume.band === 'too-few', rFew.volume.band);
  check('shares are not quotable', rFew.volume.quoteShares === false, '');
  check('headline swings to adoption, not value', rFew.volume.headline === 'adoption', rFew.volume.headline);

  const narrative = VG.summarise(rFew);
  check('narrative opens with the sample size', narrative.indexOf('Only 5 prompts') === 0, narrative.slice(0, 40));
  check('narrative gives counts, not percentages, for the work profile',
    narrative.indexOf('software engineering (3)') !== -1, '');
  const md = VG.reportToMarkdown(rFew);
  check('markdown carries a small-sample banner', md.indexOf('**Small sample') !== -1, '');
  check('markdown withholds shares', md.indexOf('| Software engineering | 3 | n/a |') !== -1, '');
  check('markdown lists the untapped categories', md.indexOf('no use at all') !== -1, '');
  check('exec summary leads with how much there is to go on',
    VG.executiveSummary(rFew)[0].k.indexOf('How much') !== -1, '');
  // buildUntapped excludes 'other' and 'personal' as well as the three used.
  check('untapped categories counted', rFew.untapped.length === VG.TAXONOMY.length - 2 - 3,
    String(rFew.untapped.length));

  // Enough volume: shares come back.
  const many = [];
  for (let i = 0; i < 40; i++) many.push(mk(i % 20, i % 3 === 0 ? 'coding' : 'drafting', { conversationHash: 'k' + i }));
  const rMany = VG.buildReport(many, [], period(now - 30 * day, now + day), st, many, null);
  check('forty prompts band as reportable', rMany.volume.band === 'reportable', rMany.volume.band);
  check('shares quotable at volume', rMany.volume.quoteShares === true, '');
  check('markdown prints shares at volume',
    VG.reportToMarkdown(rMany).indexOf('| Software engineering | 14 | 35%') !== -1, '');

  // Lapse detection: nothing for three weeks.
  const stale = [mk(25, 'coding'), mk(26, 'coding')];
  const rStale = VG.buildReport(stale, [], period(now - 60 * day, now + day), st, stale, null);
  check('lapse detected', rStale.adoption.lapsed === true, String(rStale.adoption.daysSinceLastUse));
  check('lapse surfaces in the narrative', VG.summarise(rStale).indexOf('Use has lapsed') !== -1, '');

  // A first experience where nothing was taken away.
  check('bad first experience is named',
    rFew.firstExperience.verdict.indexOf('does not come back') !== -1, rFew.firstExperience.verdict);
}

/* ---------------------------- migration ------------------------------- */
console.log('\nevent row migration');
{
  // A row exactly as the first release wrote it.
  const v1 = {
    id: 1, ts: Date.now(), day: VG.localDay(Date.now()), site: 'claude',
    host: 'claude.ai', model: '', conversationHash: 'abc', turn: 1,
    promptChars: 120, promptWords: 22, promptText: 'redacted text',
    workType: 'coding', workTypeLabel: 'Software engineering',
    workTypeConfidence: 0.6, workTypeRunnerUp: '', redactionHits: {}, redactionCount: 0,
    attachments: 0, firstTokenMs: 900, responseMs: 8000, responseChars: 800,
    responseHasCode: true, regenerated: 0, copiedOut: 450, schemaVersion: 1
  };
  const m = VG.migrateEvent(v1);

  check('row is stamped at the current schema', m.schemaVersion === VG.EVENT_SCHEMA_VERSION,
    String(m.schemaVersion));
  check('surface fields filled', m.surface === 'chat' && Array.isArray(m.surfaceFlags), m.surface);
  check('agent fields filled', m.agentKey === '' && m.shared === false, '');
  check('classifier provenance filled', m.workTypeSource === 'direct' && m.workTypeSecondary === '', '');
  check('non work derived from the category', m.nonWork === false, String(m.nonWork));
  check('account tier defaults to unknown', m.accountTier === 'unknown', m.accountTier);
  // 450 characters copied: one copy, and substantial by the old threshold.
  check('copy event inferred from the old character count', m.copyEvents === 1, String(m.copyEvents));
  check('substantial copy inferred from the old threshold', m.copyLarge === 1, String(m.copyLarge));
  check('original fields untouched', m.promptText === 'redacted text' && m.copiedOut === 450, '');

  const small = VG.migrateEvent(Object.assign({}, v1, { copiedOut: 30 }));
  check('a small old copy is not counted as substantial',
    small.copyEvents === 1 && small.copyLarge === 0, String(small.copyLarge));
  const none = VG.migrateEvent(Object.assign({}, v1, { copiedOut: 0 }));
  check('no old copy means no copy event', none.copyEvents === 0 && none.copyLarge === 0, '');

  check('migration is idempotent',
    JSON.stringify(VG.migrateEvent(m)) === JSON.stringify(m), '');
  const current = VG.newEvent();
  check('a current row is returned untouched', VG.migrateEvent(current) === current, '');
  check('a nonsense value does not throw',
    VG.migrateEvent(null) === null && VG.migrateEvent(7) === 7, '');

  // The whole point: a migrated row must survive the report pipeline.
  const period = { id: 'm', label: 'Migration', from: v1.ts - 86400000, to: v1.ts + 86400000, prevFrom: null };
  const rep = VG.buildReport([m], [], period, VG.DEFAULT_SETTINGS, [m], null);
  check('a migrated row reports as one substantial copy',
    rep.usability.substantialCopies === 1 && rep.value.eligibleMoments === 1,
    String(rep.usability.substantialCopies));
  check('database version was bumped alongside the schema', VG.DB_VERSION === 2, String(VG.DB_VERSION));
}

/* ------------------------------ upload -------------------------------- */
console.log('\nscheduled upload');
{
  const base = Object.assign({}, VG.DEFAULT_SETTINGS, {
    uploadEnabled: true, uploadUrl: 'https://collector.acme.example/v1/vantage',
    uploadCadence: 'weekly', weekStartsOn: 1
  });
  // A Wednesday, so "this week" is genuinely incomplete.
  const now = new Date('2026-09-02T10:00:00').getTime();

  const fresh = VG.pendingPeriods(base, { sentPeriods: [] }, now);
  check('the period in progress is never sent', fresh.every((p) => p.to <= VG.startOfWeek(now, 1)),
    fresh.map((p) => p.id).join(','));
  check('completed periods are queued oldest first',
    fresh.length > 1 && fresh[0].from < fresh[1].from, String(fresh.length));

  const lastWeekId = fresh[fresh.length - 1].id;
  const after = VG.pendingPeriods(base, { sentPeriods: [lastWeekId] }, now);
  check('a sent period is not sent again', after.every((p) => p.id !== lastWeekId), lastWeekId);

  const monthly = VG.pendingPeriods(Object.assign({}, base, { uploadCadence: 'monthly' }), { sentPeriods: [] }, now);
  check('monthly cadence produces month keys', /^m-\d{4}-\d{2}$/.test(monthly[0].id), monthly[0].id);
  const daily = VG.pendingPeriods(Object.assign({}, base, { uploadCadence: 'daily' }), { sentPeriods: [] }, now);
  check('daily cadence produces day keys', /^d-\d{4}-\d{2}-\d{2}$/.test(daily[0].id), daily[0].id);

  // A browser closed for weeks catches up rather than losing the periods.
  check('a long gap is caught up, not dropped', fresh.length >= 8, String(fresh.length));

  // Backoff
  check('first attempt is allowed', VG.uploadBackoffOk({ failures: 0 }, now) === true, '');
  check('an immediate retry after a failure is refused',
    VG.uploadBackoffOk({ failures: 3, lastAttemptAt: now - 60000 }, now) === false, '');
  check('a retry is allowed once the backoff has elapsed',
    VG.uploadBackoffOk({ failures: 3, lastAttemptAt: now - 5 * 3600000 }, now) === true, '');
}

async function uploadPayloadChecks() {
  console.log('\nupload payload gating');
  const now = Date.now();
  const mk = (extra) => Object.assign(VG.newEvent(), {
    ts: now, day: VG.localDay(now), site: 'claude', host: 'claude.test',
    conversationHash: 'c1', turn: 1, workType: 'coding',
    workTypeLabel: 'Software engineering', promptText: 'redacted [EMAIL] text here'
  }, extra || {});
  const events = [mk(), mk({ conversationHash: 'c2' })];
  const period = { id: 'w-test', label: 'Week', from: now - 7 * 86400000, to: now + 1, prevFrom: now - 14 * 86400000 };

  const mkBody = async (over) => {
    const st = Object.assign({}, VG.DEFAULT_SETTINGS, { reportSigningKey: 'k' }, over || {});
    const rep = VG.buildReport(events, [], period, st, events, null);
    return VG.buildUploadPayload({ report: rep, events, settings: st, org: { userKey: 'dev1', businessUnit: 'Engineering' }, period });
  };

  const agg = await mkBody({ uploadContent: 'aggregate' });
  check('aggregate carries no event rows', agg.events === undefined, '');
  check('aggregate carries no prompt text anywhere',
    JSON.stringify(agg).indexOf('redacted [EMAIL]') === -1, '');
  check('payload is signed', /^VG-/.test(agg.signature.ref), agg.signature.ref);
  check('payload carries the device and business unit', agg.device.key === 'dev1' && agg.device.businessUnit === 'Engineering', '');

  const sum = await mkBody({ uploadContent: 'summary' });
  check('summary carries narrative, not the report object', !!sum.summary && sum.report === undefined, '');

  const evNoText = await mkBody({ uploadContent: 'events' });
  check('events upload defaults to stripping prompt text',
    evNoText.events.every((e) => e.promptText === ''), '');
  check('the payload says whether text was included',
    evNoText.eventsIncludePromptText === false, '');

  const evText = await mkBody({ uploadContent: 'events', uploadIncludePromptText: true });
  check('prompt text needs its own explicit opt-in',
    evText.events[0].promptText.indexOf('[EMAIL]') !== -1, '');

  // Metadata capture level must win over the upload flag.
  const evMeta = await mkBody({
    uploadContent: 'events', uploadIncludePromptText: true,
    captureLevel: VG.CAPTURE_LEVELS.METADATA
  });
  check('metadata capture level overrides the upload text flag',
    evMeta.events.every((e) => e.promptText === ''), '');

  // Writing straight to object storage means every period needs its own
  // object, otherwise each upload overwrites the last.
  const tmpl = Object.assign({}, VG.DEFAULT_SETTINGS, {
    uploadUrl: 'https://acct.blob.core.example/vantage/{unit}/{period}-{device}.json?sv=2024&sig=abc',
    orgUnit: 'Field Engineering'
  });
  const target = VG.uploadTarget(tmpl, { id: 'w-2026-09-01' }, { userKey: 'a1b2c3', businessUnit: 'Field Engineering' });
  check('placeholders substituted',
    target.indexOf('/field-engineering/w-2026-09-01-a1b2c3.json') !== -1, target);
  check('presigned query string preserved', target.indexOf('?sv=2024&sig=abc') !== -1, target);
  check('two periods write to different objects',
    VG.uploadTarget(tmpl, { id: 'w-2026-09-08' }, { userKey: 'a1b2c3' }) !== target, '');
  check('an unset business unit falls back to the policy value',
    VG.uploadTarget(tmpl, { id: 'w-1' }, {}).indexOf('/field-engineering/') !== -1,
    VG.uploadTarget(tmpl, { id: 'w-1' }, {}));
  const noUnit = Object.assign({}, tmpl, { orgUnit: '' });
  check('with nothing set at all the path segment is still valid',
    VG.uploadTarget(noUnit, { id: 'w-1' }, {}).indexOf('/unassigned/') !== -1,
    VG.uploadTarget(noUnit, { id: 'w-1' }, {}));
  check('values are slugged so they cannot break the path',
    VG.uploadTarget(tmpl, { id: 'w-1' }, { businessUnit: 'R&D / Platform' }).indexOf('/r-d-platform/') !== -1,
    VG.uploadTarget(tmpl, { id: 'w-1' }, { businessUnit: 'R&D / Platform' }));

  const blobHeaders = VG.uploadHeaders(Object.assign({}, VG.DEFAULT_SETTINGS, {
    uploadHeaders: { 'x-ms-blob-type': 'BlockBlob' }
  }));
  check('extra headers are sent', blobHeaders['x-ms-blob-type'] === 'BlockBlob', JSON.stringify(blobHeaders));
  check('no Authorization when the url is presigned',
    blobHeaders.Authorization === undefined, JSON.stringify(blobHeaders));
  check('Authorization sent when configured',
    VG.uploadHeaders(Object.assign({}, VG.DEFAULT_SETTINGS, { uploadAuthHeader: 'Bearer x' })).Authorization === 'Bearer x', '');
  check('default method suits object storage', VG.DEFAULT_SETTINGS.uploadMethod === 'PUT',
    VG.DEFAULT_SETTINGS.uploadMethod);

  const desc = VG.uploadDescription(Object.assign({}, VG.DEFAULT_SETTINGS, {
    uploadEnabled: true, uploadUrl: 'https://collector.acme.example/v1', uploadCadence: 'weekly'
  }));
  check('transparency panel names the host and cadence',
    desc.host === 'collector.acme.example' && desc.when === 'once a week', JSON.stringify(desc));
  check('upload described as off when not configured',
    VG.uploadDescription(VG.DEFAULT_SETTINGS) === null, '');

  console.log('\npolicy-only settings');
  check('upload keys are policy-only',
    VG.POLICY_ONLY_KEYS.indexOf('uploadUrl') !== -1 && VG.POLICY_ONLY_KEYS.indexOf('uploadEnabled') !== -1, '');
  check('every policy-only key is also a managed key',
    VG.POLICY_ONLY_KEYS.every((k) => VG.MANAGED_KEYS.indexOf(k) !== -1), '');
}

/* --------------------------- report signing --------------------------- */
console.log('\nreport tamper-evidence');
(async () => {
  const s = VG.DEFAULT_SETTINGS;
  const KEY = 'test-org-key-0123456789';
  const now = Date.now(), day = 86400000;
  const mk = (off, site, wt, extra) => Object.assign(VG.newEvent(), {
    ts: now - off * day, day: VG.localDay(now - off * day),
    site, host: site + '.test', conversationHash: 'c' + off, turn: 1,
    promptChars: 120, promptWords: 22, workType: wt,
    workTypeLabel: VG.taxonomyById(wt).label, firstTokenMs: 900, responseChars: 800
  }, extra || {});

  const events = [
    mk(1, 'claude', 'coding', { copiedOut: 400 }),
    mk(1, 'claude', 'coding', { turn: 2 }),
    mk(2, 'chatgpt', 'drafting', { redactionCount: 1, redactionHits: { email: 1 } }),
    mk(3, 'gemini', 'comms'),
    mk(3, 'chatgpt', 'appraisal'),
    mk(4, 'claude', 'personal', { nonWork: true, accountTier: 'personal' })
  ];
  const period = { id: 't', label: 'Signing test', from: now - 7 * day, to: now + day, prevFrom: null };
  const r = VG.buildReport(events, [], period, s, events, null);

  const plain = VG.reportToMarkdown(r);
  const { markdown: signed, ref } = await VG.signMarkdown(plain, r, KEY);

  check('reference code added', signed.indexOf('Report ref: ' + ref) !== -1, ref);
  check('watermark embedded', VG.zwExtract(signed) !== null, '');
  check('watermark is invisible to a reader',
    VG.stripZeroWidth(signed).length < signed.length, '');
  check('report still reads as plain english',
    VG.stripZeroWidth(signed).indexOf('Signing test') !== -1, '');

  const clean = await VG.verifyReportText(signed, KEY);
  check('untouched report verifies', clean.verdict === 'intact',
    clean.verdict + ' ref:' + clean.ref + ' wm:' + clean.watermark + ' ph:' + clean.phrasing);

  // Someone edits the headline number in the table.
  const tampered = signed.replace('| Prompts | 6 |', '| Prompts | 60 |');
  check('edited headline number is caught',
    (await VG.verifyReportText(tampered, KEY)).verdict === 'altered', '');

  // Someone edits a work-profile count.
  const row = signed.split('\n').find((l) => l.indexOf('| Software engineering |') === 0);
  const tampered2 = signed.replace(row, row.replace('| 2 |', '| 5 |'));
  check('edited work-profile count is caught',
    (await VG.verifyReportText(tampered2, KEY)).verdict === 'altered', row || '(row not found)');

  // Someone strips the invisible characters, e.g. by pasting through notepad.
  const stripped = VG.stripZeroWidth(signed);
  const strippedRes = await VG.verifyReportText(stripped, KEY);
  check('stripping the watermark still verifies via the other marks',
    strippedRes.verdict === 'intact-partial' && strippedRes.watermark === 'absent',
    strippedRes.verdict);

  // Someone strips the watermark AND edits a number.
  const both = VG.stripZeroWidth(tampered);
  check('stripped watermark plus edited number is still caught',
    (await VG.verifyReportText(both, KEY)).verdict === 'altered', '');

  // Someone removes the footer code and the watermark, leaving only prose.
  const proseOnly = VG.stripZeroWidth(signed).replace(/Report ref: VG-[0-9A-F-]+/i, '');
  const proseRes = await VG.verifyReportText(proseOnly, KEY);
  check('both strong marks gone reads as unverified, not as a pass',
    proseRes.verdict === 'unverified', proseRes.verdict);
  check('phrasing agreement is still reported for a human to weigh',
    proseRes.phrasing === 'pass' && proseRes.phrasingDetail.checked > 0,
    proseRes.phrasing + ' ' + JSON.stringify(proseRes.phrasingDetail));
  check('unverified verdict says so in plain english',
    proseRes.explanation.indexOf('cannot be settled') !== -1, proseRes.explanation.slice(0, 60));

  // Wrong key must not validate.
  check('a different key does not validate',
    (await VG.verifyReportText(signed, 'someone-elses-key')).verdict === 'altered', '');

  // An unsigned report is reported as unmarked, not as altered.
  check('unsigned report is never called altered',
    (await VG.verifyReportText(plain, KEY)).verdict === 'unverified',
    (await VG.verifyReportText(plain, KEY)).verdict);

  // A site whose label the verifier cannot map back to an id must still
  // verify — the verifier only ever has the document.
  const customSettings = Object.assign({}, s, {
    policyAdapters: [{ id: 'internal', label: 'Internal Assistant', hosts: ['ai.acme.example'] }]
  });
  const customEvents = events.concat([
    Object.assign(VG.newEvent(), {
      ts: now - day, day: VG.localDay(now - day), site: 'policy:internal',
      host: 'ai.acme.example', conversationHash: 'c9', turn: 1,
      workType: 'policy', workTypeLabel: VG.taxonomyById('policy').label
    })
  ]);
  const rc = VG.buildReport(customEvents, [], period, customSettings, customEvents, null);
  const sc = await VG.signMarkdown(VG.reportToMarkdown(rc), rc, KEY);
  check('a report containing a policy-pushed site still verifies',
    (await VG.verifyReportText(sc.markdown, KEY)).verdict === 'intact', '');

  check('figures rebuilt from the document match the source',
    JSON.stringify(VG.figuresFromMarkdown(signed)) === JSON.stringify(VG.canonicalFigures(r)),
    JSON.stringify(VG.figuresFromMarkdown(signed).slice(0, 3)));

  await uploadPayloadChecks();

  console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
