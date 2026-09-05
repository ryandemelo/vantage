# Security policy

## Reporting a vulnerability

Do not open a public issue.

Report privately through GitHub Security Advisories on this repository, using the Report a vulnerability button under the Security tab.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get an acknowledgement within a few days.

## Scope

This extension runs on pages where people type sensitive material. The following are treated as security issues rather than bugs.

- Any path where unredacted prompt text reaches storage, a message boundary or the network.
- Any way to widen the DOM read scope without the policy setting that gates it.
- Any way for a page, a content script or the options page to set a policy only value, particularly the upload destination.
- Any way to disable redaction, the capture indicator or the transparency panel without policy.
- Any way to forge a report that passes verification without the signing key.
- Cross site scripting in the options or reports pages, including through pushed policy values such as site labels or agent names.

## Not in scope

- The extension reads the composer on sites it is configured for. That is what it does and it is documented in the README.
- Someone holding the report signing key can produce a report that verifies. The threat model covers casual alteration of a circulated document, not a forger who has the key.
- Selectors going stale after a vendor UI change. That is a maintenance issue. Use the adapter issue template.

## Handling of secrets

`keys/vantage.pem` fixes the extension ID and is gitignored. It is never committed. If you believe it has been exposed, report it privately rather than opening an issue, because rotating it changes the extension ID and breaks every deployed policy.
