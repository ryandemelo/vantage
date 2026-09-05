/*
 * Vantage — upload.js
 * Scheduled push of finished reports to an internal endpoint.
 *
 * This is the one part of the extension that talks to the network, and it is
 * off unless an administrator turns it on. Everything that governs it —
 * whether it runs, where it goes, what it contains — is a POLICY-ONLY setting
 * (see VG.POLICY_ONLY_KEYS), so a user cannot enable it, redirect it, or widen
 * what it sends.
 *
 * Scheduling is deliberately catch-up rather than fire-and-forget: it works out
 * which completed periods have not been sent yet and sends the oldest first,
 * one per wake. A browser that was closed for three weeks sends the three
 * missed weeks the next time it runs. The trigger is an alarm in the service
 * worker, so it does not depend on an AI site — or any tab — ever being opened.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  VG.UPLOAD_SCHEMA = 1;
  const MAX_CATCHUP = 8;          // never send more than this many missed periods
  const MAX_BACKOFF_HOURS = 24;

  /* ------------------------------------------------------------------ *
   * Periods
   * ------------------------------------------------------------------ */
  function periodKey(cadence, start) {
    const d = new Date(start);
    const p = (n) => String(n).padStart(2, '0');
    if (cadence === 'monthly') return `m-${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    if (cadence === 'daily') return `d-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    return `w-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function periodBounds(cadence, start, weekStartsOn) {
    if (cadence === 'monthly') return { from: start, to: VG.addMonths(start, 1) };
    if (cadence === 'daily') return { from: start, to: VG.addDays(start, 1) };
    return { from: start, to: VG.addDays(start, 7) };
  }

  function startOfPeriod(cadence, ts, weekStartsOn) {
    if (cadence === 'monthly') return VG.startOfMonth(ts);
    if (cadence === 'daily') return VG.startOfDay(ts);
    return VG.startOfWeek(ts, weekStartsOn);
  }

  function previousStart(cadence, start, n) {
    if (cadence === 'monthly') return VG.addMonths(start, -n);
    if (cadence === 'daily') return VG.addDays(start, -n);
    return VG.addDays(start, -7 * n);
  }

  /**
   * Completed periods that have not been sent, oldest first.
   * The period containing `now` is deliberately excluded — it is not finished.
   */
  VG.pendingPeriods = function (settings, state, now) {
    const t = now || Date.now();
    const cadence = settings.uploadCadence || 'weekly';
    const ws = settings.weekStartsOn;
    const current = startOfPeriod(cadence, t, ws);
    const sent = (state && state.sentPeriods) || [];

    const out = [];
    for (let i = 1; i <= MAX_CATCHUP; i++) {
      const start = previousStart(cadence, current, i);
      const key = periodKey(cadence, start);
      if (sent.indexOf(key) !== -1) continue;
      const b = periodBounds(cadence, start, ws);
      out.push({
        id: key,
        label: cadence === 'monthly'
          ? new Date(start).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
          : cadence === 'daily'
            ? VG.fmtDate(start)
            : `Week of ${VG.fmtDate(start)}`,
        from: b.from,
        to: b.to,
        prevFrom: previousStart(cadence, start, 1),
        cadence
      });
    }
    return out.reverse(); // oldest first
  };

  /** Is a retry allowed yet, given how many times this has failed? */
  VG.uploadBackoffOk = function (state, now) {
    const t = now || Date.now();
    const fails = (state && state.failures) || 0;
    if (!fails) return true;
    const waitHours = Math.min(MAX_BACKOFF_HOURS, Math.pow(2, fails - 1));
    return t - ((state && state.lastAttemptAt) || 0) >= waitHours * 3600000;
  };

  /* ------------------------------------------------------------------ *
   * Payload
   * ------------------------------------------------------------------ */

  /**
   * Build the body. The content gate is applied HERE as well as at the policy
   * layer: prompt text is stripped unless the policy asks for events AND
   * separately opts into text AND the capture level actually allows it.
   */
  VG.buildUploadPayload = async function (opts) {
    const { report, events, settings, org, period } = opts;
    const level = settings.uploadContent || 'aggregate';

    const body = {
      schema: VG.UPLOAD_SCHEMA,
      extensionVersion: VG.VERSION,
      sentAt: new Date().toISOString(),
      contentLevel: level,
      device: {
        key: (org && org.userKey) || '',
        agency: (org && org.agency) || settings.orgAgency || '',
        division: (org && org.division) || settings.orgDivision || '',
        cohort: (org && org.cohort) || settings.orgCohort || ''
      },
      period: { id: period.id, label: period.label, from: period.from, to: period.to },
      counts: { prompts: report.totals.prompts, conversations: report.totals.conversations }
    };

    // A signature over the same figures the human-readable report carries, so a
    // receiver can tell a genuine push from a fabricated one.
    const figures = VG.canonicalFigures(report);
    const digest = await VG.digestFor(figures, settings.reportSigningKey);
    body.signature = { ref: VG.refCode(digest), digest };

    if (level === 'summary') {
      body.summary = VG.summarise(report);
      body.executive = VG.executiveSummary(report);
      return body;
    }

    // 'aggregate' and 'events' both carry the full report object, which by
    // construction contains no prompt or response text.
    body.report = report;

    if (level === 'events') {
      const allowText = !!settings.uploadIncludePromptText &&
        settings.captureLevel !== VG.CAPTURE_LEVELS.METADATA;
      body.events = (events || []).map((e) => {
        const row = Object.assign({}, e);
        delete row.demo;
        if (!allowText) row.promptText = '';
        return row;
      });
      body.eventsIncludePromptText = allowText;
    }
    return body;
  };

  /** A short, human-readable description for the transparency panel. */
  VG.uploadDescription = function (settings) {
    if (!settings.uploadEnabled || !settings.uploadUrl) return null;
    let host = settings.uploadUrl;
    try { host = new URL(settings.uploadUrl).host; } catch (e) { /* keep raw */ }
    const what = {
      summary: 'a written summary and the headline numbers',
      aggregate: 'aggregated counts and rates — no prompt text',
      events: settings.uploadIncludePromptText
        ? 'every captured event, INCLUDING redacted prompt text'
        : 'every captured event, without prompt text'
    }[settings.uploadContent || 'aggregate'];
    const when = {
      daily: 'every day', weekly: 'once a week', monthly: 'once a month'
    }[settings.uploadCadence || 'weekly'];
    return { host, what, when };
  };
})(typeof self !== 'undefined' ? self : globalThis);
