# Vantage

A browser extension that measures how you actually use AI chat tools. Which tools, how much, what kind of work, and whether the answers were any use. It turns that into a weekly or monthly report you can read, download or email.

Sensitive values are masked in the page before anything is stored. By default nothing leaves the device.

Works with Claude, ChatGPT, Gemini and Microsoft Copilot out of the box. Any other AI site is one config entry away.

Manifest V3. One build serves both Edge and Chrome.

## Contents

- [What it reads from the page](#what-it-reads-from-the-page)
- [What it captures](#what-it-captures)
- [Work categories](#work-categories)
- [Metrics](#metrics)
- [Redaction](#redaction)
- [Install](#install)
- [Reports](#reports)
- [Scheduled upload](#scheduled-upload)
- [Report integrity](#report-integrity)
- [Adding another AI site](#adding-another-ai-site)
- [Organisation attribution](#organisation-attribution)
- [Enterprise deployment](#enterprise-deployment)
- [Building](#building)
- [Testing](#testing)
- [Contributing](#contributing)

## What it reads from the page

A content script on an AI site can read anything on that site. That is the central risk in this class of tool, so here is the full inventory of what this one touches. `minimal` is the default scope.

| What | `minimal` (default) | `standard` (opt in) |
| --- | --- | --- |
| The composer you type in | Read, then redacted in the page before storage | Read |
| Model switcher button label | Read, 60 characters | Read |
| Project, GPT or Gem name | Read, then passed through your wordlist | Same |
| Whether selectors match | Presence and count only | Same |
| That the page changed after submit | Mutation events only, no content read | Same |
| That you copied something | The copy event only, selection never materialised | Selection read, characters counted |
| The model reply | Never read | Read to measure length and detect code |
| Account menu address | Never read | Read, domain compared, address discarded |

Under `minimal` the composer is the only place text is read. Response timing still works because the start and end of mutation activity are structural facts. Copy rate still works because the rate is the metric, not the character count. The mutation observer is scoped to the assistant turn container where one can be found rather than the whole thread.

`standard` adds three things and nothing else: response length, a code block flag, and corporate versus personal detection from the account domain. Pin `domScope` to `minimal` in policy unless you need those.

### What it never captures

- Response text. Under `minimal` it is not read at all. Under `standard` it is measured and discarded. It is never stored under either.
- Page content outside the composer, the message thread and the labelled elements above.
- Anything on sites without an adapter.
- Anything over the network unless an administrator turns on scheduled upload. With upload off the extension makes no network request of any kind.

There is no browser side alternative to reading the DOM. The other route is intercepting `fetch`, which exposes full request and response bodies including uploaded files. For sanctioned tools there is a route that touches no DOM at all, which is the vendor admin APIs. This extension earns its place on the shadow AI and personal account traffic those APIs cannot see.

To check the inventory yourself:

```
grep -n "innerText\|textContent\|querySelector\|getSelection\|MutationObserver" \
  src/content/capture.js src/core/surfaces.js src/core/adapters.js
```

## What it captures

One record per prompt, written on submit.

| Field | Notes |
| --- | --- |
| Timestamp, site, model label | Model read from the site own switcher, best effort |
| Conversation hash, turn number | The conversation id is hashed, the raw id is never stored |
| Surface | Plain chat, Project, custom GPT, Gem or agent, plus concurrent Canvas, Deep Research, code interpreter and search flags |
| Agent key, name, type, shared | The agent id is hashed. The display name passes through your wordlist |
| Prompt length in characters and words | |
| Work category, confidence, second intent | Classified on device |
| Redaction hits by type | Counts only, for example `{email: 2, national_id: 1}` |
| Attachments at submit | |
| Time to first token, total response time | From mutation events, no content read |
| Response length and code flag | `standard` scope only. Measured, never stored |
| Regenerate count | |
| Copy out | Event count always. Substantial flag from selection geometry, not text. Character count under `standard` only |
| Self reported minutes saved | Only when the point of use prompt is enabled and answered |
| Prompt text | Only at the `redacted` or `full` capture level |

### Surfaces detected per platform

| Platform | Primary surfaces | Concurrent flags |
| --- | --- | --- |
| Claude | Project, with id and name | Artifact, Connector or MCP, Research mode |
| ChatGPT | Project, custom GPT, with id and name | Canvas, Deep research, Agent mode, Code interpreter, Web search |
| Gemini | Gem, with id and name | Deep research, Canvas |
| Microsoft Copilot | Copilot agent | Notebook, Work grounding |

Surface rules are declarative. Regex strings plus CSS selectors, so the whole map is JSON and can be pushed centrally without a new build. See `surfaces` in `policy/managed_schema.json`.

This is what turns "1,400 prompts" into "38 percent of prompts run through six shared agents, two of which nobody has touched since June".

## Work categories

Prompts are scored against a keyword and pattern taxonomy that runs entirely on device. No model, no network call, and every rule is readable in `src/core/schema.js`.

`drafting` `comms` `policy` `comprehension` `translation` `coding` `data` `procurement` `support` `research` `media` `learning` `admin` `hr` `appraisal` `legal` `personal` `other`

Eighteen categories. Four splits are deliberate.

| Split from | Into | Reason |
| --- | --- | --- |
| `drafting` | `comms` | Press releases, media queries, key messages, speeches and campaigns were invisible inside drafting |
| `hr` | `appraisal` | Appraisal season is a concentrated and sensitive spike. Folded into HR it disappears into a flat line |
| `drafting` and `policy` | `hr`, `legal` | Their vocabulary was inflating the two largest categories |
| `admin` | `personal` | So the report can answer whether the tool is being used for work. `admin` is now work admin only |

Tune the taxonomy for your vocabulary under Settings, Work categories, Extra keywords:

```json
{ "policy": [["board paper", 6], ["executiveial brief", 6]],
  "procurement": [["ariba", 6], ["RFI", 5]] }
```

### How the classifier decides

1. Weighted terms and patterns per category, with log damping so a word repeated ten times is not ten times the signal.
2. Anti patterns subtract. "IAM policy" and "bucket policy" are engineering rather than policy work. "Smart contract" is not procurement. Anything containing a code fence is not personal. These collisions are the main source of false positives in an enterprise vocabulary and they are handled explicitly.
3. Length damping. Scores are divided by the square root of words over 80, above 80 words, so a long paste cannot drift into whichever category has the most terms.
4. Second intent. Many prompts do two jobs, such as summarise this then translate it. When the runner up scores within 60 percent of the winner it is kept as `workTypeSecondary`.
5. Thread context inheritance. Short follow up turns like "make it shorter" or "now in Malay" carry no signal of their own. Rather than falling into Uncategorised they inherit the topic the conversation has established, at 70 percent of its confidence, marked `workTypeSource: inherited`. Turn 1 never inherits and a confident turn never inherits.
6. Confidence is a relative margin, not a probability. The report labels it as such.

Every report carries a classification quality block covering uncategorised rate, inherited rate, low confidence rate and second intent count. The work profile is never quoted without its own error bars. Above 20 percent uncategorised, tune the vocabulary before quoting anything.

The contract is `VG.classify(text, settings)` returning `{id, label, confidence, runnerUp, secondary, nonWork, scores}` plus `VG.applyContext(result, threadContext, turn)`. Replace `src/core/classify.js` with a model backed implementation and nothing else changes.

## Metrics

The report separates figures that can be defended from figures that cannot.

**Denominator only.** Total prompts, licences assigned, adoption percentage. These rise during the novelty period and fall afterwards regardless of value. They size the population and prove nothing.

**Sustained use.** Active weeks out of the last six, where four or more counts as sustained. Active days out of 28. Trajectory over eight weeks. A tool nobody returns to has no value however many prompts week one produced.

**Depth.** Turns per conversation, follow up rate, attachment rate, p50 and p90 prompts per active day, repeat task rate, surface breadth.

**Output actually used.** Copy out rate and volume, task completion rate, rework rate. These are the strongest behavioural proxies available and they remain proxies.

**Value.** A one tap question at the moment output is copied out, asking how much time it saved. Sampled, rate limited, off by default. The estimate extrapolates over substantial copies only, since a one word copy is not evidence a task was completed and counting it multiplies straight into the headline. Substantiality is judged from the selection geometry so no text is read to decide it. The report shows a range, being the mean plus or minus 1.96 standard errors times the number of substantial copies, with a confidence label of `none`, `insufficient` under 20 responses, `indicative` under 50, or `reportable`.

**Risk trend.** Share of prompts requiring masking, by type, over time.

**Automation candidates.** Recurring category chains, repeated prompt openings, and cross tool handoffs inside 30 minutes.

### Small samples

Below 30 prompts in a period the report withholds percentages and prints counts instead. Below 10 it says so prominently and the executive summary leads with the adoption funnel rather than value.

At low volume three further blocks carry more information than the work profile does.

- Untapped categories, meaning the ones with zero use. This is the map of work nobody has brought to the tool yet.
- First attempts, being copy out and retry rate across the earliest ten prompts. If nothing from someone first attempts was used, that is the likeliest reason they did not return, and it is invisible in a volume chart.
- Lapse detection, being days since last use, flagged at 14 or more.

### What the data cannot tell you

Every report prints this under the numbers.

- One device, one person. Fleet totals require aggregating exports or pairing with vendor admin APIs.
- No counterfactual. Without a staggered rollout or a matched comparison group, none of this shows what would have happened anyway. Where a staggered rollout is not possible, natural variation in adoption timing supports an event study using each person own pre adoption weeks as their baseline.
- Time saved is self reported at the moment of use.
- Browser only. Desktop apps, IDE assistants and API usage are invisible.
- Redaction detects known formats. Sensitive free text matching no pattern is not caught.
- Work categories come from a keyword classifier, not a human.

## Redaction

Built in detectors cover private keys, JWTs, AWS, Google, Slack, GitHub and provider API keys, assigned secrets such as password assignments, URLs carrying credentials, email addresses, checksum validated national identity numbers, payment cards with Luhn validation, phone numbers, IP addresses and IBANs. Opt in detectors cover postal codes, long numeric identifiers and UUIDs.

Two organisation level additions:

- An always mask term list for project names and codenames, one per line.
- Custom patterns as a JSON array of id, label, pattern, flags and replacement. A malformed entry is ignored rather than fatal.

Redaction runs in `src/content/capture.js` before the event object is constructed, so the unredacted string never crosses a message boundary to the service worker.

## Install

For development:

1. Open `edge://extensions` or `chrome://extensions`
2. Enable Developer mode
3. Choose Load unpacked and select this folder
4. The options page opens on first install

Open Claude, ChatGPT or Gemini and send a prompt. The toolbar badge shows the count for today.

To see a populated report immediately, use Settings, Sample data, Load sample data. Sample rows are flagged and the report banners them so a demonstration cannot be mistaken for real numbers.

## Reports

Open from the popup or `src/ui/reports.html`.

Periods available are this week, last week, this month, last month, last 30 days, all time, and a custom range.

The report contains an executive summary of five questions each answered with its method attached, a written narrative, headline tiles with period over period deltas, a daily volume chart, work profile and tool breakdowns, sustained use, platform surfaces and named agents, self reported value, automation candidates, governance, classification quality, and the redaction breakdown.

Export as Markdown, CSV at event level, JSON, or print to PDF. The email button opens your own mail client with the summary filled in. The extension sends nothing itself.

## Scheduled upload

Off by default. When an administrator enables it, finished reports are posted to an endpoint you control on a cadence you set.

It does not depend on an AI site being open, or on any tab being open. The trigger is a service worker alarm checked hourly. A due check with nothing to do costs nothing.

| Policy key | Purpose |
| --- | --- |
| `uploadEnabled` | Master switch, off unless set here |
| `uploadUrl` | HTTPS endpoint such as a collector, blob store or API gateway |
| `uploadAuthHeader` | Sent verbatim as the Authorization header |
| `uploadCadence` | `daily`, `weekly` or `monthly` |
| `uploadContent` | `summary`, `aggregate` which is the default, or `events` |
| `uploadIncludePromptText` | Additional gate on top of `events` |

Every one of these is policy only. `VG.settings.set` refuses them, so neither the options page nor a message from a content script can enable uploads, redirect them or widen what they contain.

Scheduling is catch up rather than fire and forget. The uploader works out which completed periods have not been sent and sends the oldest first, one per wake, up to eight periods back. A browser closed for three weeks sends the three missed weeks on its next run. The period in progress is never sent. Failures back off exponentially to a 24 hour ceiling and a sent period is recorded so it is never sent twice.

The payload is signed with the same key as an exported report so a receiver can distinguish a genuine push from a fabricated one.

Two things are needed beyond policy. The CSP allows `connect-src https:`, but the real gate is a host permission for your endpoint origin. Either add it to `host_permissions` in an internally packaged build, which is the clean route for a central push, or grant it through the `ExtensionSettings` policy using `runtime_allowed_hosts`. Without it nothing is sent and the options page says so.

When upload is enabled the options page shows a panel that cannot be hidden, naming the destination host, the cadence, what each upload contains, when the last one went and what is queued. If prompt text is included it says so in warning colour. Staff who cannot see where their data goes will route around the tool, and then it measures nothing.

## Report integrity

Exported reports are readable plain text. This is not encryption. They carry three marks derived from an HMAC over the report own numbers, so that editing a figure and passing the document on is detectable.

| Mark | Location | Survives |
| --- | --- | --- |
| Reference code | A short reference in the footer | Everything short of deleting the line |
| Zero width watermark | Invisible characters in the narrative | Copy and paste between most editors. Not retyping or a plain text cleaner |
| Phrasing bits | Eight either or wordings chosen by the digest | Format conversion and retyping |

Either of the first two catches an edited number on its own. The phrasing bits cannot. An unsigned report carries all the default wordings and the expected bits are effectively random, so phrasing alone cannot separate never signed from signed then altered. It is reported as corroborating evidence and never drives a verdict.

Verdicts are `intact`, `intact-partial` where a mark was lost but the survivors agree, `altered`, and `unverified` where neither strong mark is present.

To verify, use Settings, Report integrity, paste the report, Verify. Or from a terminal:

```
node tools/verify-report.js report.md --key <signing key>
```

Push one `reportSigningKey` organisation wide and a single verifier checks reports from every device. Without a pushed key each install generates its own on first run and only that install can verify its own output. Treat the key as a secret. Anyone holding it can verify a report and can also produce one that passes. This defends against casual alteration of a circulated document, not against a determined forger who has the key.

## Adding another AI site

In the UI, use Settings, Sites, Add a custom site. A name and hostname are enough since the generic detector handles any editable composer. Adding a site requests host permission and nothing is captured until it is approved.

In code, append to `VG.BUILTIN_ADAPTERS` in `src/core/adapters.js`:

```js
{
  id: 'mytool',
  label: 'Internal Assistant',
  colour: '#0F766E',
  hosts: ['ai.acme.example'],
  selectors: {
    composer: ['div[contenteditable="true"].composer'],
    send:     ['button[data-testid="send"]'],
    thread:   ['main'],
    userTurn: ['[data-role="user"]'],
    assistantTurn: ['[data-role="assistant"]'],
    model: [], regenerate: [], attachment: []
  },
  conversationId: (url) => url.pathname
}
```

Every selector field is a list tried in order. When a vendor ships a UI change you add one string and older selectors keep working for anyone on a stale build.

### Verifying selectors against a live site

Selectors are the part of this that can silently rot when a vendor changes their UI. Two checks, both read only. They report which CSS selectors resolve and nothing else.

Before the extension is installed, use `tools/selector-probe.js`:

1. Open the site and sign in.
2. Open a conversation that already has at least one exchange in it.
3. Type a few characters into the composer and leave them there.
4. Open DevTools, go to Console, paste the whole file and press Enter.

Steps 1 to 3 are not optional. On a signed out page nothing resolves. On an empty chat the turn, regenerate and attachment selectors cannot match. On several of these sites the send button does not exist until the composer has text. The probe detects all three and marks those checks as not applicable rather than missing, but it cannot check what is not on screen.

Verdicts are healthy where every selector matched first choice, degraded where capture works but some metrics are missing, and broken where the composer or send did not resolve.

Regenerate the probe after changing adapters with `node tools/make-probe.js`.

With the extension installed, against the real sites:

```
node tools/probe-live.js
SEND=1 node tools/probe-live.js
```

The second form also sends one throwaway prompt per site and confirms it was captured. The profile persists in `.playwright-profile/` so the sign in is one off. It holds real session cookies. Delete it when finished.

After install, the popup has a Check this page button running the same check against the adapter the device is actually using, including anything pushed by policy.

### Site config distribution

Site definitions merge in a fixed precedence so the three channels do not conflict.

| Precedence | Channel | How it arrives |
| --- | --- | --- |
| 1 | Central push | Writes `policyAdapters` and `siteConfigVersion` into browser policy. Locked in the UI and marked as policy. No network call from the extension, since the browser policy engine delivers it |
| 2 | Added in the plugin | Settings, Sites, Add a custom site. Requests host permission and registers the content script dynamically. Dropped if a policy entry claims the same id |
| 3 | Store update | Built ins in `adapters.js`, refreshed when the extension updates |

Settings shows the built in config revision and the pushed `siteConfigVersion` side by side.

Each covered page load reports whether the composer selector still resolved. Settings marks every site as capturing, visited with nothing captured yet, or composer not found meaning the selector may be stale. That is how a vendor DOM change is found in days rather than after a month of empty reports.

## Organisation attribution

No form for anyone to fill in. Two mechanisms, either or both.

| Mechanism | How it works | Use when |
| --- | --- | --- |
| Pushed value | `orgUnit`, `orgDivision` and `orgCohort` in policy | Your push can target groups |
| Domain lookup | One `orgDomainMap` pushed identically to everyone. Each device resolves its own business unit from the domain of the signed in browser profile | Your push goes uniformly to every business unit |

```json
"orgDomainMap": {
  "eng.acme.example": "Engineering",
  "sales.acme.example": "Sales"
}
```

The domain lookup needs the optional `identity.email` permission and `deriveIdentity` set to true. It keeps the domain, hashes the address into a stable pseudonymous device key, and discards the address. The device key allows a fleet rollup to deduplicate devices without anyone logging in.

Division below business unit is not derivable from a domain. Either target it in the push or leave it blank.

### Corporate versus personal accounts

`accountTier` per prompt is one of `enterprise`, `team`, `personal` or `unknown`. Under `standard` scope it is read from the site own account menu, comparing the domain against `corporateDomains` and then discarding it. The address is never stored. Under `minimal` scope only the plan or workspace badge is used.

This answers whether enterprise licences are actually being used. The governance block reports personal account share and non work share together.

## Enterprise deployment

The extension ID is `nnnkddpplabnomlnaolmicnanjphpibp`, fixed by the public key embedded in `manifest.json` and verified against what Chrome assigns. Policy can be written against it before anything ships.

```
HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist
  1 = "nnnkddpplabnomlnaolmicnanjphpibp;https://internal.host/vantage/updates.xml"

HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\nnnkddpplabnomlnaolmicnanjphpibp\policy

; only if scheduled upload is used, avoids a permission prompt
HKLM\Software\Policies\Microsoft\Edge\ExtensionSettings
  {"nnnkddpplabnomlnaolmicnanjphpibp": {"runtime_allowed_hosts": ["*://collector.example.com"]}}
```

Chrome is identical with `\Google\Chrome` in place of `\Microsoft\Edge`.

Example policy payload:

```json
{
  "captureLevel": "redacted",
  "domScope": "minimal",
  "allowFullText": false,
  "retentionDays": 90,
  "showCaptureToast": true,
  "sensitiveWordlist": ["Project Kingfisher"],
  "extraTaxonomyTerms": { "policy": [{ "term": "board paper", "weight": 6 }] },
  "orgDomainMap": { "eng.acme.example": "Engineering" },
  "deriveIdentity": true,
  "reportEmailTo": "ai-programme@acme.example",
  "weekStartsOn": 1,
  "siteConfigVersion": "2026-09-05-a",
  "valueSurveyEnabled": true,
  "valueSurveySamplePercent": 8,
  "uploadEnabled": false
}
```

The full key list and types are in `policy/managed_schema.json`. Note that the browser policy schema parser is stricter than JSON Schema. It rejects tuple form `items` and fractional number properties, which is why extra taxonomy terms are objects and the sample rate is an integer percent.

Keep `showCaptureToast` on. Staff seeing a capture confirmation at the moment it happens is what makes this a measurement tool rather than surveillance.

If this is deployed across a fleet, the numbers are adoption analytics rather than a security control. Report them in aggregate with a minimum group size and keep that lane separate from any DLP or investigation lane.

## Building

```
node tools/build.js
CODEBASE=https://intranet.example.com/vantage node tools/build.js
```

Produces in `dist/` a zip for the Edge Add-ons or Chrome Web Store, a signed crx for self hosting, and the `updates.xml` that `ExtensionInstallForcelist` points at. The build refuses to run if the manifest has no stable key, the signing key is missing, or the CSP and host permissions have drifted.

`keys/vantage.pem` is the private half and is gitignored. Back it up. It fixes the extension ID and the ID is what every deployed policy is keyed on. Losing it produces a new ID and every deployed policy silently stops applying.

## Testing

```
node tests/smoke.js         # 146 unit checks, no browser
node tools/e2e-fixture.js   # 57 end to end checks, real extension in Chromium
```

The unit suite covers redaction including false positive guards, the classifier across all categories, classifier disambiguation and thread context inheritance, surface and custom GPT, Gem and Project detection, account tier detection under both DOM scopes, config source precedence, low volume behaviour, report aggregation, the value estimator, report signing and tamper detection, and upload scheduling and payload gating.

The end to end suite loads the real unpacked extension into Chromium, serves a fixture at `https://chatgpt.com/` so the adapter matches on hostname, types prompts the way a person would, then reads what the extension wrote to its own IndexedDB. It covers manifest acceptance, content script attachment, both submit paths, redaction, classification, thread context inheritance, surface and agent detection, response timing, DOM scope enforcement in both modes, report signing, and a scheduled upload firing from the service worker with no AI site open.

Set `HEADED=1` to watch the end to end run in a window.

## Layout

```
manifest.json              MV3, no build step, no bundler, no CDN
policy/managed_schema.json enterprise policy keys
src/core/
  schema.js                taxonomy, defaults, event shape, date helpers
  surfaces.js              platform surface, agent and account detection
  redact.js                detectors and redaction engine
  classify.js              on device work type classifier
  adapters.js              per site selector registry
  db.js                    IndexedDB and settings
  report.js                aggregation, written summary, CSV and Markdown export
  sign.js                  tamper evidence marks and verification
  upload.js                scheduling, catch up and payload gating
  demo.js                  sample data generator
src/content/capture.js     the only code that touches page content
src/background/service-worker.js  message router, retention, badge, uploader
src/ui/                    popup, reports, options
tools/                     build, probes, report verifier
tests/smoke.js             unit checks
```

Everything is plain script attached to a `VG` namespace. No transpiler and no minification, so what ships is what a reviewer reads.

## Not built yet

- Central aggregation across a fleet. Until it exists, fleet numbers come from collecting per device exports, from the scheduled upload, or from pairing this with vendor admin APIs.
- A database migration path. `DB_VERSION` is still 1 while the event schema is at 4. Rows written by older builds tolerate this through fallbacks, but a real migration is needed before a second version reaches a fleet.
- Desktop app coverage for Claude Desktop, ChatGPT desktop and IDE assistants. A browser extension cannot see these.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go through [SECURITY.md](SECURITY.md) rather than the public tracker.

## License

MIT. See [LICENSE](LICENSE).
