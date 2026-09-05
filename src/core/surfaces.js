/*
 * Vantage, surfaces.js
 *
 * Detects WHICH PART of an AI platform a prompt was sent to: plain chat, a
 * Project, a custom GPT / Gem / agent, Canvas, Deep Research, code interpreter,
 * and so on, plus the agent's name and whether it is shared with a team.
 *
 * Every rule is declarative (regex strings + CSS selector strings) so the whole
 * surface map is JSON-serialisable and can be pushed from central policy
 * without shipping a new extension build.
 *
 * Rule shape:
 *   {
 *     id, label,
 *     primary: true,                 // eligible to be THE surface, not just a flag
 *     url: "\\/g\\/(g-[\\w-]+)",     // regex tested against pathname + search
 *     idFrom: "url:1",               // capture group holding the agent id
 *     dom: ["css", "css"],           // any match => rule is active
 *     notDom: ["css"],               // any match => rule is suppressed
 *     name: ["css"],                 // where to read the agent/project name
 *     agentType: "gpt" | "gem" | "project" | "agent" | "notebook"
 *   }
 *
 * Order matters: the first matching primary rule wins.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  function reOf(pattern) {
    if (!pattern) return null;
    try { return new RegExp(pattern, 'i'); } catch (e) { return null; }
  }

  function textOf(selectors, doc) {
    for (const sel of selectors || []) {
      try {
        const el = (doc || document).querySelector(sel);
        if (el) {
          const attr = el.getAttribute ? el.getAttribute('data-name') : '';
          const t = (attr || el.innerText || el.textContent || '').trim();
          if (t) return t.replace(/\s+/g, ' ').slice(0, 80);
        }
      } catch (e) { /* bad selector from pushed config */ }
    }
    return '';
  }

  function domHit(selectors, doc) {
    for (const sel of selectors || []) {
      try {
        if ((doc || document).querySelector(sel)) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  /**
   * @returns {{
   *   surface:string, surfaceLabel:string, flags:string[],
   *   agentIdRaw:string, agentName:string, agentType:string, shared:boolean
   * }}
   */
  VG.detectSurface = function (adapter, urlObj, doc) {
    const rules = (adapter && adapter.surfaces) || [];
    const path = (urlObj.pathname || '') + (urlObj.search || '');
    const out = {
      surface: 'chat',
      surfaceLabel: 'Chat',
      flags: [],
      agentIdRaw: '',
      agentName: '',
      agentType: '',
      shared: false
    };

    let primaryFound = false;

    rules.forEach((rule) => {
      const re = reOf(rule.url);
      const m = re ? path.match(re) : null;
      const urlOk = rule.url ? !!m : true;
      const domOk = rule.dom ? domHit(rule.dom, doc) : true;
      const suppressed = rule.notDom ? domHit(rule.notDom, doc) : false;
      // A rule with neither url nor dom conditions is inert.
      if (!rule.url && !rule.dom) return;
      if (!urlOk || !domOk || suppressed) return;

      if (rule.primary && !primaryFound) {
        primaryFound = true;
        out.surface = rule.id;
        out.surfaceLabel = rule.label || rule.id;
        if (rule.agentType) out.agentType = rule.agentType;
        if (m && rule.idFrom && rule.idFrom.startsWith('url:')) {
          const g = Number(rule.idFrom.slice(4));
          if (m[g]) out.agentIdRaw = m[g];
        }
        if (rule.name) out.agentName = textOf(rule.name, doc);
      } else {
        out.flags.push(rule.id);
      }
    });

    if (adapter && adapter.sharedDom) out.shared = domHit(adapter.sharedDom, doc);
    // A named agent with no id still needs a stable key.
    if (!out.agentIdRaw && out.agentName) out.agentIdRaw = 'name:' + out.agentName.toLowerCase();
    return out;
  };

  /**
   * Corporate vs personal account, without ever storing an identity.
   *
   * Reads the account menu's email text, keeps ONLY the domain long enough to
   * compare it against the org's known domains, and returns a tier. The email
   * and the domain are both discarded before this function returns.
   * Falls back to a plan/workspace badge when no email is exposed.
   */
  VG.detectAccount = function (adapter, doc, settings) {
    const cfg = (adapter && adapter.account) || {};

    // Under the default 'minimal' scope the account menu's address is never
    // read. The plan / workspace badge is a UI label, not an identity, and it
    // answers the same question in most cases.
    if (!settings || settings.domScope !== 'standard') {
      const badge = textOf(cfg.planFrom, doc).toLowerCase();
      if (!badge) return 'unknown';
      if (/enterprise|business|workspace|gov/.test(badge)) return 'enterprise';
      if (/team/.test(badge)) return 'team';
      if (/free|plus|pro|personal/.test(badge)) return 'personal';
      return 'unknown';
    }

    const corp = ((settings && settings.corporateDomains) || [])
      .concat(Object.keys((settings && settings.agencyDomainMap) || {}))
      .map((d) => String(d).toLowerCase().replace(/^@/, ''));

    const emailText = textOf(cfg.emailFrom, doc);
    if (emailText) {
      const m = emailText.match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
      if (m) {
        const dom = m[1].toLowerCase();
        if (corp.length) {
          return corp.some((c) => dom === c || dom.endsWith('.' + c)) ? 'enterprise' : 'personal';
        }
        // No domain list configured: a non-freemail domain is a weak corporate signal.
        const freemail = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me'];
        return freemail.indexOf(dom) === -1 ? 'enterprise' : 'personal';
      }
    }

    const plan = textOf(cfg.planFrom, doc).toLowerCase();
    if (plan) {
      if (/enterprise|business|workspace|gov/.test(plan)) return 'enterprise';
      if (/team/.test(plan)) return 'team';
      if (/free|plus|pro|personal/.test(plan)) return 'personal';
    }
    return 'unknown';
  };

  /* Canonical surface labels, for reports where an id arrives without config. */
  VG.SURFACE_LABELS = {
    chat: 'Plain chat',
    project: 'Project',
    custom_agent: 'Custom agent',
    gpt: 'Custom GPT',
    gem: 'Gem',
    canvas: 'Canvas / Artifact',
    artifact: 'Artifact',
    deep_research: 'Deep research',
    code_interpreter: 'Code interpreter',
    agent_mode: 'Agent mode',
    connector: 'Connector / MCP',
    voice: 'Voice',
    search: 'Web search',
    notebook: 'Notebook'
  };

  VG.surfaceLabel = function (id) {
    return VG.SURFACE_LABELS[id] || id;
  };
})(typeof self !== 'undefined' ? self : globalThis);
