/*
 * Vantage — report.js
 * Turns raw events into a period report plus a written summary.
 * Pure functions over an array of events; no storage or DOM access, so it can
 * be unit-tested and reused by the popup, the reports page and any exporter.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  function median(nums) {
    const a = nums.filter((n) => typeof n === 'number' && !isNaN(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const mid = a.length >> 1;
    return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
  }

  function pct(n, d) {
    return d ? Math.round((n / d) * 1000) / 10 : 0;
  }

  function delta(now, before) {
    if (!before) return now ? { dir: 'new', pct: null } : { dir: 'flat', pct: 0 };
    const change = Math.round(((now - before) / before) * 1000) / 10;
    return { dir: change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat', pct: change };
  }

  /* ------------------------------------------------------------------ *
   * Standard periods
   * ------------------------------------------------------------------ */
  VG.periods = function (settings, now) {
    const t = now || Date.now();
    const ws = (settings && settings.weekStartsOn) !== undefined ? settings.weekStartsOn : 1;
    const thisWeek = VG.startOfWeek(t, ws);
    const lastWeek = VG.addDays(thisWeek, -7);
    const thisMonth = VG.startOfMonth(t);
    const lastMonth = VG.addMonths(thisMonth, -1);

    return {
      'this-week': { id: 'this-week', label: 'This week', from: thisWeek, to: VG.addDays(thisWeek, 7), prevFrom: lastWeek, grain: 'week' },
      'last-week': { id: 'last-week', label: 'Last week', from: lastWeek, to: thisWeek, prevFrom: VG.addDays(lastWeek, -7), grain: 'week' },
      'this-month': { id: 'this-month', label: 'This month', from: thisMonth, to: VG.addMonths(thisMonth, 1), prevFrom: lastMonth, grain: 'month' },
      'last-month': { id: 'last-month', label: 'Last month', from: lastMonth, to: thisMonth, prevFrom: VG.addMonths(lastMonth, -1), grain: 'month' },
      'last-30': { id: 'last-30', label: 'Last 30 days', from: VG.addDays(VG.startOfDay(t), -29), to: VG.addDays(VG.startOfDay(t), 1), prevFrom: VG.addDays(VG.startOfDay(t), -59), grain: 'range' },
      'all-time': { id: 'all-time', label: 'All time', from: 0, to: t + 1, prevFrom: null, grain: 'range' }
    };
  };

  /* ------------------------------------------------------------------ *
   * Aggregation
   * ------------------------------------------------------------------ */
  function aggregate(events) {
    const a = {
      prompts: events.length,
      days: {},
      hours: new Array(24).fill(0),
      sites: {},
      models: {},
      workTypes: {},
      conversations: {},
      redactionsByType: {},
      redactionTotal: 0,
      promptsWithSensitive: 0,
      promptChars: [],
      promptWords: [],
      firstTokenMs: [],
      responseChars: [],
      copiedOut: 0,
      copyEvents: 0,
      copyLarge: 0,
      responseCharsSeen: 0,
      regenerated: 0,
      attachments: 0,
      nonWork: 0,
      accountTiers: {},
      inherited: 0,
      lowConfidence: 0,
      secondary: {}
    };

    events.forEach((e) => {
      a.days[e.day] = (a.days[e.day] || 0) + 1;
      a.hours[new Date(e.ts).getHours()]++;
      a.sites[e.site] = (a.sites[e.site] || 0) + 1;
      if (e.model) a.models[e.model] = (a.models[e.model] || 0) + 1;
      a.workTypes[e.workType] = (a.workTypes[e.workType] || 0) + 1;

      const c = a.conversations[e.conversationHash] || { turns: 0, site: e.site, copied: false, regen: false };
      c.turns = Math.max(c.turns, e.turn || 1);
      if (e.copyEvents || e.copiedOut) c.copied = true;
      if (e.regenerated) c.regen = true;
      a.conversations[e.conversationHash] = c;

      if (e.redactionCount) {
        a.redactionTotal += e.redactionCount;
        a.promptsWithSensitive++;
        Object.entries(e.redactionHits || {}).forEach(([k, v]) => {
          a.redactionsByType[k] = (a.redactionsByType[k] || 0) + v;
        });
      }
      a.promptChars.push(e.promptChars || 0);
      a.promptWords.push(e.promptWords || 0);
      if (typeof e.firstTokenMs === 'number') a.firstTokenMs.push(e.firstTokenMs);
      if (e.responseChars) a.responseChars.push(e.responseChars);
      // copyEvents is recorded under every scope; copiedOut chars only under
      // 'standard'. Rate must therefore come from the count, not the chars.
      if (e.copyEvents) a.copyEvents += e.copyEvents;
      else if (e.copiedOut) a.copyEvents++;   // events written before v4
      if (e.copyLarge) a.copyLarge += e.copyLarge;
      if (e.copiedOut) a.copiedOut += e.copiedOut;
      if (e.responseChars) a.responseCharsSeen++;
      a.regenerated += e.regenerated || 0;
      if (e.attachments) a.attachments += e.attachments;
      if (e.nonWork) a.nonWork++;
      const tier = e.accountTier || 'unknown';
      a.accountTiers[tier] = (a.accountTiers[tier] || 0) + 1;
      if (e.workTypeSource === 'inherited') a.inherited++;
      if (!e.workTypeConfidence || e.workTypeConfidence < 0.25) a.lowConfidence++;
      if (e.workTypeSecondary) a.secondary[e.workTypeSecondary] = (a.secondary[e.workTypeSecondary] || 0) + 1;
    });

    return a;
  }

  function daySeries(from, to, days) {
    const out = [];
    let cursor = VG.startOfDay(from);
    const end = Math.min(to, Date.now() + 86400000);
    let guard = 0;
    while (cursor < end && guard++ < 400) {
      const key = VG.localDay(cursor);
      out.push({ ts: cursor, day: key, count: days[key] || 0 });
      cursor = VG.addDays(cursor, 1);
    }
    return out;
  }

  function percentile(nums, p) {
    const a = nums.filter((n) => typeof n === 'number' && !isNaN(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const i = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
    return a[i];
  }

  /* ------------------------------------------------------------------ *
   * Sustained use. Computed over a long window (default 90 days) because
   * "did they come back" is the only adoption question that survives the
   * novelty period, and it needs more than one reporting period to answer.
   * ------------------------------------------------------------------ */
  function buildAdoption(longEvents, settings, now) {
    const ws = (settings && settings.weekStartsOn) !== undefined ? settings.weekStartsOn : 1;
    const t = now || Date.now();
    const weeks = [];
    for (let i = 0; i < 8; i++) {
      const start = VG.addDays(VG.startOfWeek(t, ws), -7 * i);
      weeks.push({ start, end: VG.addDays(start, 7), prompts: 0, days: {} });
    }
    const days28 = {};
    const days7 = {};
    const cut28 = VG.addDays(VG.startOfDay(t), -27);
    const cut7 = VG.addDays(VG.startOfDay(t), -6);

    (longEvents || []).forEach((e) => {
      weeks.forEach((w) => {
        if (e.ts >= w.start && e.ts < w.end) { w.prompts++; w.days[e.day] = 1; }
      });
      if (e.ts >= cut28) days28[e.day] = 1;
      if (e.ts >= cut7) days7[e.day] = 1;
    });

    const last6 = weeks.slice(0, 6);
    const activeWeeks6 = last6.filter((w) => w.prompts > 0).length;
    const activeDays28 = Object.keys(days28).length;

    // Weekly trend, oldest first, for the sparkline.
    const weekly = weeks.slice().reverse().map((w) => ({
      start: w.start,
      prompts: w.prompts,
      activeDays: Object.keys(w.days).length
    }));

    const stamps = (longEvents || []).map((e) => e.ts).sort((a, b) => a - b);
    const firstSeen = stamps.length ? stamps[0] : null;
    const lastSeen = stamps.length ? stamps[stamps.length - 1] : null;
    const daysSinceLastUse = lastSeen ? Math.floor((t - lastSeen) / 86400000) : null;
    // Someone who came back for a second week got past the first try.
    const distinctWeeks = {};
    (longEvents || []).forEach((e) => { distinctWeeks[VG.startOfWeek(e.ts, ws)] = 1; });

    return {
      firstSeen,
      lastSeen,
      daysSinceLastUse,
      lapsed: daysSinceLastUse !== null && daysSinceLastUse >= 14,
      activated: Object.keys(distinctWeeks).length >= 2,
      weeksObserved: weeks.filter((w) => w.prompts > 0).length,
      activeWeeksOf6: activeWeeks6,
      sustained: activeWeeks6 >= 4,
      activeDays28,
      activeDays7: Object.keys(days7).length,
      stickiness28: Math.round((activeDays28 / 28) * 1000) / 10,
      weekly,
      trajectory: (() => {
        const recent = weekly.slice(-3).reduce((s, w) => s + w.prompts, 0);
        const older = weekly.slice(-6, -3).reduce((s, w) => s + w.prompts, 0);
        if (!older && !recent) return 'none';
        if (!older) return 'starting';
        const ch = (recent - older) / older;
        return ch > 0.15 ? 'growing' : ch < -0.15 ? 'declining' : 'steady';
      })()
    };
  }

  /* ------------------------------------------------------------------ *
   * Small samples. At low volume a share is not a finding — "40% coding" off
   * five prompts is noise with a percent sign on it. Everything downstream
   * checks this before quoting a share.
   * ------------------------------------------------------------------ */
  function sampleBand(n) {
    if (n < 10) return 'too-few';
    if (n < 30) return 'indicative';
    return 'reportable';
  }

  function buildVolume(events, adoption) {
    const n = events.length;
    const band = sampleBand(n);
    return {
      n,
      band,
      quoteShares: band === 'reportable',
      note: {
        'too-few': 'Fewer than 10 prompts. Report counts, never percentages — a share computed on this many is noise.',
        indicative: 'Between 10 and 30 prompts. Shares are directional only; give the count alongside every percentage.',
        reportable: 'Enough volume for shares to mean something.'
      }[band],
      // At low volume the interesting question is not "what is it worth" but
      // "why is so little happening", so surface the funnel instead.
      headline: band === 'reportable'
        ? 'value'
        : (adoption && adoption.lapsed ? 'lapsed' : 'adoption')
    };
  }

  /* Categories that never appeared. At low usage this is more informative
   * than the ones that did: it is the map of work nobody has thought to
   * bring to the tool yet. */
  function buildUntapped(events) {
    const seen = {};
    events.forEach((e) => { seen[e.workType] = 1; });
    return VG.TAXONOMY
      .filter((c) => c.id !== 'other' && c.id !== 'personal' && !seen[c.id])
      .map((c) => ({ id: c.id, label: c.label }));
  }

  /* Did the first attempts go well? A bad first week is the commonest reason
   * someone never comes back, and it is invisible in a volume chart. */
  function buildFirstExperience(longEvents) {
    const sorted = (longEvents || []).slice().sort((a, b) => a.ts - b.ts).slice(0, 10);
    if (!sorted.length) return null;
    const copied = sorted.filter((e) => e.copyEvents || e.copiedOut).length;
    const reworked = sorted.filter((e) => e.regenerated > 0).length;
    return {
      prompts: sorted.length,
      copyRate: pct(copied, sorted.length),
      reworkRate: pct(reworked, sorted.length),
      medianWords: median(sorted.map((e) => e.promptWords || 0)),
      verdict: copied === 0
        ? 'nothing from the first attempts was used — the most likely reason someone does not come back'
        : pct(copied, sorted.length) < 20
          ? 'little of the early output was used'
          : 'early attempts produced output that got used'
    };
  }

  /* ------------------------------------------------------------------ *
   * Self-reported value. The only field that can support a time-saved
   * claim; everything else in this report is a proxy.
   * ------------------------------------------------------------------ */
  function buildValue(events) {
    const answered = events.filter((e) => typeof e.savedMinutes === 'number');
    // Only substantial copies count. A one-word copy is not evidence that a
    // task was completed, and counting it multiplies straight into the
    // extrapolated hours.
    const eligible = events.filter((e) => e.copyLarge > 0 || e.copiedOut >= 200).length;
    const n = answered.length;
    const totalMinutes = answered.reduce((s, e) => s + e.savedMinutes, 0);
    const mean = n ? totalMinutes / n : 0;

    // Standard error of the mean, used for an honest interval rather than a
    // single confident-looking number.
    let se = 0;
    if (n > 1) {
      const varr = answered.reduce((s, e) => s + Math.pow(e.savedMinutes - mean, 2), 0) / (n - 1);
      se = Math.sqrt(varr / n);
    }
    const ci = 1.96 * se;

    const quality = { better: 0, same: 0, worse: 0 };
    events.forEach((e) => {
      if (e.qualityRating === 1) quality.better++;
      else if (e.qualityRating === 0) quality.same++;
      else if (e.qualityRating === -1) quality.worse++;
    });

    return {
      responses: n,
      eligibleMoments: eligible,
      responseRate: pct(n, eligible),
      meanMinutes: Math.round(mean * 10) / 10,
      ciMinutes: Math.round(ci * 10) / 10,
      estHoursLow: Math.round((eligible * Math.max(0, mean - ci)) / 60 * 10) / 10,
      estHours: Math.round((eligible * mean) / 60 * 10) / 10,
      estHoursHigh: Math.round((eligible * (mean + ci)) / 60 * 10) / 10,
      distribution: [0, 15, 60, 120].map((m) => ({
        minutes: m,
        label: m === 0 ? 'None' : m === 15 ? '<15 min' : m === 60 ? '15–60 min' : '>1 hr',
        count: answered.filter((e) => e.savedMinutes === m).length
      })),
      quality,
      confidence: n === 0 ? 'none' : n < 20 ? 'insufficient' : n < 50 ? 'indicative' : 'reportable'
    };
  }

  /* ------------------------------------------------------------------ *
   * Surfaces, agents and shared assets.
   * ------------------------------------------------------------------ */
  function buildAgents(events, settings) {
    const surfaces = {};
    const agents = {};

    events.forEach((e) => {
      const sk = e.surface || 'chat';
      const s = surfaces[sk] || { id: sk, label: e.surfaceLabel || VG.surfaceLabel(sk), count: 0, copies: 0, saved: 0, savedN: 0 };
      s.count++;
      if (e.copyEvents || e.copiedOut) s.copies++;
      if (typeof e.savedMinutes === 'number') { s.saved += e.savedMinutes; s.savedN++; }
      surfaces[sk] = s;

      (e.surfaceFlags || []).forEach((f) => {
        const key = 'flag:' + f;
        const fs = surfaces[key] || { id: key, label: VG.surfaceLabel(f), count: 0, copies: 0, saved: 0, savedN: 0, flag: true };
        fs.count++;
        if (e.copiedOut) fs.copies++;
        surfaces[key] = fs;
      });

      if (!e.agentKey) return;
      const a = agents[e.agentKey] || {
        key: e.agentKey,
        name: e.agentName || '(unnamed)',
        type: e.agentType || 'agent',
        site: e.site,
        prompts: 0,
        conversations: {},
        copies: 0,
        copiedChars: 0,
        regens: 0,
        saved: 0,
        savedN: 0,
        shared: false,
        categories: {}
      };
      a.prompts++;
      a.conversations[e.conversationHash] = 1;
      if (e.copyEvents || e.copiedOut) { a.copies++; a.copiedChars += e.copiedOut || 0; }
      a.regens += e.regenerated || 0;
      if (typeof e.savedMinutes === 'number') { a.saved += e.savedMinutes; a.savedN++; }
      if (e.shared) a.shared = true;
      a.categories[e.workType] = (a.categories[e.workType] || 0) + 1;
      if (e.agentName && a.name === '(unnamed)') a.name = e.agentName;
      agents[e.agentKey] = a;
    });

    const surfaceList = Object.values(surfaces)
      .map((s) => ({
        id: s.id, label: s.label, flag: !!s.flag,
        count: s.count, pct: pct(s.count, events.length),
        copyRate: pct(s.copies, s.count),
        meanSaved: s.savedN ? Math.round((s.saved / s.savedN) * 10) / 10 : null
      }))
      .sort((a, b) => b.count - a.count);

    const agentList = Object.values(agents)
      .map((a) => {
        const convs = Object.keys(a.conversations).length;
        const topCat = Object.entries(a.categories).sort((x, y) => y[1] - x[1])[0];
        return {
          key: a.key,
          name: a.name,
          type: a.type,
          site: a.site,
          siteLabel: VG.adapterLabel(a.site, settings),
          prompts: a.prompts,
          conversations: convs,
          copyRate: pct(a.copies, a.prompts),
          copiedChars: a.copiedChars,
          reworkRate: pct(a.regens, a.prompts),
          meanSaved: a.savedN ? Math.round((a.saved / a.savedN) * 10) / 10 : null,
          shared: a.shared,
          topCategory: topCat ? VG.taxonomyById(topCat[0]).label : '',
          // One conversation and never reused: it was built and abandoned.
          orphan: convs <= 1 && a.prompts <= 2
        };
      })
      .sort((a, b) => b.prompts - a.prompts);

    const agentPrompts = agentList.reduce((s, a) => s + a.prompts, 0);
    const sharedPrompts = agentList.filter((a) => a.shared).reduce((s, a) => s + a.prompts, 0);

    return {
      surfaces: surfaceList,
      agents: agentList,
      agentReuseRate: pct(agentPrompts, events.length),
      sharedRate: pct(sharedPrompts, events.length),
      orphanCount: agentList.filter((a) => a.orphan).length,
      namedAssets: agentList.length
    };
  }

  /* ------------------------------------------------------------------ *
   * Workflow discovery. Repeated shapes are the candidates worth turning
   * into a template, a shared agent, or an actual automated pipeline.
   * ------------------------------------------------------------------ */
  function buildWorkflows(events) {
    const byConv = {};
    events.slice().sort((a, b) => a.ts - b.ts).forEach((e) => {
      (byConv[e.conversationHash] = byConv[e.conversationHash] || []).push(e);
    });

    // Category transitions inside a conversation: comprehension → drafting etc.
    const seq = {};
    Object.values(byConv).forEach((list) => {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1].workType;
        const b = list[i].workType;
        if (a === b) continue;
        const k = a + '→' + b;
        seq[k] = (seq[k] || 0) + 1;
      }
    });

    // Same-day handoffs between tools: a gap the org could close.
    const handoffs = {};
    const sorted = events.slice().sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < sorted.length; i++) {
      const p = sorted[i - 1];
      const c = sorted[i];
      if (p.site === c.site) continue;
      if (c.ts - p.ts > 30 * 60000) continue;
      const k = p.site + '→' + c.site;
      handoffs[k] = (handoffs[k] || 0) + 1;
    }

    // Repeated prompt openings — only possible when redacted text is retained.
    const skeletons = {};
    events.forEach((e) => {
      if (!e.promptText) return;
      const skel = e.promptText
        .toLowerCase()
        .replace(/\[[a-z_]+\]/g, '')
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .join(' ');
      if (skel.split(' ').length < 4) return;
      const s = skeletons[skel] || { skeleton: skel, count: 0, copies: 0, category: e.workTypeLabel };
      s.count++;
      if (e.copyEvents || e.copiedOut) s.copies++;
      skeletons[skel] = s;
    });

    return {
      sequences: Object.entries(seq)
        .map(([k, count]) => {
          const [a, b] = k.split('→');
          return { from: VG.taxonomyById(a).label, to: VG.taxonomyById(b).label, count };
        })
        .filter((x) => x.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      handoffs: Object.entries(handoffs)
        .map(([k, count]) => ({ pair: k, count }))
        .filter((x) => x.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      repeatedPrompts: Object.values(skeletons)
        .filter((s) => s.count >= 3)
        .map((s) => Object.assign({}, s, { copyRate: pct(s.copies, s.count) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
    };
  }

  /**
   * @param {Array} events    events inside the period
   * @param {Array} prev      events inside the preceding period (may be [])
   * @param {Object} period   from VG.periods()
   * @param {Object} settings
   * @param {Array} longEvents  optional wider window (e.g. 90d) for retention
   */
  VG.buildReport = function (events, prev, period, settings, longEvents, org) {
    const a = aggregate(events);
    const p = aggregate(prev || []);
    const adoptionBlock = buildAdoption(
      longEvents && longEvents.length ? longEvents : events, settings, period.to);

    const activeDays = Object.keys(a.days).length;
    const convList = Object.values(a.conversations);
    const turnCounts = convList.map((c) => c.turns);
    const multiTurn = turnCounts.filter((t) => t > 1).length;

    const sites = Object.entries(a.sites)
      .map(([id, count]) => ({
        id,
        label: VG.adapterLabel(id, settings),
        colour: VG.adapterColour(id, settings),
        count,
        pct: pct(count, a.prompts)
      }))
      .sort((x, y) => y.count - x.count);

    const workTypes = VG.TAXONOMY
      .map((cat) => ({
        id: cat.id,
        label: cat.label,
        colour: cat.colour,
        count: a.workTypes[cat.id] || 0,
        pct: pct(a.workTypes[cat.id] || 0, a.prompts),
        prevCount: p.workTypes[cat.id] || 0
      }))
      .filter((w) => w.count > 0)
      .sort((x, y) => y.count - x.count);

    const risk = Object.entries(a.redactionsByType)
      .map(([id, count]) => ({ id, label: VG.redactorLabel(id), count }))
      .sort((x, y) => y.count - x.count);

    const models = Object.entries(a.models)
      .map(([label, count]) => ({ label, count, pct: pct(count, a.prompts) }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 8);

    const busiestHour = a.hours.indexOf(Math.max.apply(null, a.hours));
    const busiestDay = Object.entries(a.days).sort((x, y) => y[1] - x[1])[0];

    return {
      generatedAt: Date.now(),
      org: org || null,
      period: {
        id: period.id,
        label: period.label,
        from: period.from,
        to: period.to,
        rangeLabel: period.from === 0
          ? 'All time'
          : `${VG.fmtDate(period.from)} – ${VG.fmtDate(period.to - 1)}`
      },
      totals: {
        prompts: a.prompts,
        conversations: convList.length,
        activeDays,
        promptsPerActiveDay: activeDays ? Math.round((a.prompts / activeDays) * 10) / 10 : 0,
        tools: sites.length,
        busiestHour: a.prompts ? busiestHour : null,
        busiestDay: busiestDay ? { day: busiestDay[0], count: busiestDay[1] } : null
      },
      deltas: {
        prompts: delta(a.prompts, p.prompts),
        conversations: delta(convList.length, Object.keys(p.conversations).length),
        activeDays: delta(activeDays, Object.keys(p.days).length)
      },
      previous: {
        prompts: p.prompts,
        conversations: Object.keys(p.conversations).length,
        activeDays: Object.keys(p.days).length,
        avgTurns: (() => {
          const t = Object.values(p.conversations).map((c) => c.turns);
          return t.length ? Math.round((t.reduce((s, n) => s + n, 0) / t.length) * 10) / 10 : 0;
        })()
      },
      sites,
      models,
      workTypes,
      usability: {
        avgPromptChars: a.promptChars.length
          ? Math.round(a.promptChars.reduce((s, n) => s + n, 0) / a.promptChars.length) : 0,
        medianPromptWords: median(a.promptWords),
        avgTurnsPerConversation: turnCounts.length
          ? Math.round((turnCounts.reduce((s, n) => s + n, 0) / turnCounts.length) * 10) / 10 : 0,
        longestConversation: turnCounts.length ? Math.max.apply(null, turnCounts) : 0,
        followUpRate: pct(multiTurn, convList.length),
        medianFirstTokenMs: median(a.firstTokenMs),
        medianResponseChars: median(a.responseChars),
        copiedOutChars: a.copiedOut,
        // Character counts and response lengths only exist under the wider DOM
        // scope. Reporting a hard 0 reads as "nobody copied anything", which is
        // the opposite of the truth, so say which metrics were not measured.
        copiedCharsMeasured: a.copiedOut > 0,
        responseCharsMeasured: a.responseCharsSeen > 0,
        substantialCopies: a.copyLarge,
        copyRate: pct(a.copyEvents, a.prompts),
        regenerateRate: pct(a.regenerated, a.prompts),
        attachmentRate: pct(a.attachments, a.prompts),
        promptsPerDayP50: percentile(Object.values(a.days), 50),
        promptsPerDayP90: percentile(Object.values(a.days), 90),
        // A conversation that ended with output being copied out and no
        // regenerate is the closest thing to "the task got done".
        taskCompletionRate: (() => {
          const done = convList.filter((c) => c.copied && !c.regen).length;
          return pct(done, convList.length);
        })(),
        reworkRate: pct(events.filter((e) => e.regenerated > 0).length, a.prompts),
        // Same category used 3+ times in the period: routine work, not a one-off.
        repeatTaskRate: pct(
          Object.entries(a.workTypes).filter(([, n]) => n >= 3).reduce((s, [, n]) => s + n, 0),
          a.prompts
        )
      },
      compliance: {
        nonWorkPrompts: a.nonWork,
        nonWorkRate: pct(a.nonWork, a.prompts),
        accountMix: Object.entries(a.accountTiers)
          .map(([tier, count]) => ({ tier, count, pct: pct(count, a.prompts) }))
          .sort((x, y) => y.count - x.count),
        personalAccountRate: pct(a.accountTiers.personal || 0, a.prompts),
        unknownAccountRate: pct(a.accountTiers.unknown || 0, a.prompts)
      },
      classifier: {
        inheritedRate: pct(a.inherited, a.prompts),
        lowConfidenceRate: pct(a.lowConfidence, a.prompts),
        uncategorisedRate: pct(a.workTypes.other || 0, a.prompts),
        secondaryIntents: Object.entries(a.secondary)
          .map(([id, count]) => ({ id, label: VG.taxonomyById(id).label, count }))
          .sort((x, y) => y.count - x.count)
          .slice(0, 6)
      },
      adoption: adoptionBlock,
      volume: buildVolume(events, adoptionBlock),
      untapped: buildUntapped(events),
      firstExperience: buildFirstExperience(longEvents && longEvents.length ? longEvents : events),
      value: buildValue(events),
      platform: buildAgents(events, settings),
      workflows: buildWorkflows(events),
      risk: {
        totalRedactions: a.redactionTotal,
        promptsWithSensitive: a.promptsWithSensitive,
        pctWithSensitive: pct(a.promptsWithSensitive, a.prompts),
        byType: risk
      },
      trend: daySeries(period.from === 0 ? (events[0] ? events[0].ts : Date.now()) : period.from, period.to, a.days),
      hours: a.hours
    };
  };

  /* ------------------------------------------------------------------ *
   * Written summary
   * ------------------------------------------------------------------ */
  function arrow(d) {
    if (!d || d.pct === null) return '';
    if (d.dir === 'up') return ` (up ${Math.abs(d.pct)}% on the previous period)`;
    if (d.dir === 'down') return ` (down ${Math.abs(d.pct)}% on the previous period)`;
    return ' (flat on the previous period)';
  }

  function listOf(items, fmt, max) {
    const use = items.slice(0, max || 3).map(fmt);
    if (use.length === 0) return '';
    if (use.length === 1) return use[0];
    return use.slice(0, -1).join(', ') + ' and ' + use[use.length - 1];
  }

  VG.summarise = function (r) {
    if (!r.totals.prompts) {
      return `No AI activity recorded for ${r.period.rangeLabel}. Either nothing was sent to a covered tool, or capture was paused.`;
    }

    const s = [];
    const u = r.usability;
    const shares = r.volume.quoteShares;

    if (!shares) {
      s.push(
        `Only ${r.totals.prompts} prompt${r.totals.prompts === 1 ? '' : 's'} were captured in this period. ` +
        `${r.volume.note} The figures below are counts.`
      );
    }

    s.push(
      `${r.period.label} (${r.period.rangeLabel}): ${r.totals.prompts} prompt${r.totals.prompts === 1 ? '' : 's'}` +
      arrow(r.deltas.prompts) +
      `, across ${r.totals.tools} tool${r.totals.tools === 1 ? '' : 's'} and ${r.totals.conversations} conversation${r.totals.conversations === 1 ? '' : 's'} on ${r.totals.activeDays} active day${r.totals.activeDays === 1 ? '' : 's'} ` +
      `(${r.totals.promptsPerActiveDay} per active day).`
    );

    if (r.sites.length) {
      s.push(
        `Tool mix: ${listOf(r.sites, (x) => `${x.label} ${shares ? x.pct + '%' : x.count}`, 4)}.`
      );
    }

    if (r.workTypes.length) {
      const top = r.workTypes.slice(0, 3);
      s.push(
        `Work profile is led by ${listOf(top, (w) => `${w.label.toLowerCase()} (${shares ? w.pct + '%' : w.count})`, 3)}.`
      );
      const risers = r.workTypes
        .filter((w) => w.prevCount > 0 && w.count > w.prevCount * 1.5 && w.count >= 3)
        .slice(0, 2);
      if (risers.length) {
        s.push(`Growing fastest: ${listOf(risers, (w) => `${w.label.toLowerCase()} (${w.prevCount} → ${w.count})`, 2)}.`);
      }
    }

    const turnsPhrase = r.previous.avgTurns
      ? `${u.avgTurnsPerConversation} turns per conversation versus ${r.previous.avgTurns} previously`
      : `${u.avgTurnsPerConversation} turns per conversation`;
    s.push(
      `Engagement depth: ${turnsPhrase}; ${u.followUpRate}% of conversations went beyond a single turn; ` +
      `median prompt length ${u.medianPromptWords} words.`
    );

    if (u.medianFirstTokenMs) {
      s.push(`Median time to first response token was ${(u.medianFirstTokenMs / 1000).toFixed(1)}s.`);
    }

    const signals = [];
    if (u.copyRate) signals.push(`${u.copyRate}% of prompts were followed by copying output out of the page`);
    if (u.regenerateRate) signals.push(`${u.regenerateRate}% triggered a regenerate`);
    if (u.attachmentRate) signals.push(`${u.attachmentRate}% included an attachment`);
    if (signals.length) s.push(`Usability signals: ${listOf(signals, (x) => x, 3)}.`);

    if (r.risk.promptsWithSensitive) {
      s.push(
        `${r.risk.promptsWithSensitive} prompt${r.risk.promptsWithSensitive === 1 ? '' : 's'} ` +
        `(${r.risk.pctWithSensitive}%) contained data that was masked before storage — ` +
        `most often ${listOf(r.risk.byType, (t) => `${t.label.toLowerCase()} (${t.count})`, 3)}. ` +
        `The original values were never written to disk.`
      );
    } else {
      s.push('No sensitive data patterns were detected in captured prompts this period.');
    }

    if (r.compliance.nonWorkRate || r.compliance.personalAccountRate) {
      const bits = [];
      if (r.compliance.nonWorkRate) bits.push(`${r.compliance.nonWorkRate}% of prompts looked non-work`);
      if (r.compliance.personalAccountRate) bits.push(`${r.compliance.personalAccountRate}% were sent from a personal account`);
      s.push(`Governance: ${listOf(bits, (x) => x, 2)}.`);
    }

    if (r.untapped.length >= 5) {
      s.push(
        `${r.untapped.length} of the ${VG.TAXONOMY.length - 1} work categories saw no use at all, including ` +
        `${listOf(r.untapped.slice(0, 4), (c) => c.label.toLowerCase(), 4)} — ` +
        `at this volume the gap is the finding, not the mix.`
      );
    }

    if (r.firstExperience && r.firstExperience.prompts >= 3) {
      s.push(
        `First attempts: across the earliest ${r.firstExperience.prompts} prompts, ` +
        `${r.firstExperience.copyRate}% produced output that was taken away and ` +
        `${r.firstExperience.reworkRate}% needed a retry — ${r.firstExperience.verdict}.`
      );
    }

    const ad = r.adoption;
    if (ad.lapsed) {
      s.push(`Use has lapsed: nothing captured for ${ad.daysSinceLastUse} days.`);
    }
    s.push(
      `Sustained use: active in ${ad.activeWeeksOf6} of the last 6 weeks ` +
      `(${ad.sustained ? 'past the novelty threshold' : 'not yet sustained'}), ` +
      `${ad.activeDays28} active days in the last 28, trajectory ${ad.trajectory}.`
    );

    const pf = r.platform;
    if (pf.namedAssets) {
      const top = pf.agents.slice(0, 2);
      s.push(
        `${pf.agentReuseRate}% of prompts went to a named Project, custom GPT, Gem or agent rather than a blank chat ` +
        `(${pf.namedAssets} distinct asset${pf.namedAssets === 1 ? '' : 's'}, ${pf.sharedRate}% of prompts on shared ones)` +
        (top.length ? `; most used: ${listOf(top, (a) => `${a.name} (${a.prompts})`, 2)}` : '') +
        (pf.orphanCount ? `; ${pf.orphanCount} were built and never reused.` : '.')
      );
    } else {
      s.push('All usage was in blank chat — no Projects, custom GPTs, Gems or agents were used, so nothing is being reused or shared.');
    }

    const v = r.value;
    if (v.responses) {
      s.push(
        `Self-reported value: ${v.responses} response${v.responses === 1 ? '' : 's'} to the point-of-use prompt ` +
        `(${v.responseRate}% of the ${v.eligibleMoments} moments where output was actually used), ` +
        `mean ${v.meanMinutes} minutes saved, giving an estimate of ${v.estHoursLow}–${v.estHoursHigh} hours for the period. ` +
        `Confidence: ${v.confidence}${v.confidence === 'reportable' ? '.' : ' — treat as directional until the sample grows.'}`
      );
    } else {
      s.push('No self-reported value data. Every figure above is a behavioural proxy, not a measurement of time saved.');
    }

    const wf = r.workflows;
    if (wf.sequences.length || wf.repeatedPrompts.length) {
      const bits = [];
      if (wf.sequences.length) {
        bits.push(`the commonest chain is ${wf.sequences[0].from.toLowerCase()} → ${wf.sequences[0].to.toLowerCase()} (${wf.sequences[0].count}x)`);
      }
      if (wf.repeatedPrompts.length) {
        bits.push(`${wf.repeatedPrompts.length} prompt shapes repeated 3+ times`);
      }
      if (wf.handoffs.length) {
        bits.push(`${wf.handoffs[0].count} cross-tool handoffs within 30 minutes`);
      }
      s.push(`Automation candidates: ${listOf(bits, (x) => x, 3)}.`);
    }

    if (r.totals.busiestHour !== null) {
      const h = r.totals.busiestHour;
      const band = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
      s.push(`Peak usage sits in the ${band}, around ${String(h).padStart(2, '0')}:00.`);
    }

    return s.join(' ');
  };

  /* ------------------------------------------------------------------ *
   * The version that goes in front of a executive: three claims, each with
   * its method attached, and an explicit statement of what is not known.
   * ------------------------------------------------------------------ */
  VG.executiveSummary = function (r) {
    const v = r.value;
    const ad = r.adoption;
    const L = [];

    // At low volume the honest headline is the funnel, not the return. Say so
    // first, so nobody reads a share off five prompts.
    if (!r.volume.quoteShares) {
      L.push({
        k: 'How much is there to go on?',
        v: `${r.totals.prompts} prompt${r.totals.prompts === 1 ? '' : 's'} in this period` +
           (ad.lapsed ? `, and nothing at all for the last ${ad.daysSinceLastUse} days` : '') +
           `. ${r.volume.note}`,
        method: 'Raw count. Every percentage below this line should be read as a count with a percent sign on it.'
      });
      L.push({
        k: 'Is this an adoption problem or a value problem?',
        v: (ad.activated
              ? 'People came back for a second week, so the tool is not the blocker. '
              : 'Nobody got past a first week of use. ') +
           (r.untapped.length
              ? `${r.untapped.length} work categories saw no use at all. `
              : '') +
           (r.firstExperience ? r.firstExperience.verdict[0].toUpperCase() + r.firstExperience.verdict.slice(1) + '.' : ''),
        method: 'Weeks with any activity, categories with zero prompts, and whether early output was taken away.'
      });
    }

    L.push({
      k: 'Is it being used, or was it a novelty?',
      v: ad.sustained
        ? `Yes — active in ${ad.activeWeeksOf6} of the last 6 weeks, ${ad.stickiness28}% of working days in the last 28. Trajectory ${ad.trajectory}.`
        : `Not yet — active in only ${ad.activeWeeksOf6} of the last 6 weeks. Below the 4-of-6 threshold for sustained use.`,
      method: 'Weeks with at least one prompt, from local capture. No self-report.'
    });

    L.push({
      k: 'Is the output actually used?',
      v: `${r.usability.copyRate}% of prompts were followed by output being copied out of the page; ` +
         `${r.usability.taskCompletionRate}% of conversations ended in output being taken with no regenerate; ` +
         `rework rate ${r.usability.reworkRate}%.`,
      method: 'Behavioural proxy from copy and regenerate events. Strong signal, but it is not a measure of time saved.'
    });

    L.push({
      k: 'What is it worth?',
      v: v.responses
        ? `Estimated ${v.estHoursLow}–${v.estHoursHigh} hours saved this period (central ${v.estHours}). Based on ${v.responses} point-of-use responses, mean ${v.meanMinutes} min. Confidence: ${v.confidence}.`
        : 'Not measurable from this data. The point-of-use prompt is switched off, so no time-saved claim can be supported.',
      method: v.responses
        ? 'Mean self-reported minutes × number of moments where output was used, ±1.96 SE. Self-report, single device, no control group.'
        : 'n/a'
    });

    L.push({
      k: 'What is the risk trend?',
      v: `${r.risk.pctWithSensitive}% of prompts contained data that had to be masked` +
         (r.risk.byType.length ? `, most often ${r.risk.byType[0].label.toLowerCase()}` : '') +
         `. ${r.compliance.personalAccountRate}% were sent from a personal account; ` +
         `${r.compliance.nonWorkRate}% of prompts were classified as non-work.`,
      method: 'Pattern match in the browser before storage; account tier from the site’s own account menu domain, never stored. Detects known formats only; free-text disclosure is not detected.'
    });

    L.push({
      k: 'What could be automated?',
      v: r.workflows.repeatedPrompts.length || r.workflows.sequences.length
        ? `${r.workflows.repeatedPrompts.length} repeated prompt shapes and ${r.workflows.sequences.length} recurring category chains — candidates for a shared agent or a built workflow.`
        : 'No repeated pattern reached the threshold this period.',
      method: 'Sequence and prompt-skeleton frequency over redacted text.'
    });

    return L;
  };

  /* What this data structurally cannot tell you. Print it under the numbers. */
  VG.CAVEATS = [
    'One device, one person. Fleet totals require aggregating exports or pairing with vendor admin APIs.',
    'No counterfactual. Without a staggered rollout or a matched comparison group, none of this shows what would have happened anyway.',
    'Time saved is self-reported at the moment of use. It is the best available signal and it is still self-report.',
    'Browser only. Desktop apps, IDE assistants and API usage are invisible here.',
    'Redaction detects known formats. Sensitive free text that matches no pattern is not caught.',
    'Work categories come from a keyword classifier, not a human. Check the classification-quality figures before quoting the work profile.'
  ];

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */
  VG.toCSV = function (events, includeText) {
    const cols = [
      'ts', 'day', 'site', 'host', 'model',
      'surface', 'surfaceLabel', 'surfaceFlags', 'agentKey', 'agentName', 'agentType', 'shared',
      'conversationHash', 'turn',
      'promptChars', 'promptWords', 'workType', 'workTypeLabel', 'workTypeConfidence',
      'workTypeSecondary', 'workTypeSource', 'nonWork', 'accountTier',
      'redactionCount', 'redactionTypes', 'attachments', 'firstTokenMs', 'responseMs',
      'responseChars', 'responseHasCode', 'regenerated', 'copyEvents', 'copiedOut',
      'savedMinutes', 'qualityRating'
    ];
    if (includeText) cols.push('promptText');

    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    const lines = [cols.join(',')];
    events.forEach((e) => {
      const row = cols.map((c) => {
        if (c === 'ts') return new Date(e.ts).toISOString();
        if (c === 'redactionTypes') return Object.keys(e.redactionHits || {}).join('|');
        if (c === 'surfaceFlags') return (e.surfaceFlags || []).join('|');
        return esc(e[c]);
      });
      lines.push(row.join(','));
    });
    return lines.join('\n');
  };

  VG.reportToMarkdown = function (r) {
    const L = [];
    L.push(`# AI usage report — ${r.period.label}`);
    L.push(`_${r.period.rangeLabel} · generated ${VG.fmtDate(r.generatedAt)}_`);
    if (r.org && (r.org.businessUnit || r.org.division || r.org.cohort)) {
      L.push(`_${[r.org.businessUnit, r.org.division, r.org.cohort ? 'cohort ' + r.org.cohort : ''].filter(Boolean).join(' · ')}_`);
    }
    L.push('');
    if (!r.volume.quoteShares) {
      L.push(`> **Small sample — ${r.totals.prompts} prompts.** ${r.volume.note}`);
      L.push('');
    }
    L.push('## Executive summary');
    VG.executiveSummary(r).forEach((row) => {
      L.push(`**${row.k}**  `);
      L.push(`${row.v}  `);
      L.push(`_Method: ${row.method}_`);
      L.push('');
    });
    L.push('## Narrative');
    L.push(VG.summarise(r));
    L.push('');
    L.push('## Headline numbers');
    L.push('| Metric | Value |');
    L.push('| --- | --- |');
    L.push(`| Prompts | ${r.totals.prompts} |`);
    L.push(`| Conversations | ${r.totals.conversations} |`);
    L.push(`| Active days | ${r.totals.activeDays} |`);
    L.push(`| Prompts per active day | ${r.totals.promptsPerActiveDay} |`);
    L.push(`| Avg turns per conversation | ${r.usability.avgTurnsPerConversation} |`);
    L.push(`| Follow-up rate | ${r.usability.followUpRate}% |`);
    L.push(`| Median prompt length | ${r.usability.medianPromptWords} words |`);
    L.push(`| Median time to first token | ${r.usability.medianFirstTokenMs ? (r.usability.medianFirstTokenMs / 1000).toFixed(1) + 's' : 'n/a'} |`);
    L.push(`| Prompts with masked data | ${r.risk.promptsWithSensitive} (${r.risk.pctWithSensitive}%) |`);
    L.push('');
    if (r.workTypes.length) {
      L.push('## Work profile');
      L.push('| Category | Prompts | Share |');
      L.push('| --- | ---: | ---: |');
      r.workTypes.forEach((w) =>
        L.push(`| ${w.label} | ${w.count} | ${r.volume.quoteShares ? w.pct + '%' : '—'} |`));
      L.push('');
      if (!r.volume.quoteShares) {
        L.push('_Shares withheld: too few prompts for a percentage to mean anything._');
        L.push('');
      }
    }
    if (r.untapped.length) {
      L.push('## Work categories with no use at all');
      L.push(r.untapped.map((c) => c.label).join(' · '));
      L.push('');
      L.push('_At low volume this list is the more useful half of the work profile._');
      L.push('');
    }
    if (r.sites.length) {
      L.push('## Tools');
      L.push('| Tool | Prompts | Share |');
      L.push('| --- | ---: | ---: |');
      r.sites.forEach((x) => L.push(`| ${x.label} | ${x.count} | ${x.pct}% |`));
      L.push('');
    }
    if (r.platform.surfaces.length) {
      L.push('## Platform surfaces used');
      L.push('| Surface | Prompts | Share | Output used |');
      L.push('| --- | ---: | ---: | ---: |');
      r.platform.surfaces.forEach((s) =>
        L.push(`| ${s.label}${s.flag ? ' *(concurrent)*' : ''} | ${s.count} | ${s.pct}% | ${s.copyRate}% |`));
      L.push('');
    }
    if (r.platform.agents.length) {
      L.push('## Projects, custom GPTs, Gems and agents');
      L.push(`Reuse rate ${r.platform.agentReuseRate}% of prompts · shared assets ${r.platform.sharedRate}% · ${r.platform.orphanCount} built and never reused.`);
      L.push('');
      L.push('| Asset | Type | Tool | Prompts | Convs | Output used | Rework | Shared | Main use |');
      L.push('| --- | --- | --- | ---: | ---: | ---: | ---: | :-: | --- |');
      r.platform.agents.slice(0, 15).forEach((a) =>
        L.push(`| ${a.name} | ${a.type} | ${a.siteLabel} | ${a.prompts} | ${a.conversations} | ${a.copyRate}% | ${a.reworkRate}% | ${a.shared ? 'yes' : 'no'} | ${a.topCategory} |`));
      L.push('');
    }
    if (r.value.responses) {
      L.push('## Self-reported value');
      L.push('| Answer | Responses |');
      L.push('| --- | ---: |');
      r.value.distribution.forEach((d) => L.push(`| ${d.label} | ${d.count} |`));
      L.push('');
      L.push(`Mean ${r.value.meanMinutes} min (±${r.value.ciMinutes}), response rate ${r.value.responseRate}%, confidence **${r.value.confidence}**.`);
      L.push('');
    }
    const wf = r.workflows;
    if (wf.sequences.length || wf.repeatedPrompts.length || wf.handoffs.length) {
      L.push('## Automation candidates');
      if (wf.sequences.length) {
        L.push('| Category chain | Times |');
        L.push('| --- | ---: |');
        wf.sequences.forEach((s) => L.push(`| ${s.from} → ${s.to} | ${s.count} |`));
        L.push('');
      }
      if (wf.repeatedPrompts.length) {
        L.push('| Repeated prompt opening | Times | Output used |');
        L.push('| --- | ---: | ---: |');
        wf.repeatedPrompts.forEach((p) => L.push(`| ${p.skeleton}… | ${p.count} | ${p.copyRate}% |`));
        L.push('');
      }
      if (wf.handoffs.length) {
        L.push('| Cross-tool handoff (within 30 min) | Times |');
        L.push('| --- | ---: |');
        wf.handoffs.forEach((h) => L.push(`| ${h.pair} | ${h.count} |`));
        L.push('');
      }
    }
    if (r.risk.byType.length) {
      L.push('## Data masked before storage');
      L.push('| Type | Occurrences |');
      L.push('| --- | ---: |');
      r.risk.byType.forEach((t) => L.push(`| ${t.label} | ${t.count} |`));
      L.push('');
    }
    L.push('## Governance');
    L.push('| Measure | Value |');
    L.push('| --- | ---: |');
    L.push(`| Prompts classified as non-work | ${r.compliance.nonWorkPrompts} (${r.compliance.nonWorkRate}%) |`);
    L.push(`| Sent from a personal account | ${r.compliance.personalAccountRate}% |`);
    L.push(`| Account tier undetermined | ${r.compliance.unknownAccountRate}% |`);
    L.push('');
    L.push('## Classification quality');
    L.push('| Measure | Value | Reads as |');
    L.push('| --- | ---: | --- |');
    L.push(`| Uncategorised | ${r.classifier.uncategorisedRate}% | ${r.classifier.uncategorisedRate > 20 ? 'taxonomy needs tuning for your vocabulary' : 'acceptable'} |`);
    L.push(`| Topic inherited from thread | ${r.classifier.inheritedRate}% | short follow-up turns |`);
    L.push(`| Low confidence | ${r.classifier.lowConfidenceRate}% | ${r.classifier.lowConfidenceRate > 30 ? 'treat the work profile as indicative only' : 'acceptable'} |`);
    L.push('');
    L.push('## What this data cannot tell you');
    VG.CAVEATS.forEach((c) => L.push(`- ${c}`));
    L.push('');
    L.push('---');
    L.push('_Generated locally by Vantage. Prompt content is redacted on device before storage and is not included in this report._');
    return L.join('\n');
  };
})(typeof self !== 'undefined' ? self : globalThis);
