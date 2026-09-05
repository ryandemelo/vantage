# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
