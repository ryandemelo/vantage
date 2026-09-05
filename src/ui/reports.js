/* Vantage, reports.js */
(function () {
  'use strict';
  const VG = self.VG;
  const $ = (id) => document.getElementById(id);

  let settings = null;
  let org = null;
  let state = { report: null, events: [], period: null };

  /* --------------------------- helpers --------------------------- */

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    (children || []).forEach((c) => c && n.appendChild(c));
    return n;
  }

  function deltaSpan(d) {
    if (!d || d.pct === null) return el('div', { class: 'd flat', text: 'no prior period' });
    const cls = d.dir === 'up' ? 'up' : d.dir === 'down' ? 'down' : 'flat';
    const sign = d.pct > 0 ? '+' : '';
    return el('div', { class: 'd ' + cls, text: `${sign}${d.pct}% vs previous` });
  }

  function tile(k, v, d) {
    return el('div', { class: 'tile' }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', text: String(v) }),
      d || null
    ]);
  }

  function download(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* ---------------------------- charts ---------------------------- */

  function trendChart(trend) {
    const w = 960, h = 110, pad = 4;
    const max = Math.max(1, ...trend.map((d) => d.count));
    const n = Math.max(1, trend.length);
    const bw = (w - pad * 2) / n;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'chart');

    trend.forEach((d, i) => {
      const bh = d.count ? Math.max(2, ((h - 22) * d.count) / max) : 1;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(pad + i * bw + bw * 0.14));
      r.setAttribute('y', String(h - 18 - bh));
      r.setAttribute('width', String(Math.max(1, bw * 0.72)));
      r.setAttribute('height', String(bh));
      r.setAttribute('rx', String(Math.min(2, bw * 0.3)));
      r.setAttribute('fill', d.count ? 'var(--accent)' : 'var(--border)');
      r.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'title'))
        .textContent = `${d.day}: ${d.count} prompt${d.count === 1 ? '' : 's'}`;
      svg.appendChild(r);
    });

    // sparse date labels
    const step = Math.ceil(n / 10);
    trend.forEach((d, i) => {
      if (i % step !== 0) return;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(pad + i * bw + bw / 2));
      t.setAttribute('y', String(h - 5));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '9');
      t.setAttribute('fill', 'currentColor');
      t.setAttribute('opacity', '.5');
      t.textContent = VG.fmtDateShort(d.ts);
      svg.appendChild(t);
    });

    return svg;
  }

  function weeklyChart(weekly) {
    const w = 960, h = 92, pad = 4;
    const max = Math.max(1, ...weekly.map((d) => d.prompts));
    const n = Math.max(1, weekly.length);
    const bw = (w - pad * 2) / n;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'chart');
    svg.style.height = '92px';

    weekly.forEach((d, i) => {
      const bh = d.prompts ? Math.max(2, ((h - 24) * d.prompts) / max) : 1;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(pad + i * bw + bw * 0.16));
      r.setAttribute('y', String(h - 20 - bh));
      r.setAttribute('width', String(Math.max(2, bw * 0.68)));
      r.setAttribute('height', String(bh));
      r.setAttribute('rx', '3');
      r.setAttribute('fill', d.prompts ? 'var(--accent)' : 'var(--border)');
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `Week of ${VG.fmtDateShort(d.start)}: ${d.prompts} prompts, ${d.activeDays} active days`;
      r.appendChild(t);
      svg.appendChild(r);

      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(pad + i * bw + bw / 2));
      lbl.setAttribute('y', String(h - 6));
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('font-size', '9');
      lbl.setAttribute('fill', 'currentColor');
      lbl.setAttribute('opacity', '.5');
      lbl.textContent = VG.fmtDateShort(d.start);
      svg.appendChild(lbl);
    });
    return svg;
  }

  function barList(items, total, showPct) {
    const withPct = showPct !== false;
    const wrap = el('div', { class: 'bars' });
    items.forEach((it) => {
      wrap.appendChild(el('div', { class: 'bar-row' }, [
        el('div', {}, [
          el('div', { class: 'bar-label' }, [
            el('span', { text: it.label }),
            el('span', { class: 'muted', text: withPct ? it.pct + '%' : String(it.count) })
          ]),
          el('div', { class: 'bar-track' }, [
            el('div', {
              class: 'bar-fill',
              style: `width:${total ? Math.max(1.5, (it.count / total) * 100) : 0}%;background:${it.colour || 'var(--accent)'}`
            })
          ])
        ]),
        el('div', { class: 'bar-count', text: String(it.count) })
      ]));
    });
    return wrap;
  }

  function table(headers, rows) {
    const thead = el('thead', {}, [
      el('tr', {}, headers.map((h) => el('th', { class: h.num ? 'num' : '', text: h.label })))
    ]);
    const tbody = el('tbody', {}, rows.map((r) =>
      el('tr', {}, r.map((c, i) =>
        el('td', { class: headers[i].num ? 'num' : (c && c.cls) || '', text: c && c.text !== undefined ? c.text : String(c) })
      ))
    ));
    return el('table', {}, [thead, tbody]);
  }

  /* ---------------------------- render ---------------------------- */

  function render() {
    const r = state.report;
    const root = $('content');
    root.textContent = '';
    const orgBits = r.org ? [r.org.businessUnit, r.org.division, r.org.cohort ? 'cohort ' + r.org.cohort : ''].filter(Boolean) : [];
    $('rangeLabel').textContent = `${r.period.label} · ${r.period.rangeLabel}` +
      (orgBits.length ? ' · ' + orgBits.join(' · ') : '');

    if (!r.totals.prompts) {
      $('empty').style.display = '';
      return;
    }
    $('empty').style.display = 'none';

    /* small-sample banner, a share off a handful of prompts is not a finding */
    if (!r.volume.quoteShares) {
      root.appendChild(el('div', { class: 'card', style: 'border-color:var(--warn);background:color-mix(in srgb, var(--warn) 8%, var(--surface))' }, [
        el('strong', { text: `Small sample, ${r.totals.prompts} prompt${r.totals.prompts === 1 ? '' : 's'}` }),
        el('div', { class: 'muted', style: 'margin-top:4px', text: r.volume.note }),
        el('div', { class: 'muted', style: 'margin-top:4px', text: 'Percentages are withheld below. Quote the counts.' })
      ]));
    }

    /* sample-data warning, never let a demo report be mistaken for real */
    const demoCount = state.events.filter((e) => e.demo).length;
    if (demoCount) {
      root.appendChild(el('div', { class: 'card', style: 'border-color:var(--warn);background:color-mix(in srgb, var(--warn) 8%, var(--surface))' }, [
        el('strong', { text: 'Contains sample data' }),
        el('div', { class: 'muted', style: 'margin-top:4px', text: `${demoCount} of ${state.events.length} events in this period were generated for demonstration. Remove them in Settings → Sample data before circulating this report.` })
      ]));
    }

    /* executive summary, the version that goes in front of a executive */
    root.appendChild(el('div', { class: 'card stack' }, [
      el('div', { class: 'row between' }, [
        el('h2', { text: 'Executive summary' }),
        el('div', { class: 'toolbar no-print' }, [
          el('button', { class: 'sm', text: 'Copy', onclick: copySummary }),
          el('button', { class: 'sm', text: 'Email', onclick: emailReport }),
          el('button', { class: 'sm', text: 'Print / PDF', onclick: () => window.print() })
        ])
      ]),
      el('div', { class: 'exec' }, VG.executiveSummary(r).map((row) =>
        el('div', { class: 'exec-row' }, [
          el('div', { class: 'exec-q', text: row.k }),
          el('div', { class: 'exec-a', text: row.v }),
          el('div', { class: 'exec-m', text: 'Method: ' + row.method })
        ])
      ))
    ]));

    /* narrative */
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Narrative' }),
      el('div', { class: 'summary', id: 'summaryText', text: VG.summarise(r) })
    ]));

    /* tiles */
    root.appendChild(el('div', { class: 'tiles' }, [
      tile('Prompts', r.totals.prompts, deltaSpan(r.deltas.prompts)),
      tile('Conversations', r.totals.conversations, deltaSpan(r.deltas.conversations)),
      tile('Active days', r.totals.activeDays, deltaSpan(r.deltas.activeDays)),
      tile('Per active day', r.totals.promptsPerActiveDay),
      tile('Avg turns', r.usability.avgTurnsPerConversation),
      tile('Masked items', r.risk.totalRedactions)
    ]));

    /* trend */
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Daily volume' }),
      trendChart(r.trend)
    ]));

    /* work profile + tools */
    const left = el('div', { class: 'card stack' }, [
      el('h2', { text: 'Work profile' }),
      el('div', { class: 'faint', text: 'Classified on device from redacted prompt text.' }),
      barList(r.workTypes, r.totals.prompts)
    ]);

    const rightKids = [
      el('h2', { text: 'Tools' }),
      barList(r.sites, r.totals.prompts, r.volume.quoteShares)
    ];
    if (r.models.length) {
      rightKids.push(el('h3', { text: 'Models seen', style: 'margin-top:6px' }));
      rightKids.push(table(
        [{ label: 'Model' }, { label: 'Prompts', num: true }, { label: 'Share', num: true }],
        r.models.map((m) => [m.label, String(m.count), m.pct + '%'])
      ));
    }
    root.appendChild(el('div', { class: 'grid2' }, [left, el('div', { class: 'card stack' }, rightKids)]));

    /* usability */
    const u = r.usability;
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Usability signals' }),
      table(
        [{ label: 'Metric' }, { label: 'Value', num: true }, { label: 'Reads as' }],
        [
          ['Median prompt length', u.medianPromptWords + ' words', u.medianPromptWords < 12 ? 'short, mostly one-liners' : u.medianPromptWords < 45 ? 'typical working length' : 'long, context-heavy'],
          ['Avg turns per conversation', String(u.avgTurnsPerConversation), u.avgTurnsPerConversation < 1.5 ? 'one-shot usage' : u.avgTurnsPerConversation < 3 ? 'some iteration' : 'sustained dialogue'],
          ['Follow-up rate', u.followUpRate + '%', 'share of conversations with more than one turn'],
          ['Longest conversation', u.longestConversation + ' turns', ''],
          ['Median time to first token', u.medianFirstTokenMs ? (u.medianFirstTokenMs / 1000).toFixed(1) + 's' : 'n/a', 'perceived responsiveness'],
          ['Substantial copies', String(u.substantialCopies), 'the population the value estimate extrapolates over'],
          ['Copy-out rate', u.copyRate + '%', 'output taken into other work, a proxy for usefulness'],
          ['Regenerate rate', u.regenerateRate + '%', u.regenerateRate > 12 ? 'high, answers often missed first time' : 'normal'],
          ['Attachment rate', u.attachmentRate + '%', 'prompts that included a file'],
          ['Characters copied out',
            u.copiedCharsMeasured ? String(u.copiedOutChars) : 'not measured',
            u.copiedCharsMeasured ? '' : 'not measured, the DOM scope is set to composer only']
        ]
      )
    ]));

    /* sustained use */
    const ad = r.adoption;
    root.appendChild(el('div', { class: 'card stack' }, [
      el('div', { class: 'row between' }, [
        el('h2', { text: 'Sustained use' }),
        el('span', {
          class: 'pill',
          text: ad.lapsed ? `lapsed, ${ad.daysSinceLastUse} days quiet`
            : ad.sustained ? 'past novelty threshold' : 'not yet sustained',
          style: ad.lapsed ? 'background:color-mix(in srgb,var(--bad) 16%,transparent);color:var(--bad)'
            : ad.sustained ? 'background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)'
            : 'background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)'
        })
      ]),
      el('div', { class: 'faint', text: 'The only adoption question that survives the novelty period: did they come back?' }),
      el('div', { class: 'tiles' }, [
        tile('Active weeks / 6', ad.activeWeeksOf6),
        tile('Active days / 28', ad.activeDays28),
        tile('Stickiness', ad.stickiness28 + '%'),
        tile('Trajectory', ad.trajectory)
      ]),
      weeklyChart(ad.weekly)
    ]));

    /* platform surfaces + named assets */
    const pf = r.platform;
    const platformKids = [
      el('h2', { text: 'Where inside the platform' }),
      el('div', { class: 'faint', text: 'Plain chat versus Projects, custom GPTs, Gems, agents, Canvas and Deep Research.' }),
      barList(pf.surfaces.map((s) => ({
        label: s.label + (s.flag ? ' (concurrent)' : ''),
        count: s.count, pct: s.pct, colour: s.flag ? 'var(--faint)' : 'var(--accent)'
      })), r.totals.prompts)
    ];
    if (pf.agents.length) {
      platformKids.push(el('div', { class: 'tiles', style: 'margin-top:6px' }, [
        tile('Reuse rate', pf.agentReuseRate + '%'),
        tile('Named assets', pf.namedAssets),
        tile('Shared', pf.sharedRate + '%'),
        tile('Built, never reused', pf.orphanCount)
      ]));
      platformKids.push(table(
        [{ label: 'Asset' }, { label: 'Type' }, { label: 'Tool' }, { label: 'Prompts', num: true },
         { label: 'Convs', num: true }, { label: 'Output used', num: true }, { label: 'Rework', num: true },
         { label: 'Shared' }, { label: 'Main use' }],
        pf.agents.slice(0, 15).map((a) => [
          a.name, a.type, a.siteLabel, String(a.prompts), String(a.conversations),
          a.copyRate + '%', a.reworkRate + '%', a.shared ? 'yes' : 'no', a.topCategory
        ])
      ));
      platformKids.push(el('div', { class: 'faint', text: 'High prompts with a low “output used” rate means the asset is being tried, not relied on. Orphans are candidates to retire.' }));
    } else {
      platformKids.push(el('div', { class: 'faint', text: 'No Projects, custom GPTs, Gems or agents were used this period, nothing is being reused or shared.' }));
    }
    root.appendChild(el('div', { class: 'card stack' }, platformKids));

    /* what the tool is not being used for, and how the first attempts went ,
       at low volume these two say more than the work profile does */
    if (r.untapped.length || r.firstExperience) {
      const kids = [el('h2', { text: 'Gaps and first attempts' })];
      if (r.untapped.length) {
        kids.push(el('h3', { text: 'Work categories with no use at all' }));
        kids.push(el('div', { style: 'line-height:1.9' },
          r.untapped.map((c) => el('span', {
            class: 'pill',
            style: 'margin-right:6px',
            text: c.label
          }))));
        kids.push(el('div', { class: 'faint', text: 'At low volume this list is the more useful half of the work profile, it is the map of work nobody has brought to the tool yet.' }));
      }
      if (r.firstExperience && r.firstExperience.prompts >= 3) {
        kids.push(el('h3', { text: 'How the first attempts went', style: 'margin-top:10px' }));
        kids.push(el('div', { class: 'tiles' }, [
          tile('First prompts', r.firstExperience.prompts),
          tile('Output used', r.firstExperience.copyRate + '%'),
          tile('Needed a retry', r.firstExperience.reworkRate + '%'),
          tile('Median length', r.firstExperience.medianWords + ' words')
        ]));
        kids.push(el('div', { class: 'faint', text: r.firstExperience.verdict[0].toUpperCase() + r.firstExperience.verdict.slice(1) + '. A poor first week is the commonest reason someone never returns, and it is invisible in a volume chart.' }));
      }
      root.appendChild(el('div', { class: 'card stack' }, kids));
    }

    /* self-reported value */
    const v = r.value;
    const valueKids = [
      el('div', { class: 'row between' }, [
        el('h2', { text: 'Self-reported value' }),
        el('span', { class: 'pill', text: 'confidence: ' + v.confidence })
      ])
    ];
    if (v.responses) {
      valueKids.push(el('div', { class: 'tiles' }, [
        tile('Est. hours saved', `${v.estHoursLow} to ${v.estHoursHigh}`),
        tile('Mean per use', v.meanMinutes + ' min'),
        tile('Responses', v.responses),
        tile('Response rate', v.responseRate + '%')
      ]));
      valueKids.push(barList(
        v.distribution.map((d) => ({ label: d.label, count: d.count, pct: v.responses ? Math.round((d.count / v.responses) * 1000) / 10 : 0, colour: 'var(--good)' })),
        v.responses
      ));
      valueKids.push(el('div', { class: 'faint', text: `Method: mean self-reported minutes × ${v.eligibleMoments} moments where output was actually used, ±1.96 standard errors. Self-report, single device, no control group.` }));
    } else {
      valueKids.push(el('div', { class: 'faint', text: settings.valueSurveyEnabled
        ? 'The point-of-use prompt is on but has not been answered yet. It appears only after output is copied out, at most once every few hours.'
        : 'The point-of-use prompt is switched off (Settings → Value measurement). Without it, no time-saved figure in this report can be defended, everything else here is a behavioural proxy.' }));
    }
    root.appendChild(el('div', { class: 'card stack' }, valueKids));

    /* automation candidates */
    const wf = r.workflows;
    if (wf.sequences.length || wf.repeatedPrompts.length || wf.handoffs.length) {
      const wfKids = [
        el('h2', { text: 'Automation candidates' }),
        el('div', { class: 'faint', text: 'Repeated shapes are what a shared agent, a prompt template or a built workflow should replace.' })
      ];
      if (wf.sequences.length) {
        wfKids.push(el('h3', { text: 'Recurring category chains' }));
        wfKids.push(table([{ label: 'From' }, { label: 'To' }, { label: 'Times', num: true }],
          wf.sequences.map((s) => [s.from, s.to, String(s.count)])));
      }
      if (wf.repeatedPrompts.length) {
        wfKids.push(el('h3', { text: 'Repeated prompt openings' }));
        wfKids.push(table([{ label: 'Opening' }, { label: 'Category' }, { label: 'Times', num: true }, { label: 'Output used', num: true }],
          wf.repeatedPrompts.map((p) => [p.skeleton + '…', p.category, String(p.count), p.copyRate + '%'])));
      }
      if (wf.handoffs.length) {
        wfKids.push(el('h3', { text: 'Cross-tool handoffs within 30 minutes' }));
        wfKids.push(table([{ label: 'Handoff' }, { label: 'Times', num: true }],
          wf.handoffs.map((h) => [h.pair, String(h.count)])));
      }
      root.appendChild(el('div', { class: 'card stack' }, wfKids));
    }

    /* governance: non-work and personal accounts */
    const cp = r.compliance;
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Governance' }),
      el('div', { class: 'tiles' }, [
        tile('Non-work prompts', cp.nonWorkRate + '%'),
        tile('Personal account', cp.personalAccountRate + '%'),
        tile('Account undetermined', cp.unknownAccountRate + '%'),
        tile('Masked prompts', r.risk.pctWithSensitive + '%')
      ]),
      cp.accountMix.length
        ? table([{ label: 'Account tier' }, { label: 'Prompts', num: true }, { label: 'Share', num: true }],
            cp.accountMix.map((m) => [m.tier, String(m.count), m.pct + '%']))
        : null,
      el('div', { class: 'faint', text: 'Account tier is read from the site’s own account menu and compared against your organisation’s domains. The address itself is never stored.' })
    ].filter(Boolean)));

    /* classification quality, read this before quoting the work profile */
    const cq = r.classifier;
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'Classification quality' }),
      table(
        [{ label: 'Measure' }, { label: 'Value', num: true }, { label: 'Reads as' }],
        [
          ['Uncategorised', cq.uncategorisedRate + '%', cq.uncategorisedRate > 20 ? 'taxonomy needs tuning for your vocabulary' : 'acceptable'],
          ['Topic inherited from thread', cq.inheritedRate + '%', 'short follow-up turns borrowing the thread topic'],
          ['Low confidence', cq.lowConfidenceRate + '%', cq.lowConfidenceRate > 30 ? 'treat the work profile as indicative only' : 'acceptable'],
          ['Prompts with a second intent', String(cq.secondaryIntents.reduce((n, x) => n + x.count, 0)), cq.secondaryIntents.length ? 'commonly ' + cq.secondaryIntents.slice(0, 2).map((x) => x.label.toLowerCase()).join(' and ') : 'none']
        ]
      )
    ]));

    /* risk */
    root.appendChild(el('div', { class: 'card stack' }, [
      el('div', { class: 'row between' }, [
        el('h2', { text: 'Data masked before storage' }),
        el('span', { class: 'pill', text: `${r.risk.pctWithSensitive}% of prompts` })
      ]),
      r.risk.byType.length
        ? table([{ label: 'Type' }, { label: 'Occurrences', num: true }],
            r.risk.byType.map((t) => [t.label, String(t.count)]))
        : el('div', { class: 'faint', text: 'Nothing matched a redaction pattern this period.' }),
      el('div', { class: 'faint', text: 'These values were replaced with placeholders in the content script. The originals were never written to storage or included in any export.' })
    ]));

    /* sample prompts, only if text is retained */
    const withText = state.events.filter((e) => e.promptText).slice(-12).reverse();
    if (withText.length) {
      root.appendChild(el('div', { class: 'card stack' }, [
        el('div', { class: 'row between' }, [
          el('h2', { text: 'Recent captured prompts (redacted)' }),
          el('span', { class: 'faint', text: 'Use these to sanity-check the classifier' })
        ]),
        el('table', { class: 'samples' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'When' }), el('th', { text: 'Tool' }),
            el('th', { text: 'Category' }), el('th', { text: 'Prompt' })
          ])]),
          el('tbody', {}, withText.map((e) => el('tr', {}, [
            el('td', { class: 'faint', text: new Date(e.ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
            el('td', { text: VG.adapterLabel(e.site, settings) }),
            el('td', {}, [
              el('span', { text: e.workTypeLabel }),
              el('div', { class: 'faint', text: e.workTypeConfidence ? `confidence ${Math.round(e.workTypeConfidence * 100)}%` : 'low confidence' })
            ]),
            el('td', { class: 'txt', text: e.promptText.slice(0, 260) + (e.promptText.length > 260 ? '…' : '') })
          ])))
        ])
      ]));
    }

    /* caveats, print these under the numbers, always */
    root.appendChild(el('div', { class: 'card stack' }, [
      el('h2', { text: 'What this data cannot tell you' }),
      el('ul', { class: 'muted', style: 'margin:0;padding-left:18px;line-height:1.7' },
        VG.CAVEATS.map((c) => el('li', { text: c })))
    ]));

    /* exports */
    root.appendChild(el('div', { class: 'card row between wrap no-print' }, [
      el('div', {}, [
        el('h2', { text: 'Export' }),
        el('div', { class: 'faint', text: 'Files are generated in the browser. Nothing is uploaded.' })
      ]),
      el('div', { class: 'toolbar' }, [
        el('button', { text: 'Markdown', onclick: async () => {
          const signed = await signedMarkdown();
          download(fname('md'), 'text/markdown', signed.markdown);
          flash('Downloaded · ' + signed.ref);
        } }),
        el('button', { text: 'CSV (events)', onclick: () => download(fname('csv'), 'text/csv', VG.toCSV(state.events, hasText())) }),
        el('button', { text: 'JSON', onclick: () => download(fname('json'), 'application/json', JSON.stringify({ report: state.report, events: state.events }, null, 2)) }),
        el('button', { class: 'primary', text: 'Email report', onclick: emailReport })
      ])
    ]));
  }

  function hasText() {
    return settings && settings.captureLevel !== VG.CAPTURE_LEVELS.METADATA;
  }

  function fname(ext) {
    return `vantage-${slug(state.report.period.label)}-${VG.localDay(state.report.period.from || Date.now())}.${ext}`;
  }

  async function signedMarkdown() {
    const md = VG.reportToMarkdown(state.report);
    return VG.signMarkdown(md, state.report, settings.reportSigningKey);
  }

  async function copySummary() {
    const signed = await signedMarkdown();
    await navigator.clipboard.writeText(signed.markdown);
    flash('Full report copied · ' + signed.ref);
  }

  function emailReport() {
    const r = state.report;
    const to = (settings && settings.reportEmailTo) || '';
    const subject = `AI usage report, ${r.period.label} (${r.period.rangeLabel})`;
    const body = [
      VG.summarise(r),
      '',
      `Prompts: ${r.totals.prompts}  |  Conversations: ${r.totals.conversations}  |  Active days: ${r.totals.activeDays}`,
      `Top categories: ${r.workTypes.slice(0, 3).map((w) => `${w.label} ${w.pct}%`).join(', ')}`,
      `Tools: ${r.sites.map((s) => `${s.label} ${s.pct}%`).join(', ')}`,
      `Prompts with masked data: ${r.risk.promptsWithSensitive} (${r.risk.pctWithSensitive}%)`,
      '',
      'Generated locally by Vantage. Prompt content is redacted on device and is not included above.'
    ].join('\n');

    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (url.length > 1900) {
      navigator.clipboard.writeText(body);
      flash('Report too long for a mail link, copied to clipboard instead');
      window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`;
      return;
    }
    window.location.href = url;
  }

  let flashEl = null;
  function flash(msg) {
    if (!flashEl) {
      flashEl = el('div', { class: 'no-print' });
      Object.assign(flashEl.style, {
        position: 'fixed', bottom: '18px', left: '50%', transform: 'translateX(-50%)',
        background: 'var(--text)', color: 'var(--bg)', padding: '8px 14px',
        borderRadius: '8px', fontSize: '13px', zIndex: '9', opacity: '0',
        transition: 'opacity .15s'
      });
      document.body.appendChild(flashEl);
    }
    flashEl.textContent = msg;
    flashEl.style.opacity = '1';
    clearTimeout(flashEl.__t);
    flashEl.__t = setTimeout(() => { flashEl.style.opacity = '0'; }, 2600);
  }

  /* ----------------------------- load ----------------------------- */

  async function loadPeriod(period) {
    const events = await VG.db.range(period.from, period.to);
    let prev = [];
    if (period.prevFrom !== null && period.prevFrom !== undefined) {
      prev = await VG.db.range(period.prevFrom, period.from);
    }
    // Retention and trajectory need a longer window than the report period.
    const longFrom = VG.addDays(period.to, -90);
    const longEvents = await VG.db.range(Math.min(longFrom, period.from), period.to);

    state.period = period;
    state.events = events;
    state.report = VG.buildReport(events, prev, period, settings, longEvents, org);
    render();
  }

  async function selectPeriod(id) {
    if (id === 'custom') {
      $('customWrap').classList.add('on');
      return;
    }
    $('customWrap').classList.remove('on');
    const periods = VG.periods(settings);
    await loadPeriod(periods[id]);
    localStorage.setItem('vantage.period', id);
  }

  function customPeriod() {
    const f = $('fromDate').value;
    const t = $('toDate').value;
    if (!f || !t) return null;
    const from = new Date(f + 'T00:00:00').getTime();
    const to = new Date(t + 'T00:00:00').getTime() + 86400000;
    const span = to - from;
    return {
      id: 'custom', label: 'Custom range', from, to,
      prevFrom: from - span, grain: 'range'
    };
  }

  async function init() {
    const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, r));
    settings = (res && res.settings) || VG.DEFAULT_SETTINGS;
    org = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_ORG' }, r));

    const saved = localStorage.getItem('vantage.period') || 'last-week';
    $('period').value = saved;
    $('period').addEventListener('change', (e) => selectPeriod(e.target.value));
    $('applyCustom').addEventListener('click', () => {
      const p = customPeriod();
      if (p) loadPeriod(p);
    });

    const today = new Date();
    $('toDate').value = VG.localDay(today.getTime());
    $('fromDate').value = VG.localDay(VG.addDays(today.getTime(), -6));

    await selectPeriod(saved);
  }

  init();
})();
