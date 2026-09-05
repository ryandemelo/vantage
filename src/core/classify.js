/*
 * Vantage — classify.js
 * Local, deterministic work-type classifier. No network call, no model
 * download: a weighted keyword/pattern scorer over the taxonomy in schema.js.
 *
 * Deliberately simple. It runs on the REDACTED text, is auditable line by line,
 * and an admin can tune it by adding terms via policy. Swap this file for an
 * LLM-backed classifier later without touching anything else — the contract is
 * classify(text, settings) -> {id, label, confidence, runnerUp, scores}.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Compile once per settings object; taxonomy rarely changes at runtime.
  let cache = null;
  let cacheKey = '';

  function compile(settings) {
    const extra = (settings && settings.extraTaxonomyTerms) || {};
    const key = JSON.stringify(extra);
    if (cache && cacheKey === key) return cache;

    cache = VG.TAXONOMY.map((cat) => {
      // Local settings use ["term", weight] pairs; pushed policy uses
      // {term, weight} objects, because Chrome's policy schema cannot express
      // a mixed-type tuple. Accept either.
      const terms = (cat.terms || []).concat(extra[cat.id] || []).map((t) => {
        if (Array.isArray(t)) return t;
        if (t && typeof t === 'object' && t.term) return [t.term, t.weight || 1];
        return null;
      });
      const compiled = terms
        .filter((t) => t && t[0])
        .map(([term, weight]) => {
          const t = String(term).trim().toLowerCase();
          // Multi-word terms match as a phrase; single words on word boundary.
          const body = escapeRe(t).replace(/\s+/g, '\\s+');
          const bounded = /\w$/.test(t) ? body + '\\b' : body;
          const prefix = /^\w/.test(t) ? '\\b' : '';
          return { re: new RegExp(prefix + bounded, 'gi'), weight: weight || 1 };
        });
      return {
        id: cat.id, label: cat.label, terms: compiled,
        patterns: cat.patterns || [], anti: cat.anti || []
      };
    });
    cacheKey = key;
    return cache;
  }

  /**
   * @param {string} text redacted prompt text
   * @param {object} settings
   * @returns {{id:string,label:string,confidence:number,runnerUp:string,scores:Object}}
   */
  VG.classify = function (text, settings) {
    const src = String(text || '');
    const scores = {};

    if (src.trim().length < 3) {
      return { id: 'other', label: VG.taxonomyById('other').label, confidence: 0, runnerUp: '', scores };
    }

    const cats = compile(settings);

    cats.forEach((cat) => {
      let score = 0;
      cat.terms.forEach((t) => {
        t.re.lastIndex = 0;
        const m = src.match(t.re);
        if (m) {
          // Diminishing returns: a term repeated 10x is not 10x the signal.
          score += t.weight * (1 + Math.log2(m.length));
        }
      });
      (cat.patterns || []).forEach(([re, weight]) => {
        if (re.test(src)) score += weight;
      });
      // Disambiguators. "IAM policy" is engineering, "smart contract" is not
      // procurement, and nothing with a code fence in it is personal.
      cat.anti.forEach(([re, weight]) => {
        if (re.test(src)) score += weight;
      });
      if (score > 0) scores[cat.id] = Math.round(score * 100) / 100;
    });

    // Long prompts accumulate hits simply by being long. Damp them so a
    // 600-word paste does not drift into whichever category has most terms.
    const wc = VG.wordCount(src);
    if (wc > 80) {
      const damp = Math.sqrt(wc / 80);
      Object.keys(scores).forEach((k) => { scores[k] = Math.round((scores[k] / damp) * 100) / 100; });
    }

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 3) {
      return {
        id: 'other', label: VG.taxonomyById('other').label,
        confidence: 0, runnerUp: '', secondary: '', nonWork: false, scores
      };
    }

    const [topId, topScore] = ranked[0];
    const secondScore = ranked[1] ? ranked[1][1] : 0;
    // Confidence is a relative margin, not a probability. Named accordingly.
    const margin = (topScore - secondScore) / topScore;
    const strength = Math.min(1, topScore / 12);
    const confidence = Math.round((0.45 * strength + 0.55 * margin) * 100) / 100;

    // Real prompts are often two jobs at once ("summarise this then draft a
    // reply"). Keep the second intent when it is genuinely close.
    const secondary = ranked[1] && secondScore >= topScore * 0.6 ? ranked[1][0] : '';

    return {
      id: topId,
      label: VG.taxonomyById(topId).label,
      confidence,
      runnerUp: ranked[1] ? ranked[1][0] : '',
      secondary,
      nonWork: VG.isNonWork(topId),
      scores
    };
  };

  /**
   * Short follow-up turns ("make it shorter", "now in Malay", "try again")
   * carry almost no signal of their own. Inherit the topic the conversation
   * has already established rather than dumping them into Uncategorised.
   *
   * @param {object} result   from VG.classify
   * @param {object} context  { workType, confidence } established for the thread
   * @param {number} turn
   */
  VG.applyContext = function (result, context, turn) {
    const weak = result.id === 'other' || result.confidence < 0.25;
    if (!weak || !context || !context.workType || turn <= 1) {
      return Object.assign({}, result, { source: 'direct' });
    }
    if (context.workType === 'other' || context.confidence < 0.4) {
      return Object.assign({}, result, { source: 'direct' });
    }
    return {
      id: context.workType,
      label: VG.taxonomyById(context.workType).label,
      confidence: Math.round(context.confidence * 0.7 * 100) / 100,
      runnerUp: result.id,
      secondary: '',
      nonWork: VG.isNonWork(context.workType),
      scores: result.scores,
      source: 'inherited'
    };
  };

  VG.wordCount = function (text) {
    const m = String(text || '').trim().match(/\S+/g);
    return m ? m.length : 0;
  };
})(typeof self !== 'undefined' ? self : globalThis);
