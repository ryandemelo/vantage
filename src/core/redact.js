/*
 * Vantage — redact.js
 * Strips identifiers and secrets out of prompt text BEFORE anything is stored.
 * Runs entirely in the page's content script; the unredacted string never
 * crosses a message boundary.
 *
 * Order matters: high-specificity detectors run first so that, for example,
 * an AWS key is not first chewed up by the generic long-token detector.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (n < 0 || n > 9) return false;
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // national identity number checksum. Cheap and removes most false positives.
  function nationalIdValid(id) {
    const s = id.toUpperCase();
    if (!/^[STFGM]\d{7}[A-Z]$/.test(s)) return false;
    const weights = [2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += (s.charCodeAt(i + 1) - 48) * weights[i];
    if (s[0] === 'T' || s[0] === 'G') sum += 4;
    else if (s[0] === 'M') sum += 3;
    const stTable = 'JZIHGFEDCBA';
    const fgTable = 'XWUTRQPNMLK';
    const mTable = 'XWUTRQPNJLK';
    const idx = sum % 11;
    let table;
    if (s[0] === 'S' || s[0] === 'T') table = stTable;
    else if (s[0] === 'F' || s[0] === 'G') table = fgTable;
    else table = mTable;
    return table[idx] === s[8];
  }

  /*
   * Built-in detectors.
   *   id          stable key used in reports and in the disable list
   *   label       human label shown in the risk breakdown
   *   re          global regex
   *   replace     token substituted in
   *   validate    optional; return false to leave the match untouched
   *   default     false means opt-in (noisy detectors)
   */
  VG.REDACTORS = [
    {
      id: 'private_key',
      label: 'Private key block',
      re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
      replace: '[PRIVATE_KEY]',
      default: true
    },
    {
      id: 'jwt',
      label: 'JWT',
      re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      replace: '[JWT]',
      default: true
    },
    {
      id: 'aws_key',
      label: 'AWS access key',
      re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
      replace: '[AWS_KEY]',
      default: true
    },
    {
      id: 'gcp_key',
      label: 'Google API key',
      re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
      replace: '[GOOGLE_API_KEY]',
      default: true
    },
    {
      id: 'slack_token',
      label: 'Slack token',
      re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
      replace: '[SLACK_TOKEN]',
      default: true
    },
    {
      id: 'github_token',
      label: 'GitHub token',
      re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
      replace: '[GITHUB_TOKEN]',
      default: true
    },
    {
      id: 'openai_key',
      label: 'Provider API key',
      re: /\b(?:sk-(?:proj-|ant-)?|sk_live_|rk_live_)[A-Za-z0-9_-]{16,}\b/g,
      replace: '[API_KEY]',
      default: true
    },
    {
      id: 'assigned_secret',
      label: 'Assigned secret',
      // password = "...", api_key: '...', token=... — captures the value only.
      re: /\b(pass(?:word|wd)?|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|bearer|client[_-]?secret|conn(?:ection)?[_-]?string)\b\s*[:=]\s*["']?([^\s"'`,;]{6,})["']?/gi,
      replaceFn: (m, key) => `${key}=[SECRET]`,
      default: true
    },
    {
      id: 'url_credentials',
      label: 'URL with credentials',
      re: /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+:[^\s/@]+@/gi,
      replaceFn: (m, scheme) => `${scheme}://[CREDENTIALS]@`,
      default: true
    },
    {
      id: 'email',
      label: 'Email address',
      re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      replace: '[EMAIL]',
      default: true
    },
    {
      id: 'national_id',
      label: 'National identity number',
      re: /\b[STFGMstfgm]\d{7}[A-Za-z]\b/g,
      replace: '[NATIONAL_ID]',
      validate: (m) => nationalIdValid(m),
      default: true
    },
    {
      id: 'credit_card',
      label: 'Payment card number',
      re: /\b(?:\d[ -]?){13,19}\b/g,
      replace: '[CARD]',
      validate: (m) => {
        const d = m.replace(/[^\d]/g, '');
        return d.length >= 13 && d.length <= 19 && luhn(d);
      },
      default: true
    },
    {
      id: 'phone',
      label: 'Phone number',
      re: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d{3,4}[\s-]?\d{3,4}(?:[\s-]?\d{2,4})?/g,
      replace: '[PHONE]',
      // Require either an international prefix or a separator, otherwise this
      // eats every ordinary number in the prompt.
      validate: (m) => {
        const digits = m.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) return false;
        return /^\+/.test(m.trim()) || /[\s()-]/.test(m.trim());
      },
      default: true
    },
    {
      id: 'ipv4',
      label: 'IP address',
      re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
      replace: '[IP]',
      default: true
    },
    {
      id: 'iban',
      label: 'IBAN',
      re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
      replace: '[IBAN]',
      default: true
    },
    {
      id: 'postal_sg',
      label: 'Postal code',
      re: /\b(?:[Ss]ingapore|[Ss]\(?\)?)\s*\(?\b(\d{6})\b\)?/g,
      replace: ' [POSTCODE]',
      default: false
    },
    {
      id: 'long_number',
      label: 'Long numeric identifier',
      re: /\b\d{9,}\b/g,
      replace: '[NUMBER]',
      default: false
    },
    {
      id: 'uuid',
      label: 'UUID',
      re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      replace: '[UUID]',
      default: false
    }
  ];

  function compileCustom(list) {
    const out = [];
    (list || []).forEach((c) => {
      if (!c || !c.pattern) return;
      try {
        let flags = c.flags || 'g';
        if (!flags.includes('g')) flags += 'g';
        out.push({
          id: c.id || 'custom',
          label: c.label || 'Custom pattern',
          re: new RegExp(c.pattern, flags),
          replace: c.replacement || '[REDACTED]',
          custom: true
        });
      } catch (e) {
        /* a bad admin regex must never break capture */
      }
    });
    return out;
  }

  function compileWordlist(words) {
    const cleaned = (words || [])
      .map((w) => String(w || '').trim())
      .filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!cleaned.length) return null;
    return {
      id: 'wordlist',
      label: 'Restricted term',
      re: new RegExp('\\b(?:' + cleaned.join('|') + ')\\b', 'gi'),
      replace: '[RESTRICTED]'
    };
  }

  /**
   * Redact text.
   * @param {string} text
   * @param {object} settings  uses redactorsOff, customRedactors, sensitiveWordlist
   * @returns {{text:string, hits:Object<string,number>, count:number}}
   */
  VG.redact = function (text, settings) {
    const s = settings || {};
    const off = new Set(s.redactorsOff || []);
    const hits = {};
    let count = 0;
    let out = String(text == null ? '' : text);

    const active = VG.REDACTORS.filter((r) => {
      if (off.has(r.id)) return false;
      if (r.default === false) return (s.redactorsOn || []).includes(r.id);
      return true;
    });

    const wordlist = compileWordlist(s.sensitiveWordlist);
    const all = active.concat(compileCustom(s.customRedactors));
    if (wordlist) all.push(wordlist);

    all.forEach((r) => {
      r.re.lastIndex = 0;
      out = out.replace(r.re, function (...args) {
        const match = args[0];
        if (r.validate && !r.validate(match)) return match;
        hits[r.id] = (hits[r.id] || 0) + 1;
        count++;
        if (r.replaceFn) return r.replaceFn.apply(null, args);
        return r.replace;
      });
    });

    return { text: out, hits, count };
  };

  VG.redactorLabel = function (id) {
    const built = VG.REDACTORS.find((r) => r.id === id);
    if (built) return built.label;
    if (id === 'wordlist') return 'Restricted term';
    return id;
  };
})(typeof self !== 'undefined' ? self : globalThis);
