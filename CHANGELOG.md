# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
