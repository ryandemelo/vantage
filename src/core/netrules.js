/*
 * Vantage, netrules.js
 *
 * Extracting the prompt from the request the site already sends, rather than
 * from the page it renders.
 *
 * Markup is the least stable thing about these sites. Two live probes found
 * stale selectors on two sites. The request a site sends to its own API is far
 * more stable, because changing it breaks their own clients, and it does not
 * move when someone reskins the interface.
 *
 * Rules are declarative so they can be pushed from policy exactly like
 * selectors, and so extraction can be tested without a browser.
 *
 *   {
 *     id,
 *     url:  "\\/backend-api\\/conversation",   regex against the request URL
 *     method: "POST",
 *     paths: ["messages.*.content.parts.*"],   where the prompt text lives
 *     idPath: "conversation_id"                optional, groups turns
 *   }
 *
 * A path segment of * walks every element of an array or every value of an
 * object. Several paths may be given; the first that yields text wins.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  /** Walk a dotted path with * wildcards, collecting every string found. */
  function collect(value, segments) {
    if (value === null || value === undefined) return [];
    if (!segments.length) {
      if (typeof value === 'string') return [value];
      // Some clients wrap the text one level deeper than the path implies.
      if (Array.isArray(value)) {
        return value.filter((v) => typeof v === 'string');
      }
      return [];
    }
    const [head, ...rest] = segments;
    if (head === '*') {
      const items = Array.isArray(value) ? value : (typeof value === 'object' ? Object.values(value) : []);
      return items.reduce((acc, v) => acc.concat(collect(v, rest)), []);
    }
    if (typeof value !== 'object') return [];
    return collect(value[head], rest);
  }

  /**
   * Pull the prompt out of a parsed request body.
   * Returns the joined text, or '' when nothing matched.
   */
  VG.extractPrompt = function (body, rule) {
    if (!body || !rule || !rule.paths) return '';
    for (const path of rule.paths) {
      const found = collect(body, String(path).split('.'));
      const text = found.filter((t) => typeof t === 'string' && t.trim()).join('\n').trim();
      if (text) return text;
    }
    return '';
  };

  VG.extractConversationId = function (body, rule) {
    if (!body || !rule || !rule.idPath) return '';
    const found = collect(body, String(rule.idPath).split('.'));
    return found.length ? String(found[0]) : '';
  };

  /** First rule whose url pattern and method match this request. */
  VG.matchNetRule = function (rules, url, method) {
    for (const rule of rules || []) {
      if (rule.method && String(method || '').toUpperCase() !== rule.method.toUpperCase()) continue;
      let re;
      try { re = new RegExp(rule.url, 'i'); } catch (e) { continue; }
      if (re.test(String(url || ''))) return rule;
    }
    return null;
  };

  /**
   * Everything for one intercepted request, or null when it is not a prompt.
   * Kept separate from the interception itself so it can be tested directly.
   */
  VG.readRequest = function (rules, url, method, rawBody) {
    const rule = VG.matchNetRule(rules, url, method);
    if (!rule) return null;

    let body;
    try {
      body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    } catch (e) {
      return null;                       // not JSON, not something we read
    }

    const prompt = VG.extractPrompt(body, rule);
    if (!prompt) return null;            // a request on the same endpoint that carries no prompt

    return {
      ruleId: rule.id,
      prompt,
      conversationId: VG.extractConversationId(body, rule)
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
