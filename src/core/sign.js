/*
 * Vantage — sign.js
 * Tamper-evidence for exported reports.
 *
 * This is NOT encryption and does not claim to be. The report stays fully
 * readable. What it adds is three independent marks derived from an HMAC over
 * the report's own numbers, so that changing a figure and handing the document
 * on is detectable:
 *
 *   1. Reference code  — a short "Report ref: VG-XXXX-XXXX-XXXX" in the footer.
 *                        Looks like an ordinary document reference.
 *   2. Zero-width mark — the digest encoded in invisible characters inside the
 *                        narrative. Survives copy-paste between most editors,
 *                        does not survive being retyped or run through a
 *                        plain-text cleaner.
 *   3. Phrasing bits   — eight either/or wordings in the narrative, chosen by
 *                        the digest. Survives format conversion and retyping,
 *                        and is the mark an editor is least likely to notice.
 *
 * Either of the first two marks catches an edited number on its own. The
 * phrasing bits CANNOT: an unsigned report carries the default wordings, and
 * the expected bits are effectively random, so phrasing on its own cannot tell
 * "never signed" from "signed then altered". It is therefore treated as
 * corroborating evidence only, never as a verdict — a check that cries wolf on
 * unsigned documents would be worse than no check.
 *
 * Someone who has the key and understands the scheme can of course regenerate
 * all three marks. This defends against casual alteration of a circulated
 * report, not against a determined forger holding the key.
 *
 * The key comes from policy (`reportSigningKey`) so a central verifier can
 * check any report from any device. Without a pushed key each install
 * generates its own, and only that install can verify its own reports.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  const ZERO = '​';   // zero-width space      -> bit 0
  const ONE = '‌';    // zero-width non-joiner -> bit 1
  const FENCE = '‍';  // zero-width joiner     -> start/end fence
  const ZW_RE = /[​‌‍]/g;

  /* ------------------------------------------------------------------ *
   * Canonical figures — the numbers the marks are computed over. Order is
   * fixed, and every one of them is printed somewhere in the markdown, so a
   * verifier can rebuild this list from the document alone.
   * ------------------------------------------------------------------ */
  VG.canonicalFigures = function (r) {
    const f = [];
    const push = (k, v) => f.push(k + '=' + (v === null || v === undefined ? '' : v));

    push('prompts', r.totals.prompts);
    push('conversations', r.totals.conversations);
    push('activeDays', r.totals.activeDays);
    push('perActiveDay', r.totals.promptsPerActiveDay);
    push('avgTurns', r.usability.avgTurnsPerConversation);
    push('followUp', r.usability.followUpRate);
    push('medianWords', r.usability.medianPromptWords);
    push('maskedPrompts', r.risk.promptsWithSensitive);
    push('maskedPct', r.risk.pctWithSensitive);
    push('nonWork', r.compliance.nonWorkPrompts);
    push('personalAcct', r.compliance.personalAccountRate);

    // Keyed by the LABEL that the document prints, not the internal id: a
    // verifier only has the document, and a policy-pushed site's label cannot
    // be mapped back to its id from the markdown alone.
    // Counts only. Shares are withheld from the document at low volume, and
    // are derivable from the counts anyway — signing over something the
    // document does not always print would make verification fragile.
    const clean = (t) => String(t).replace(/=/g, '');
    r.workTypes.forEach((w) => push('wt:' + clean(w.label), w.count));
    r.sites.forEach((x) => push('site:' + clean(x.label), x.count));
    return f;
  };

  /* ------------------------------------------------------------------ *
   * HMAC
   * ------------------------------------------------------------------ */
  async function hmacHex(message, key) {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey(
      'raw', enc.encode(String(key || 'vantage-unsigned')),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  VG.digestFor = async function (figures, key) {
    return hmacHex(figures.join('\n'), key);
  };

  VG.refCode = function (digest) {
    const h = digest.slice(0, 12).toUpperCase();
    return 'VG-' + h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12);
  };

  /* ------------------------------------------------------------------ *
   * Zero-width channel
   * ------------------------------------------------------------------ */
  function toBits(hex, chars) {
    let bits = '';
    for (let i = 0; i < chars; i++) {
      const v = parseInt(hex[i], 16);
      bits += v.toString(2).padStart(4, '0');
    }
    return bits;
  }

  VG.zwEncode = function (digest) {
    const bits = toBits(digest, 16); // 64 bits
    return FENCE + bits.split('').map((b) => (b === '1' ? ONE : ZERO)).join('') + FENCE;
  };

  VG.zwExtract = function (text) {
    const m = String(text).match(/‍([​‌]+)‍/);
    if (!m) return null;
    const bits = m[1].split('').map((c) => (c === ONE ? '1' : '0')).join('');
    if (bits.length % 4 !== 0) return null;
    let hex = '';
    for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  };

  VG.stripZeroWidth = function (text) {
    return String(text).replace(ZW_RE, '');
  };

  /* ------------------------------------------------------------------ *
   * Phrasing channel — eight either/or wordings picked by the digest.
   * `a` is the wording summarise() produces; `b` is the alternative.
   * ------------------------------------------------------------------ */
  VG.PHRASE_VARIANTS = [
    { a: ', across ', b: ', spanning ' },
    { a: 'Tool mix: ', b: 'Tool split: ' },
    { a: 'Work profile is led by ', b: 'Work profile is dominated by ' },
    { a: 'Engagement depth: ', b: 'Depth of engagement: ' },
    { a: 'Sustained use: active in ', b: 'Sustained use: recorded activity in ' },
    { a: 'The original values were never written to disk.', b: 'The original values were never stored on disk.' },
    { a: 'Peak usage sits in the ', b: 'Usage peaks in the ' },
    { a: 'Automation candidates: ', b: 'Candidates for automation: ' }
  ];

  function phraseBits(digest) {
    // Byte 8 of the digest, one bit per variant.
    const byte = parseInt(digest.slice(16, 18), 16);
    return VG.PHRASE_VARIANTS.map((_, i) => (byte >> i) & 1);
  }
  VG.phraseBits = phraseBits;

  VG.applyPhrasing = function (text, digest) {
    const bits = phraseBits(digest);
    let out = String(text);
    VG.PHRASE_VARIANTS.forEach((v, i) => {
      if (bits[i] === 1) out = out.split(v.a).join(v.b);
    });
    return out;
  };

  /**
   * Which variants are present, and do they match the expected bits?
   * Variants whose sentence did not appear in this report are skipped.
   */
  VG.checkPhrasing = function (text, digest) {
    const bits = phraseBits(digest);
    const t = VG.stripZeroWidth(text);
    let checked = 0;
    let matched = 0;
    VG.PHRASE_VARIANTS.forEach((v, i) => {
      const hasA = t.indexOf(v.a) !== -1;
      const hasB = t.indexOf(v.b) !== -1;
      if (!hasA && !hasB) return; // that sentence isn't in this report
      checked++;
      if ((bits[i] === 1 && hasB) || (bits[i] === 0 && hasA)) matched++;
    });
    return { checked, matched, ok: checked > 0 && matched === checked };
  };

  /* ------------------------------------------------------------------ *
   * Rebuild the canonical figures from a generated markdown report, so a
   * verifier needs nothing but the document and the key.
   * ------------------------------------------------------------------ */
  function num(cell) {
    const m = String(cell).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? m[0] : '';
  }

  function tableRows(text, heading) {
    const lines = String(text).split('\n');
    const start = lines.findIndex((l) => l.trim() === '## ' + heading);
    if (start === -1) return [];
    const rows = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('## ')) break;
      if (!l.startsWith('|')) continue;
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      if (!cells.length || /^-+:?$/.test(cells[0].replace(/ /g, ''))) continue;
      if (cells[0] === 'Metric' || cells[0] === 'Category' || cells[0] === 'Tool' ||
          cells[0] === 'Measure' || cells[0] === 'Type') continue;
      rows.push(cells);
    }
    return rows;
  }

  function pick(rows, label) {
    const hit = rows.find((r) => r[0] === label);
    return hit ? num(hit[1]) : '';
  }

  VG.figuresFromMarkdown = function (text) {
    const t = VG.stripZeroWidth(text);
    const head = tableRows(t, 'Headline numbers');
    const gov = tableRows(t, 'Governance');
    const work = tableRows(t, 'Work profile');
    const tools = tableRows(t, 'Tools');

    const maskedRow = head.find((r) => r[0] === 'Prompts with masked data');
    const maskedParts = maskedRow ? String(maskedRow[1]).match(/(\d+)\s*\(([\d.]+)%\)/) : null;

    const f = [];
    f.push('prompts=' + pick(head, 'Prompts'));
    f.push('conversations=' + pick(head, 'Conversations'));
    f.push('activeDays=' + pick(head, 'Active days'));
    f.push('perActiveDay=' + pick(head, 'Prompts per active day'));
    f.push('avgTurns=' + pick(head, 'Avg turns per conversation'));
    f.push('followUp=' + pick(head, 'Follow-up rate'));
    f.push('medianWords=' + pick(head, 'Median prompt length'));
    f.push('maskedPrompts=' + (maskedParts ? maskedParts[1] : ''));
    f.push('maskedPct=' + (maskedParts ? maskedParts[2] : ''));

    const nonWorkRow = gov.find((r) => r[0] === 'Prompts classified as non-work');
    const nonWorkParts = nonWorkRow ? String(nonWorkRow[1]).match(/(\d+)/) : null;
    f.push('nonWork=' + (nonWorkParts ? nonWorkParts[1] : ''));
    f.push('personalAcct=' + pick(gov, 'Sent from a personal account'));

    // Work profile and tools are keyed by id in the canonical list, but the
    // report prints labels — map back through the taxonomy and adapters.
    const clean = (t) => String(t).replace(/=/g, '');
    work.forEach((r) => f.push('wt:' + clean(r[0]) + '=' + num(r[1])));
    tools.forEach((r) => f.push('site:' + clean(r[0]) + '=' + num(r[1])));
    return f;
  };

  /* ------------------------------------------------------------------ *
   * Verify a pasted report.
   * ------------------------------------------------------------------ */
  VG.verifyReportText = async function (text, key) {
    const t = String(text || '');
    const figures = VG.figuresFromMarkdown(t);
    const digest = await VG.digestFor(figures, key);
    const expectedRef = VG.refCode(digest);

    const refMatch = VG.stripZeroWidth(t).match(/Report ref:\s*(VG-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4})/i);
    const foundRef = refMatch ? refMatch[1].toUpperCase() : null;

    const zw = VG.zwExtract(t);
    const phrasing = VG.checkPhrasing(t, digest);

    const checks = {
      figuresFound: figures.filter((f) => f.split('=')[1] !== '').length,
      ref: foundRef ? (foundRef === expectedRef ? 'pass' : 'fail') : 'absent',
      watermark: zw ? (zw === digest.slice(0, 16) ? 'pass' : 'fail') : 'absent',
      phrasing: phrasing.checked === 0 ? 'absent' : (phrasing.ok ? 'pass' : 'fail'),
      phrasingDetail: phrasing,
      expectedRef,
      foundRef
    };

    // Only the reference code and the watermark can decide on their own.
    // Phrasing corroborates when one of those survived, and is reported for a
    // human to weigh when neither did.
    const strong = [checks.ref, checks.watermark];
    const strongFail = strong.indexOf('fail') !== -1;
    const strongPass = strong.indexOf('pass') !== -1;

    if (strongFail) checks.verdict = 'altered';
    else if (strongPass && checks.phrasing === 'fail') checks.verdict = 'altered';
    else if (strongPass && strong.indexOf('absent') !== -1) checks.verdict = 'intact-partial';
    else if (strongPass) checks.verdict = 'intact';
    else checks.verdict = 'unverified';

    checks.explanation = {
      altered: 'A mark disagrees with the numbers in this document. A figure has been changed, or the report was signed with a different key.',
      'intact-partial': 'The marks that survived agree with the numbers. One was lost — usually the document was retyped or passed through a plain-text cleaner.',
      intact: 'Every mark agrees with the numbers in this document.',
      unverified: 'Neither the reference code nor the watermark is present, so this cannot be settled either way. ' +
        'The report was never signed, or both marks were stripped. Ask for the original export.'
    }[checks.verdict];

    if (checks.verdict === 'unverified' && checks.phrasingDetail.checked) {
      checks.explanation += ' For what it is worth, ' + checks.phrasingDetail.matched + ' of ' +
        checks.phrasingDetail.checked + ' wordings match what these numbers would have produced — ' +
        'suggestive, but wordings alone cannot separate an unsigned report from an altered one.';
    }

    return checks;
  };

  /* ------------------------------------------------------------------ *
   * Produce the signed markdown.
   * ------------------------------------------------------------------ */
  VG.signMarkdown = async function (markdown, report, key) {
    const figures = VG.canonicalFigures(report);
    const digest = await VG.digestFor(figures, key);

    let out = VG.applyPhrasing(markdown, digest);

    // Zero-width run goes after the first sentence of the narrative, where
    // there is always prose regardless of what the report contains.
    const anchor = out.indexOf('## Narrative');
    if (anchor !== -1) {
      const nl = out.indexOf('\n', anchor + 13);
      const dot = out.indexOf('. ', nl);
      if (dot !== -1) {
        out = out.slice(0, dot + 1) + VG.zwEncode(digest) + out.slice(dot + 1);
      }
    }

    out = out.replace(
      '_Generated locally by Vantage.',
      `Report ref: ${VG.refCode(digest)}\n\n_Generated locally by Vantage.`
    );
    return { markdown: out, ref: VG.refCode(digest), digest };
  };
})(typeof self !== 'undefined' ? self : globalThis);
