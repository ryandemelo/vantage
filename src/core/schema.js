/*
 * Vantage, schema.js
 * Shared constants: work-type taxonomy, default settings, event shape.
 * Loaded as a classic script in content scripts, the service worker and UI pages.
 * Everything hangs off globalThis.VG so no bundler is required.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  VG.VERSION = '0.1.0';
  VG.DB_NAME = 'vantage';
  VG.DB_VERSION = 1;

  /* ------------------------------------------------------------------ *
   * Work-type taxonomy
   *
   * Each category scores a prompt by keyword hits. `terms` are matched on
   * word boundaries and weighted; `patterns` are regexes with a heavier
   * weight for high-signal structures (code fences, SQL, etc).
   * Admins can extend terms via managed policy without touching this file.
   * ------------------------------------------------------------------ */
  VG.TAXONOMY = [
    {
      id: 'drafting',
      label: 'Drafting & correspondence',
      colour: '#4C7DF0',
      terms: [
        ['draft', 3], ['write an email', 5], ['write a letter', 5], ['reply to', 3],
        ['memo', 4], ['minutes', 3], ['rewrite', 3], ['reword', 3],
        ['tone', 2], ['proofread', 4], ['make it more formal', 4], ['shorten this', 3],
        ['circular', 3], ['agenda', 2], ['thank you note', 3], ['covering note', 4],
        ['tidy up this', 4], ['polish this', 4]
      ],
      patterns: []
    },
    {
      id: 'comms',
      label: 'Communications & engagement',
      colour: '#0891B2',
      terms: [
        ['press release', 6], ['media query', 6], ['media response', 6],
        ['talking points', 5], ['speech', 4], ['announcement', 4], ['newsletter', 4],
        ['social media post', 6], ['linkedin post', 5], ['campaign', 4],
        ['key messages', 6], ['holding statement', 6], ['spokesperson', 5],
        ['op-ed', 6], ['public communication', 5], ['comms plan', 6],
        ['engagement plan', 5], ['townhall', 5], ['public statement', 5],
        ['messaging', 3], ['audience', 3]
      ],
      patterns: [],
      anti: [[/```/, -5]]
    },
    {
      id: 'policy',
      label: 'Policy & governance',
      colour: '#8B5CF6',
      terms: [
        ['policy', 4], ['regulation', 4], ['standard operating', 5],
        ['clause', 3], ['compliance', 3], ['framework', 3], ['control', 2],
        ['guideline', 3], ['impact assessment', 5], ['options paper', 5],
        ['consultation', 3], ['white paper', 4], ['governance', 3],
        ['stakeholder', 2], ['mandate', 2], ['directive', 3], ['position paper', 4]
      ],
      patterns: [],
      anti: [[/```/, -5], [/\b(iam|bucket|s3|kubernetes|network|retry|cors|password)\s+polic/i, -8]]
    },
    {
      id: 'comprehension',
      label: 'Document comprehension',
      colour: '#0EA5A4',
      terms: [
        ['summarise', 5], ['summarize', 5], ['summary of', 4], ['tl;dr', 5],
        ['key points', 4], ['extract', 4], ['what does this say', 4],
        ['review this document', 5], ['read the attached', 4], ['bullet points', 3],
        ['condense', 4], ['main takeaways', 4], ['compare these documents', 5]
      ],
      patterns: []
    },
    {
      id: 'translation',
      label: 'Translation & localisation',
      colour: '#F59E0B',
      terms: [
        ['translate', 6], ['in chinese', 3], ['in malay', 3], ['in tamil', 3],
        ['in spanish', 3], ['in french', 3], ['localise', 4], ['localize', 4],
        ['simplified chinese', 4], ['bahasa', 3], ['plain english', 3]
      ],
      patterns: []
    },
    {
      id: 'coding',
      label: 'Software engineering',
      colour: '#22C55E',
      terms: [
        ['function', 3], ['refactor', 5], ['debug', 5], ['stack trace', 5],
        ['unit test', 5], ['typescript', 4], ['javascript', 4], ['python', 4],
        ['java ', 3], ['golang', 4], ['dockerfile', 5], ['kubernetes', 4],
        ['terraform', 5], ['api endpoint', 4], ['pull request', 4], ['git ', 3],
        ['compile', 3], ['exception', 3], ['regex', 4], ['null pointer', 4],
        ['npm', 3], ['pip install', 4], ['ci/cd', 4], ['bug', 2]
      ],
      patterns: [
        [/```/, 6],
        [/\b(def |class |import |const |let |var |function\s*\()/, 4],
        [/\b(err|error)\s*:\s*/i, 2],
        [/\/[a-z0-9_\-.]+\.(js|ts|py|go|java|rb|cs|rs|sh|yml|yaml|json)\b/i, 4]
      ]
    },
    {
      id: 'data',
      label: 'Data & analytics',
      colour: '#06B6D4',
      terms: [
        ['sql', 6], ['query', 3], ['dataset', 4], ['excel', 5], ['formula', 4],
        ['pivot', 5], ['vlookup', 6], ['spreadsheet', 4], ['chart', 3],
        ['statistic', 4], ['regression', 5], ['forecast', 4], ['dashboard', 3],
        ['power bi', 5], ['tableau', 5], ['csv', 4], ['aggregate', 3],
        ['correlation', 4], ['data quality', 4]
      ],
      patterns: [
        [/\b(select|insert|update|delete)\b[\s\S]{0,80}\bfrom\b/i, 7],
        [/\bgroup\s+by\b/i, 5],
        [/=\s*(sum|average|countif|index|match|xlookup)\s*\(/i, 6]
      ]
    },
    {
      id: 'procurement',
      label: 'Procurement & contracts',
      colour: '#EC4899',
      terms: [
        ['tender', 6], ['rfp', 6], ['rfq', 6], ['itq', 5], ['procurement', 6],
        ['vendor', 4], ['supplier', 3], ['contract', 4], ['sow', 4],
        ['statement of work', 6], ['evaluation criteria', 5], ['bid', 4],
        ['quotation', 4], ['sla', 4], ['terms and conditions', 4], ['ariba', 6]
      ],
      patterns: [],
      anti: [[/\bsmart contract\b/i, -8], [/```/, -3]]
    },
    {
      id: 'support',
      label: 'Customer & service delivery',
      colour: '#F97316',
      terms: [
        ['enquiry', 5], ['inquiry', 4], ['complaint', 5], ['feedback from', 4],
        ['customer', 4], ['client', 3], ['account manager', 4],
        ['faq', 4], ['service level', 4], ['case note', 4], ['refund', 4],
        ['support ticket', 5], ['helpdesk', 4], ['ticket', 2], ['escalation', 3]
      ],
      patterns: []
    },
    {
      id: 'research',
      label: 'Research & discovery',
      colour: '#6366F1',
      terms: [
        ['research', 4], ['find out', 3], ['background on', 4], ['literature', 5],
        ['best practice', 4], ['benchmark', 4], ['what are the options', 4],
        ['pros and cons', 4], ['compare', 3], ['case study', 4],
        ['market scan', 5], ['landscape', 3], ['evidence', 3], ['citation', 4]
      ],
      patterns: []
    },
    {
      id: 'media',
      label: 'Media & presentation',
      colour: '#A855F7',
      terms: [
        ['slide', 5], ['deck', 4], ['powerpoint', 5], ['presentation', 4],
        ['poster', 4], ['infographic', 5], ['image of', 4], ['generate an image', 6],
        ['logo', 4], ['video script', 5], ['storyboard', 4], ['thumbnail', 3],
        ['diagram', 4], ['mockup', 4]
      ],
      patterns: []
    },
    {
      id: 'learning',
      label: 'Learning & upskilling',
      colour: '#14B8A6',
      terms: [
        ['explain', 4], ['what is', 3], ['how do i', 4], ['teach me', 5],
        ['walk me through', 5], ['difference between', 4], ['in simple terms', 5],
        ['eli5', 6], ['tutorial', 4], ['learn', 3], ['beginner', 3], ['example of', 3]
      ],
      patterns: []
    },
    {
      id: 'admin',
      label: 'Admin & scheduling',
      colour: '#94A3B8',
      terms: [
        ['schedule', 4], ['calendar', 4], ['reminder', 4], ['to-do', 4],
        ['todo list', 4], ['checklist', 3], ['expense claim', 5],
        ['leave application', 4], ['book a meeting', 5], ['minutes template', 4]
      ],
      patterns: []
    },
    {
      id: 'hr',
      label: 'People & HR',
      colour: '#DB2777',
      terms: [
        ['job description', 6], ['recruitment', 5], ['hiring', 5], ['shortlist', 4],
        ['interview question', 6], ['candidate', 4],
        ['onboarding', 5], ['offboarding', 5], ['exit interview', 6],
        ['grievance', 5], ['disciplinary', 5], ['headcount', 4], ['succession', 4],
        ['competency framework', 6], ['training plan', 4], ['staff welfare', 5],
        ['workforce plan', 5], ['job posting', 5], ['reference check', 5]
      ],
      patterns: [],
      anti: [[/```/, -5]]
    },
    {
      id: 'appraisal',
      label: 'Performance appraisal',
      colour: '#F43F5E',
      terms: [
        ['performance appraisal', 7], ['appraisal', 6], ['performance review', 6],
        ['self-assessment', 6], ['self assessment', 6], ['mid-year review', 6],
        ['year-end review', 6], ['performance rating', 6], ['potential rating', 6],
        ['ranking exercise', 6], ['work plan', 4], ['work review', 5],
        ['kpi', 4], ['key results', 4], ['competency assessment', 6],
        ['development plan', 5], ['career conversation', 5], ['360 feedback', 6],
        ['write my appraisal', 7], ['appraisal comments', 7], ['justification for promotion', 6],
        ['strengths and areas for improvement', 6], ['achievements this year', 5]
      ],
      patterns: [],
      anti: [[/```/, -5]]
    },
    {
      id: 'legal',
      label: 'Legal & compliance advice',
      colour: '#7C3AED',
      terms: [
        ['legal advice', 6], ['legal opinion', 6], ['liability', 5], ['indemnity', 6],
        ['litigation', 6], ['plaintiff', 6], ['defendant', 6], ['affidavit', 6],
        ['statutory duty', 5], ['jurisdiction', 4], ['legal precedent', 5],
        ['non-disclosure', 5], ['intellectual property', 5], ['copyright', 4],
        ['data protection', 4], ['pdpa', 6], ['gdpr', 5], ['enforcement action', 5],
        ['breach of contract', 5], ['due diligence', 4]
      ],
      patterns: [],
      // "IAM policy" and "bucket policy" are engineering, not law.
      anti: [[/```/, -5], [/\b(iam|bucket|s3|kubernetes|network|retry|cors)\s+polic/i, -6]]
    },
    {
      id: 'personal',
      label: 'Personal / non-work',
      colour: '#A3A3A3',
      nonWork: true,
      terms: [
        ['recipe', 6], ['holiday to', 5], ['vacation', 5], ['flight to', 5],
        ['hotel in', 5], ['itinerary', 4], ['workout', 5], ['gym', 4],
        ['my dog', 5], ['my cat', 5], ['birthday', 4], ['gift idea', 5],
        ['wedding', 4], ['my landlord', 5], ['personal loan', 5], ['diet', 4],
        ['symptom', 5], ['my child', 5], ['my son', 5], ['my daughter', 5],
        ['netflix', 5], ['video game', 5], ['dating', 5], ['shopping list', 5]
      ],
      patterns: [],
      // Anything with code or business unit vocabulary is work, whatever else it says.
      anti: [[/```/, -8], [/\b(team|department|division|customer|client|stakeholder)\b/i, -4]]
    },
    {
      id: 'other',
      label: 'Uncategorised',
      colour: '#64748B',
      terms: [],
      patterns: []
    }
  ];

  VG.isNonWork = function (id) {
    const c = VG.TAXONOMY.find((x) => x.id === id);
    return !!(c && c.nonWork);
  };

  VG.taxonomyById = function (id) {
    return VG.TAXONOMY.find((c) => c.id === id) || VG.TAXONOMY[VG.TAXONOMY.length - 1];
  };

  /* ------------------------------------------------------------------ *
   * Capture levels
   * ------------------------------------------------------------------ */
  VG.CAPTURE_LEVELS = {
    METADATA: 'metadata',   // counts, timings, categories. No prompt text at all.
    REDACTED: 'redacted',   // prompt text stored AFTER redaction (default)
    FULL: 'full'            // raw prompt text. Off unless explicitly unlocked.
  };

  /* ------------------------------------------------------------------ *
   * Default settings. Managed policy overrides these and locks the field.
   * ------------------------------------------------------------------ */
  VG.DEFAULT_SETTINGS = {
    enabled: true,
    pausedUntil: 0,                      // epoch ms; 0 = not paused
    captureLevel: VG.CAPTURE_LEVELS.REDACTED,

    /* How much of the page the content script is allowed to read.
       minimal , the composer only. Response timing comes from mutation
                  events, copy-out from the copy event alone, account tier
                  from the plan badge. Nothing else is read into memory.
       standard, additionally reads response text (for length and code
                  detection), the selection (for copied character count) and
                  the account-menu address (domain only). Opt in deliberately. */
    domScope: 'minimal',
    allowFullText: false,                // must be true before FULL can be selected
    storeResponseText: false,            // response text is never stored in v1
    retentionDays: 180,
    disabledSites: [],                   // adapter ids the user switched off
    customAdapters: [],                  // user/admin defined site adapters
    customRedactors: [],                 // [{id,label,pattern,flags,replacement}]
    redactorsOff: [],                    // built-in redactor ids to disable
    redactorsOn: [],                     // opt-in (noisy) redactor ids to enable
    sensitiveWordlist: [],               // exact terms to always mask (project names etc)
    showCaptureToast: true,              // brief on-page confirmation when a prompt is logged
    extraTaxonomyTerms: {},              // { categoryId: [["term", weight], ...] }
    reportEmailTo: '',
    weekStartsOn: 1,                     // 1 = Monday
    firstRunDone: false,

    /* Organisation attribution. All of this is pushed, or derived locally
       from the signed-in profile domain, never typed by the user. */
    orgUnit: '',                       // e.g. "Engineering"
    orgDivision: '',                     // optional, only if policy can target groups
    orgCohort: '',                       // rollout wave / comparison group label
    orgDomainMap: {},                 // { "eng.acme.example": "Engineering" }
    corporateDomains: [],                // domains counted as corporate accounts
    deriveIdentity: false,               // use the optional identity permission to read the profile domain

    /* Site config pushed from central. Managed-only: never written locally. */
    policyAdapters: [],                  // same shape as customAdapters, wins over them
    siteConfigVersion: '',               // free-text stamp shown in Settings, e.g. "2026-09-04-a"

    /* ------------------------------------------------------------------
       Scheduled upload to an internal endpoint. Every one of these is
       POLICY-ONLY: the extension refuses to set them from the UI or from a
       message, so a user cannot point their own reports at their own server.
       Off unless an administrator turns it on. ------------------------- */
    uploadEnabled: false,
    uploadUrl: '',                       // https endpoint, e.g. a blob store or collector
    uploadAuthHeader: '',                // sent verbatim as Authorization
    uploadCadence: 'weekly',             // daily | weekly | monthly
    uploadContent: 'aggregate',          // summary | aggregate | events
    uploadIncludePromptText: false,      // extra gate on top of uploadContent 'events'

    /* Tamper-evidence on exported reports. Push one key org-wide so a central
       verifier can check any report; otherwise each install signs with its own
       generated key and only it can verify its own output. */
    reportSigningKey: '',

    /* Point-of-value micro-survey. Off until an org signs it off. */
    valueSurveyEnabled: false,
    valueSurveySamplePercent: 7,         // percent of eligible moments that ask
    valueSurveyCooldownMin: 240          // never ask the same person twice inside this window
  };

  /*
   * Settings that may ONLY come from managed policy. `VG.settings.set` refuses
   * them, so neither the options page nor a message from a content script can
   * change where data goes or whether it goes at all.
   */
  VG.POLICY_ONLY_KEYS = [
    'uploadEnabled', 'uploadUrl', 'uploadAuthHeader',
    'uploadCadence', 'uploadContent', 'uploadIncludePromptText'
  ];

  /* Which settings a managed policy is allowed to pin. */
  VG.MANAGED_KEYS = [
    'enabled', 'captureLevel', 'domScope', 'allowFullText', 'retentionDays', 'disabledSites',
    'customAdapters', 'customRedactors', 'redactorsOff', 'redactorsOn',
    'sensitiveWordlist', 'showCaptureToast', 'extraTaxonomyTerms',
    'reportEmailTo', 'weekStartsOn',
    'policyAdapters', 'siteConfigVersion',
    'reportSigningKey',
    'orgUnit', 'orgDivision', 'orgCohort', 'orgDomainMap',
    'corporateDomains', 'deriveIdentity',
    'valueSurveyEnabled', 'valueSurveySamplePercent', 'valueSurveyCooldownMin',
    'uploadEnabled', 'uploadUrl', 'uploadAuthHeader',
    'uploadCadence', 'uploadContent', 'uploadIncludePromptText'
  ];

  /* ------------------------------------------------------------------ *
   * Event shape written to IndexedDB. Documented here so a reviewer can
   * see exactly what leaves the page. Nothing here ever leaves the device
   * unless the user explicitly exports or emails a report.
   * ------------------------------------------------------------------ */
  VG.EVENT_FIELDS = [
    'id',                // auto increment
    'ts',                // epoch ms of submit
    'day',               // YYYY-MM-DD local, for fast range queries
    'site',              // adapter id: claude | chatgpt | gemini | custom:<id>
    'host',              // hostname
    'model',             // best-effort model label from the UI, or ''
    'surface',           // chat | project | custom_agent | ... which part of the platform
    'surfaceLabel',
    'surfaceFlags',      // secondary surfaces active at the same time (canvas, search…)
    'agentKey',          // sha256 of the GPT/Gem/Project id, stable, not reversible
    'agentName',         // display name, redacted through the org wordlist
    'agentType',         // gpt | gem | project | agent
    'shared',            // true when the agent/project is shared with a team
    'conversationHash',  // sha256(conversationId) truncated, never the raw id
    'turn',              // 1-based turn index within the conversation
    'promptChars',
    'promptWords',
    'promptText',        // '' unless captureLevel is redacted/full
    'workType',          // taxonomy id
    'workTypeLabel',
    'workTypeConfidence',
    'workTypeRunnerUp',
    'workTypeSecondary',  // second intent when a prompt clearly does two things
    'workTypeSource',     // direct | inherited (short follow-up turns borrow the thread's topic)
    'nonWork',            // true when the category is flagged as non-work
    'accountTier',        // enterprise | team | free | unknown, read from the site's own plan badge
    'redactionHits',     // { detectorId: count }
    'redactionCount',
    'attachments',       // count of files attached at submit time
    'firstTokenMs',      // latency to first visible response token
    'responseMs',        // latency to response quiescence
    'responseChars',
    'responseHasCode',
    'regenerated',       // times user hit regenerate on this turn
    'copyEvents',        // times output was copied out after this turn
    'copyLarge',         // of those, how many looked substantial (geometry, not text)
    'copiedOut',         // chars copied, 0 unless domScope is 'standard'
    'savedMinutes',      // self-reported, from the point-of-value prompt: 0|15|60|120
    'qualityRating',     // self-reported: -1 worse, 0 same, 1 better than doing it alone
    'schemaVersion'
  ];

  VG.newEvent = function () {
    return {
      ts: Date.now(),
      day: VG.localDay(Date.now()),
      site: '',
      host: '',
      model: '',
      surface: 'chat',
      surfaceLabel: 'Chat',
      surfaceFlags: [],
      agentKey: '',
      agentName: '',
      agentType: '',
      shared: false,
      conversationHash: '',
      turn: 1,
      promptChars: 0,
      promptWords: 0,
      promptText: '',
      workType: 'other',
      workTypeLabel: 'Uncategorised',
      workTypeConfidence: 0,
      workTypeRunnerUp: '',
      workTypeSecondary: '',
      workTypeSource: 'direct',
      nonWork: false,
      accountTier: 'unknown',
      redactionHits: {},
      redactionCount: 0,
      attachments: 0,
      firstTokenMs: null,
      responseMs: null,
      responseChars: 0,
      responseHasCode: false,
      regenerated: 0,
      copyEvents: 0,
      copyLarge: 0,
      copiedOut: 0,
      savedMinutes: null,
      qualityRating: null,
      schemaVersion: 4
    };
  };

  /* ------------------------------------------------------------------ *
   * Small date helpers shared everywhere. All local time, reports are
   * read by humans in their own timezone.
   * ------------------------------------------------------------------ */
  VG.localDay = function (ts) {
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  };

  VG.startOfDay = function (ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  VG.startOfWeek = function (ts, weekStartsOn) {
    const start = weekStartsOn === undefined ? 1 : weekStartsOn;
    const d = new Date(VG.startOfDay(ts));
    const diff = (d.getDay() - start + 7) % 7;
    d.setDate(d.getDate() - diff);
    return d.getTime();
  };

  VG.startOfMonth = function (ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };

  VG.addDays = function (ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  };

  VG.addMonths = function (ts, n) {
    const d = new Date(ts);
    d.setMonth(d.getMonth() + n);
    return d.getTime();
  };

  VG.fmtDate = function (ts) {
    return new Date(ts).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  };

  VG.fmtDateShort = function (ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  /* sha256 hex, truncated. Used so conversation ids are never stored raw. */
  VG.hash = async function (text, len) {
    const bytes = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex.slice(0, len || 16);
  };
})(typeof self !== 'undefined' ? self : globalThis);
