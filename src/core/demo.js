/*
 * Vantage — demo.js
 * Generates plausible sample events so a report can be shown to stakeholders
 * before real data has accumulated. Every row is flagged `demo:true` and can
 * be removed in one click. Never runs unless a user asks for it.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  const SITES = [
    { id: 'claude', weight: 42 },
    { id: 'chatgpt', weight: 33 },
    { id: 'gemini', weight: 16 },
    { id: 'copilot', weight: 9 }
  ];

  const MIX = [
    { type: 'coding', weight: 24 },
    { type: 'drafting', weight: 19 },
    { type: 'comprehension', weight: 14 },
    { type: 'data', weight: 11 },
    { type: 'policy', weight: 9 },
    { type: 'research', weight: 7 },
    { type: 'citizen', weight: 5 },
    { type: 'procurement', weight: 4 },
    { type: 'translation', weight: 3 },
    { type: 'learning', weight: 3 },
    { type: 'comms', weight: 7 },
    { type: 'appraisal', weight: 5 },
    { type: 'hr', weight: 4 },
    { type: 'legal', weight: 3 },
    { type: 'personal', weight: 2 },
    { type: 'other', weight: 1 }
  ];

  const SAMPLE_PROMPTS = {
    coding: [
      'Refactor this handler to use async/await and add a unit test for the error path',
      'Why is this Terraform plan recreating the subnet every apply?',
      'Review this pull request diff for race conditions'
    ],
    drafting: [
      'Draft a note to the division summarising the decisions from this morning',
      'Rewrite this paragraph so it is clearer for a non-technical reader',
      'Draft talking points for the quarterly update'
    ],
    comprehension: [
      'Summarise the key points of the attached consultation response in bullet points',
      'Extract the obligations from this document and list them by owner'
    ],
    data: [
      'Write a SQL query to group applications by region and count approvals per month',
      'What Excel formula gives me a running total that ignores blanks?'
    ],
    policy: [
      'Compare these two regulatory frameworks and set out the main differences',
      'Draft an options paper structure for this policy question'
    ],
    research: ['Find background on how other jurisdictions handle this and cite sources'],
    citizen: ['Draft a reply to this enquiry from a member of the public about their appeal'],
    procurement: ['Draft evaluation criteria for this tender covering security and support'],
    translation: ['Translate this public notice into simplified Chinese and Malay'],
    learning: ['Explain in simple terms how retrieval-augmented generation works'],
    hr: ['Draft a job description and interview questions for the senior analyst role'],
    comms: ['Draft key messages and a holding statement for the media query on this'],
    appraisal: ['Help me write my mid-year self-assessment covering achievements this year'],
    legal: ['What is our liability exposure under this indemnity clause'],
    personal: ['Suggest a workout plan and a recipe for this week'],
    other: ['Tidy up my notes from today']
  };

  // Named assets so the sample report exercises the agent / shared-usage view.
  const ASSETS = [
    { key: 'a1', name: 'Policy Brief Builder', type: 'gpt', site: 'chatgpt', shared: true,  weight: 16 },
    { key: 'a2', name: 'Enquiry Reply Drafter', type: 'gem', site: 'gemini', shared: true,  weight: 12 },
    { key: 'a3', name: 'Tender Spec Reviewer', type: 'project', site: 'claude', shared: true, weight: 10 },
    { key: 'a4', name: 'Codebase Q&A', type: 'project', site: 'claude', shared: false, weight: 9 },
    { key: 'a5', name: 'Minutes Summariser', type: 'gpt', site: 'chatgpt', shared: false, weight: 5 },
    { key: 'a6', name: 'Grant Assessor (draft)', type: 'gem', site: 'gemini', shared: false, weight: 1 }
  ];

  const SURFACE_FLAGS = ['canvas', 'deep_research', 'search', 'code_interpreter'];

  function pick(list) {
    const total = list.reduce((s, x) => s + x.weight, 0);
    let n = Math.random() * total;
    for (const x of list) { n -= x.weight; if (n <= 0) return x; }
    return list[list.length - 1];
  }

  function jitter(base, spread) {
    return Math.max(0, Math.round(base + (Math.random() - 0.5) * spread));
  }

  /**
   * @param {number} weeks how far back to generate
   * @param {object} settings
   * @returns {Array} events ready for VG.db.add
   */
  VG.generateDemo = function (weeks, settings) {
    const out = [];
    const days = (weeks || 5) * 7;
    const now = Date.now();
    const includeText = settings && settings.captureLevel !== VG.CAPTURE_LEVELS.METADATA;

    for (let d = days; d >= 0; d--) {
      const dayTs = VG.startOfDay(VG.addDays(now, -d));
      const dow = new Date(dayTs).getDay();
      if (dow === 0 || dow === 6) { if (Math.random() > 0.18) continue; }

      // volume drifts upward over the window so trends are visible
      const ramp = 1 + (days - d) / days * 0.7;
      const count = Math.max(0, Math.round((3 + Math.random() * 7) * ramp));

      let conv = 0;
      let turn = 0;
      let convHash = '';
      for (let i = 0; i < count; i++) {
        if (turn === 0 || Math.random() > 0.45) {
          conv++;
          turn = 1;
          convHash = 'demo-' + VG.localDay(dayTs) + '-' + conv;
        } else {
          turn++;
        }

        const site = pick(SITES).id;
        const workType = pick(MIX).type;
        const hour = 8 + Math.floor(Math.random() * 11);
        const ts = dayTs + hour * 3600000 + Math.floor(Math.random() * 3600000);
        const prompts = SAMPLE_PROMPTS[workType] || SAMPLE_PROMPTS.other;
        const text = prompts[Math.floor(Math.random() * prompts.length)];

        const hasSensitive = Math.random() < 0.09;
        const hits = {};
        if (hasSensitive) {
          const kind = ['email', 'phone', 'nric', 'assigned_secret'][Math.floor(Math.random() * 4)];
          hits[kind] = 1;
        }

        // ~30% of prompts go to a named Project / GPT / Gem rather than blank chat.
        let surface = 'chat';
        let surfaceLabel = 'Plain chat';
        let asset = null;
        if (Math.random() < 0.3) {
          asset = pick(ASSETS);
          if (asset.site === site) {
            surface = asset.type === 'project' ? 'project' : 'custom_agent';
            surfaceLabel = asset.type === 'gpt' ? 'Custom GPT' : asset.type === 'gem' ? 'Gem' : 'Project';
          } else {
            asset = null;
          }
        }
        const flags = [];
        if (Math.random() < 0.12) flags.push(SURFACE_FLAGS[Math.floor(Math.random() * SURFACE_FLAGS.length)]);

        const copied = Math.random() < 0.24 ? jitter(600, 900) : 0;
        // Point-of-use answers only exist where output was actually used.
        const saved = copied >= 200 && Math.random() < 0.28
          ? [0, 15, 15, 60, 60, 120][Math.floor(Math.random() * 6)]
          : null;

        const ev = Object.assign(VG.newEvent(), {
          ts,
          day: VG.localDay(ts),
          site,
          surface,
          surfaceLabel,
          surfaceFlags: flags,
          agentKey: asset ? 'demo-' + asset.key : '',
          agentName: asset ? asset.name : '',
          agentType: asset ? asset.type : '',
          shared: asset ? asset.shared : false,
          host: site + '.example',
          model: '',
          conversationHash: convHash,
          turn,
          promptChars: jitter(text.length * 2, 120),
          promptWords: jitter(text.split(/\s+/).length * 2, 24),
          promptText: includeText ? text : '',
          workType,
          workTypeLabel: VG.taxonomyById(workType).label,
          workTypeConfidence: Math.round((0.4 + Math.random() * 0.5) * 100) / 100,
          workTypeSource: turn > 1 && Math.random() < 0.35 ? 'inherited' : 'direct',
          nonWork: VG.isNonWork(workType),
          accountTier: VG.isNonWork(workType) || Math.random() < 0.06 ? 'personal' : 'enterprise',
          redactionHits: hits,
          redactionCount: hasSensitive ? 1 : 0,
          attachments: Math.random() < 0.12 ? 1 : 0,
          firstTokenMs: jitter(1100, 900),
          responseMs: jitter(9000, 7000),
          responseChars: jitter(1400, 1600),
          responseHasCode: workType === 'coding' && Math.random() < 0.8,
          regenerated: Math.random() < 0.07 ? 1 : 0,
          copiedOut: copied,
          savedMinutes: saved,
          demo: true
        });
        out.push(ev);
      }
    }
    return out;
  };
})(typeof self !== 'undefined' ? self : globalThis);
