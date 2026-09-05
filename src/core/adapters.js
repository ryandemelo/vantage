/*
 * Vantage, adapters.js
 * One entry per AI site: where the composer is, where the thread is, and which
 * *surface* of the platform a prompt was sent to (plain chat, Project, custom
 * GPT / Gem / agent, Canvas, Deep Research…).
 *
 * Everything here is declarative strings, so an identical object can arrive
 * from central policy as JSON. Three config sources, in precedence order:
 *
 *   1. policy  , pushed by the org (chrome.storage.managed). Wins, locked in UI.
 *   2. user    , added on the Options page. Cannot override a policy entry.
 *   3. builtin , shipped in this file, refreshed by a store update.
 *
 * Bump `configRevision` whenever the built-in set changes so stale user
 * overrides of a built-in id can be detected and flagged.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  VG.CONFIG_REVISION = 6;

  VG.BUILTIN_ADAPTERS = [
    {
      id: 'claude',
      label: 'Claude',
      colour: '#D97757',
      revision: 5,
      hosts: ['claude.ai'],
      selectors: {
        composer: [
          'div[contenteditable="true"][data-testid]',
          'div[contenteditable="true"].ProseMirror',
          'fieldset div[contenteditable="true"]',
          'div[contenteditable="true"]'
        ],
        send: [
          'button[aria-label="Send message"]',
          'button[aria-label*="Send" i]',
          'button[type="submit"]'
        ],
        thread: ['main', 'div.flex-1.flex.flex-col'],
        userTurn: ['[data-testid="user-message"]', 'div.font-user-message'],
        assistantTurn: [
          '[data-testid="assistant-message"]',
          'div.font-claude-message',
          'div.font-claude-response'
        ],
        model: ['[data-testid="model-selector-dropdown"]', 'button[data-testid*="model" i]'],
        regenerate: ['button[aria-label*="Retry" i]', 'button[aria-label*="Regenerate" i]'],
        attachment: ['[data-testid="file-thumbnail"]', 'div[data-testid*="attachment" i]']
      },
      surfaces: [
        {
          id: 'project', label: 'Project', primary: true, agentType: 'project',
          url: '\\/project\\/([0-9a-zA-Z-]{6,})', idFrom: 'url:1',
          name: ['[data-testid="project-name"]', 'header h1', 'main h1']
        },
        {
          id: 'artifact', label: 'Artifact',
          dom: ['[data-testid="artifact-panel"]', 'div[class*="artifact" i][role="region"]']
        },
        {
          id: 'connector', label: 'Connector / MCP',
          dom: ['[data-testid*="connector" i]', 'button[aria-label*="tools" i][aria-pressed="true"]']
        },
        {
          id: 'deep_research', label: 'Research mode',
          dom: ['button[aria-pressed="true"][aria-label*="Research" i]', '[data-testid*="research-toggle" i][aria-pressed="true"]']
        }
      ],
      sharedDom: ['[data-testid="project-members"]', '[aria-label*="Shared with" i]'],
      account: {
        emailFrom: ['[data-testid="user-menu-email"]', 'div[class*="account" i] [class*="email" i]'],
        planFrom: ['[data-testid="user-menu-plan"]', 'div[class*="plan-badge" i]', '[aria-label*="plan" i]']
      },
      conversationId: (url) => {
        const m = url.pathname.match(/\/chat\/([0-9a-f-]{8,})/i);
        return m ? m[1] : url.pathname;
      }
    },

    {
      id: 'chatgpt',
      label: 'ChatGPT',
      colour: '#10A37F',
      revision: 6,
      hosts: ['chatgpt.com', 'chat.openai.com'],
      selectors: {
        composer: [
          'div#prompt-textarea[contenteditable="true"]',
          'textarea#prompt-textarea',
          'form div[contenteditable="true"]'
        ],
        send: [
          'button[data-testid="send-button"]',
          'button#composer-submit-button',
          'button[aria-label*="Send" i]'
        ],
        thread: ['main', 'div[role="presentation"]'],
        userTurn: ['[data-message-author-role="user"]', '[data-turn="user"]', 'article[data-turn-id][data-turn="user"]'],
        assistantTurn: ['[data-message-author-role="assistant"]', '[data-turn="assistant"]'],
        model: [
          'button[aria-label*="Model" i]',
          '[data-testid="model-switcher-dropdown-button"]',
          'button[data-testid*="model" i]'
        ],
        // Only rendered on hover over a reply, so a probe on a static page
        // reports this missing even when the selector is correct.
        regenerate: [
          'button[data-testid*="regenerate" i]',
          'button[aria-label*="Regenerate" i]',
          'button[aria-label*="Try again" i]'
        ],
        attachment: ['div[data-testid*="attachment" i]', 'button[aria-label*="Remove file" i]']
      },
      surfaces: [
        {
          id: 'project', label: 'Project', primary: true, agentType: 'project',
          url: '\\/g\\/(g-p-[A-Za-z0-9_-]+)', idFrom: 'url:1',
          name: ['[data-testid="project-name"]', 'header h1', 'main h1']
        },
        {
          id: 'custom_agent', label: 'Custom GPT', primary: true, agentType: 'gpt',
          url: '\\/g\\/(g-(?!p-)[A-Za-z0-9_-]+)', idFrom: 'url:1',
          name: ['[data-testid="gizmo-name"]', 'header h1', 'div[class*="gizmo" i] h1']
        },
        {
          id: 'canvas', label: 'Canvas',
          dom: ['[data-testid="canvas-panel"]', 'section[class*="canvas" i]']
        },
        {
          id: 'deep_research', label: 'Deep research',
          dom: [
            'button[data-testid*="deep-research" i][aria-pressed="true"]',
            'button[aria-label*="Deep research" i][aria-pressed="true"]'
          ]
        },
        {
          id: 'agent_mode', label: 'Agent mode',
          dom: ['[data-testid*="agent-mode" i]', 'button[aria-label*="Agent mode" i][aria-pressed="true"]']
        },
        {
          id: 'code_interpreter', label: 'Code interpreter',
          dom: ['[data-testid*="code-interpreter" i]', 'div[class*="jupyter" i]']
        },
        {
          id: 'search', label: 'Web search',
          dom: ['button[aria-label*="Search" i][aria-pressed="true"]', '[data-testid*="search-toggle" i][aria-pressed="true"]']
        }
      ],
      sharedDom: ['[data-testid="project-members"]', '[aria-label*="Shared" i][role="group"]'],
      account: {
        emailFrom: ['[data-testid="accounts-profile-button"] [class*="email" i]', 'div[class*="account-menu" i] [class*="email" i]'],
        planFrom: ['[data-testid="workspace-switcher"]', 'button[aria-label*="workspace" i]', 'div[class*="plan" i]']
      },
      conversationId: (url) => {
        const m = url.pathname.match(/\/c\/([0-9a-f-]{8,})/i);
        return m ? m[1] : url.pathname;
      }
    },

    {
      id: 'gemini',
      label: 'Gemini',
      colour: '#4285F4',
      revision: 5,
      hosts: ['gemini.google.com'],
      selectors: {
        composer: [
          'rich-textarea div[contenteditable="true"]',
          'div.ql-editor[contenteditable="true"]',
          'div[contenteditable="true"][role="textbox"]'
        ],
        send: ['button.send-button', 'button[aria-label*="Send" i]', 'button[mattooltip*="Send" i]'],
        thread: ['chat-window', 'main'],
        userTurn: ['user-query', '.query-text'],
        assistantTurn: ['model-response', 'message-content'],
        model: ['button[data-test-id="bard-mode-menu-button"]', 'bard-mode-switcher button'],
        regenerate: ['button[aria-label*="Regenerate" i]', 'button[data-test-id*="regenerate" i]'],
        attachment: ['uploader-file-preview', 'div[class*="file-preview" i]']
      },
      surfaces: [
        {
          id: 'custom_agent', label: 'Gem', primary: true, agentType: 'gem',
          url: '\\/gem\\/([A-Za-z0-9_-]{4,})', idFrom: 'url:1',
          name: ['[data-test-id="bot-name"]', 'bot-name', 'header h1']
        },
        {
          id: 'deep_research', label: 'Deep research',
          dom: [
            '[data-test-id*="deep-research" i][aria-pressed="true"]',
            'button[aria-label*="Deep Research" i][aria-pressed="true"]'
          ]
        },
        {
          id: 'canvas', label: 'Canvas',
          dom: ['immersive-panel', '[data-test-id="canvas-panel"]']
        }
      ],
      sharedDom: ['[data-test-id*="shared" i]'],
      account: {
        emailFrom: ['a[aria-label*="Google Account" i]', 'div[class*="gb_" i][aria-label*="@"]'],
        planFrom: ['[data-test-id*="workspace" i]', 'div[class*="upgrade" i]']
      },
      conversationId: (url) => {
        const m = url.pathname.match(/\/(?:app|gem)\/([0-9a-z_-]{6,})/i);
        return m ? m[1] : url.pathname;
      }
    },

    {
      id: 'copilot',
      label: 'Microsoft Copilot',
      colour: '#0078D4',
      revision: 5,
      hosts: [
        'copilot.microsoft.com',
        'copilot.cloud.microsoft',
        'm365.cloud.microsoft',
        'www.office.com'
      ],
      selectors: {
        composer: [
          'textarea#userInput',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]'
        ],
        send: ['button[title*="Submit" i]', 'button[aria-label*="Send" i]', 'button[type="submit"]'],
        thread: ['main', 'div[role="main"]'],
        userTurn: ['div[data-content="user-message"]', 'div[class*="userMessage" i]'],
        assistantTurn: ['div[data-content="ai-message"]', 'div[class*="botMessage" i]'],
        model: [],
        regenerate: ['button[aria-label*="Regenerate" i]'],
        attachment: ['div[class*="attachment" i]']
      },
      surfaces: [
        {
          id: 'custom_agent', label: 'Copilot agent', primary: true, agentType: 'agent',
          url: '\\/(?:agents?|bizchat\\/agent)\\/([A-Za-z0-9_.-]{4,})', idFrom: 'url:1',
          name: ['[data-testid="agent-name"]', 'header h1']
        },
        {
          id: 'notebook', label: 'Notebook',
          dom: ['[data-testid*="notebook" i]']
        },
        {
          id: 'search', label: 'Work grounding',
          dom: ['button[aria-label*="Work" i][aria-pressed="true"]']
        }
      ],
      sharedDom: [],
      account: {
        emailFrom: ['#mectrl_currentAccount_secondary', '[data-testid="account-email"]'],
        planFrom: ['[data-testid="copilot-mode-badge"]', 'div[class*="workBadge" i]']
      },
      conversationId: (url) => url.pathname + url.search
    }
  ];

  /*
   * Generic fallback for custom sites supplied with only a hostname.
   */
  VG.GENERIC_ADAPTER = {
    id: 'generic',
    label: 'Custom AI site',
    colour: '#64748B',
    hosts: [],
    selectors: {
      composer: ['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', 'textarea'],
      send: ['button[aria-label*="Send" i]', 'button[type="submit"]', 'button[title*="Send" i]'],
      thread: ['main', 'body'],
      userTurn: [],
      assistantTurn: [],
      model: [],
      regenerate: [],
      attachment: []
    },
    surfaces: [],
    sharedDom: [],
    conversationId: (url) => url.pathname
  };

  function hostMatches(host, pattern) {
    const h = String(host || '').toLowerCase();
    const p = String(pattern || '').toLowerCase().replace(/^\*\./, '');
    if (!p) return false;
    return h === p || h.endsWith('.' + p);
  }

  function normalise(c, source) {
    if (!c || !c.id || !c.hosts) return null;
    const sel = c.selectors || {};
    const merge = (k) => {
      const v = sel[k];
      const fallback = VG.GENERIC_ADAPTER.selectors[k] || [];
      if (!v) return fallback.slice();
      const list = Array.isArray(v) ? v : [v];
      return list.concat(fallback);
    };
    const id = c.id.indexOf(':') === -1 && source !== 'builtin' ? source + ':' + c.id : c.id;
    return {
      id,
      rawId: c.id,
      label: c.label || c.id,
      colour: c.colour || '#64748B',
      hosts: Array.isArray(c.hosts) ? c.hosts : [c.hosts],
      source,
      revision: c.revision || 0,
      selectors: {
        composer: merge('composer'),
        send: merge('send'),
        thread: merge('thread'),
        userTurn: merge('userTurn'),
        assistantTurn: merge('assistantTurn'),
        model: merge('model'),
        regenerate: merge('regenerate'),
        attachment: merge('attachment')
      },
      surfaces: Array.isArray(c.surfaces) ? c.surfaces : [],
      sharedDom: Array.isArray(c.sharedDom) ? c.sharedDom : [],
      account: c.account || {},
      conversationId: (url) => url.pathname
    };
  }
  VG.normaliseCustomAdapter = function (c) { return normalise(c, 'custom'); };

  /**
   * The full adapter list this device should use, in precedence order.
   * Policy entries are marked so the UI can lock them; a user entry whose id
   * collides with a policy entry is dropped, not merged.
   */
  VG.adapterList = function (settings) {
    const s = settings || {};
    const policy = (s.policyAdapters || []).map((c) => normalise(c, 'policy')).filter(Boolean);
    const user = (s.customAdapters || []).map((c) => normalise(c, 'custom')).filter(Boolean);

    const seen = new Set(policy.map((a) => a.rawId));
    const userKept = user.filter((a) => !seen.has(a.rawId));
    userKept.forEach((a) => seen.add(a.rawId));

    const builtins = VG.BUILTIN_ADAPTERS
      .map((a) => Object.assign({}, a, { source: 'builtin', rawId: a.id }))
      .filter((a) => !seen.has(a.id));

    return policy.concat(userKept, builtins);
  };

  VG.resolveAdapter = function (host, settings) {
    const disabled = new Set((settings && settings.disabledSites) || []);
    return VG.adapterList(settings).find(
      (a) => !disabled.has(a.id) && (a.hosts || []).some((p) => hostMatches(host, p))
    ) || null;
  };

  /** Every host this build knows about, used for coverage health. */
  VG.knownHosts = function (settings) {
    const out = [];
    VG.adapterList(settings).forEach((a) => (a.hosts || []).forEach((h) => out.push({ host: h, id: a.id })));
    return out;
  };

  VG.pick = function (list, scope) {
    const rootEl = scope || document;
    for (const sel of list || []) {
      try {
        const el = rootEl.querySelector(sel);
        if (el) return el;
      } catch (e) { /* invalid selector from pushed config */ }
    }
    return null;
  };

  VG.pickAll = function (list, scope) {
    const rootEl = scope || document;
    for (const sel of list || []) {
      try {
        const els = rootEl.querySelectorAll(sel);
        if (els.length) return Array.from(els);
      } catch (e) { /* ignore */ }
    }
    return [];
  };

  VG.closestAny = function (el, list) {
    for (const sel of list || []) {
      try {
        const hit = el.closest(sel);
        if (hit) return hit;
      } catch (e) { /* ignore */ }
    }
    return null;
  };

  function findAdapter(id, settings) {
    return VG.adapterList(settings).find((a) => a.id === id) || null;
  }

  VG.adapterLabel = function (id, settings) {
    const a = findAdapter(id, settings);
    return a ? a.label : id;
  };

  VG.adapterColour = function (id, settings) {
    const a = findAdapter(id, settings);
    return a ? a.colour : '#64748B';
  };
})(typeof self !== 'undefined' ? self : globalThis);
