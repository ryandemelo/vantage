# Contributing

Thanks for taking a look. This document covers how to get set up, what the project cares about, and how to get a change merged.

## Getting set up

You need Node 18 or later. The extension itself has no dependencies and no build step. Playwright is used only for the test harness.

```
npm install
npx playwright install chromium
node tests/smoke.js
node tools/e2e-fixture.js
```

Load the extension with Load unpacked from `edge://extensions` or `chrome://extensions`, pointing at the repository root.

### A note on automated browser testing

Recent stable Chrome and Edge no longer honour the `--load-extension` command line switch. Passing it is silently ignored and the extension does not appear, with no error. A minimal test extension behaves the same way, so if you see this it is the browser rather than your change.

This affects automated testing only. Loading through the Load unpacked button works normally, and so does force installing through enterprise policy.

`tools/e2e-fixture.js` and `tools/probe-live.js` therefore use the Chromium build that Playwright downloads, which still accepts the switch. It is the same engine as the shipping browsers. Do not switch them to a locally installed Chrome or Edge, because they will report zero extensions loaded and every check after that will fail for the wrong reason.

## What this project cares about

Read these before proposing a change. They are the constraints that shaped most of the code.

**The DOM read surface stays small.** A content script on an AI site can read the whole page. The default scope reads the composer and nothing else. Response timing comes from mutation events rather than response text. Copy detection uses the copy event and selection geometry rather than the selected text. If your change reads something new from the page, say so in the pull request and explain why the metric cannot be obtained another way.

**Nothing leaves the device by default.** The scheduled uploader is the only network path and it is off unless an administrator enables it through policy. Settings that control where data goes are policy only and the code refuses to set them from the UI.

**Numbers are reported with their method attached.** The report withholds percentages on small samples, labels confidence, and prints a list of what the data cannot show. A change that makes a figure look better without making it more true will not be merged.

**No build step.** Plain script files attached to a `VG` namespace, loaded in order. No transpiler, no bundler, no minification, no CDN. What ships is what a reviewer reads. This is deliberate and is not up for negotiation.

**Tests are evidence, not decoration.** A regression test should fail if you reintroduce the bug. Check that it does before you submit.

## Branches and commits

Work happens on a branch. Do not commit to `main`.

Branch names use a type prefix.

```
feat/gemini-canvas-detection
fix/first-token-timing
docs/contributing
chore/bump-playwright
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).

```
feat(adapters): detect Gemini canvas surface
fix(capture): correct time to first token on later turns
docs(readme): describe the minimal DOM scope
test(classify): cover anti pattern disambiguation
```

Scopes in use are `core`, `capture`, `adapters`, `classify`, `redact`, `report`, `sign`, `upload`, `ui`, `background`, `tools`, `policy`, `docs` and `test`.

Keep the subject under 72 characters and in the imperative. Explain why in the body when the reason is not obvious from the diff.

## Pull requests

1. Fork, or branch if you have write access.
2. Make the change, with tests.
3. Run both suites. Both must pass.
4. Open a pull request against `main` using the template.

A pull request that changes what is read from the page, what is stored, or what is sent anywhere needs that stated explicitly in the description. Reviewers will look for it.

## Site adapters

The most common contribution is fixing a selector after a vendor changes their UI. This is expected and welcome.

1. Run `tools/selector-probe.js` in the console on the affected site, following the steps in the README. The context requirements matter, otherwise the output is meaningless.
2. Add the new selector to the front of the relevant list in `src/core/adapters.js`. Do not remove the old ones. Older selectors keep working for anyone on a stale build.
3. Bump the adapter `revision` and `VG.CONFIG_REVISION`.
4. Run `node tools/make-probe.js` to regenerate the standalone probe.
5. Include the probe output in the pull request.

## Adding a work category

Categories live in `VG.TAXONOMY` in `src/core/schema.js`. A new one needs to earn its place by taking prompts that are currently being misfiled, not by subdividing something that already works.

Include anti patterns for any vocabulary that collides with an existing category. Add classifier test cases to `tests/smoke.js` covering both the new category and the collisions.

## Reporting problems

Use the issue templates. For a broken site adapter there is a dedicated template that asks for the probe output, which is what makes the report actionable.

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## Code style

Match the file you are editing. Two space indent, single quotes, semicolons.

Comments explain why, not what. If a piece of code exists because of a specific browser behaviour, a vendor quirk or a privacy constraint, write that down. Several parts of this codebase look odd until you know the reason.
