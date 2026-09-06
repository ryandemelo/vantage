# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.4.0] - 2026-09-06

### Fixed

- Requests built as a `Request` object with no separate init were skipped entirely. Such a request carries its body as a stream rather than a string, so there was nothing for the hook to inspect and the prompt was missed silently. The request is now cloned and the copy read, leaving the original untouched. Only same origin POSTs are cloned.

### Added

- A test suite for the script that patches `fetch` and `XMLHttpRequest` in the site's own context. It checks that the page keeps working, that failures still reject, that `fetch` still reports itself as native, and that cross origin requests, form data, non JSON bodies and oversized bodies never leave the page. This is what found the missed request shape.
- Deployment policy generation for Windows, macOS and Linux, for both Edge and Chrome, from one validated payload.

## [0.3.0] - 2026-09-06

### Added

- The prompt is read from the request the site sends rather than from the rendered page. Rules are declarative and pushable through policy. The page reading path remains as a fallback for sites without a rule, currently Gemini.
- `captureSource` on every event, recording which path saw the prompt.
- The selector probe reports the elements that are actually present when a selector misses.

### Fixed

- Claude assistant turn selector reordered from a live probe on a signed in conversation. The two that led the list no longer resolve and the third does, so it now leads. Turn counting, response measurement and conversation depth depended on it.
- ChatGPT model selector reordered for the same reason.

### Added

- The selector probe reports the elements that are actually present when a selector misses, so a fix can be made from one report rather than another round trip to a signed in page.

## [0.2.0] - 2026-09-05

### Added

- Database migration. The store now opens at version 2 and rewrites rows written by an earlier build into the current event shape, filling fields added since. Copy counts are derived from the character count those rows recorded, using the threshold that applied when they were written.
- `VG.db.close()`, so a caller that needs to delete or upgrade the database can release the connection first.

### Fixed

- Three sentences in the report narrative read as comma splices after the punctuation cleanup.

## [0.1.0] - 2026-09-05

First public release.

### Added

- Prompt capture for Claude, ChatGPT, Gemini and Microsoft Copilot, with a declarative adapter per site.
- Detection of the platform surface a prompt was sent to, covering Projects, custom GPTs, Gems and agents, plus concurrent Canvas, Deep Research, code interpreter and search flags.
- On device redaction covering keys, tokens, secrets, email addresses, checksum validated national identity numbers, payment cards with Luhn validation, phone numbers, IP addresses and IBANs, plus organisation wordlists and custom patterns.
- On device work type classifier over eighteen categories, with anti patterns, length damping, second intent and thread context inheritance.
- Two DOM read scopes, with `minimal` as the default. Under `minimal` the composer is the only text read.
- Weekly, monthly and custom period reports with an executive summary, sustained use, depth, output use, self reported value, governance, classification quality and automation candidates.
- Small sample guards that withhold percentages below thirty prompts and reorient the report toward the adoption funnel below ten.
- Point of use value survey, sampled and rate limited, off by default.
- Report tamper evidence using a reference code, a zero width watermark and phrasing bits, with a verifier in the UI and a command line tool.
- Scheduled upload to an internal endpoint, off by default, driven by a service worker alarm so it does not require an AI site to be open. Catch up scheduling, exponential backoff and a transparency panel.
- Organisation attribution from pushed policy or from the signed in profile domain.
- Enterprise policy schema, a stable extension ID and a build producing zip, crx and update manifest.
- Selector probes for use before and after install, and a config health view that surfaces stale selectors.
