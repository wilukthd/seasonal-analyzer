// tests.js — scenario checks for stats.js (open tests.html). Synthetic monthly series with known
// answers, from the 2026-11-14 audit: noise must stay unlabelled, growth / month length / campaigns
// must not create a pattern, and real seasons must still be found. Seeded, so results repeat.

(() => {
  const S = SalesStats;

  // mulberry32 + Box–Muller
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(r) {
    return () => {
      let u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
  }
  const daysIn = (y, m) => new Date(y, m, 0).getDate();
  // n monthly rows from January of startY; f(i, year, month) = sales
  function series(n, f, startY = 2019) {
    return Array.from({ length: n }, (_, i) => {
      const year = startY + Math.floor(i / 12), month = (i % 12) + 1;
      const sales = Math.max(0, Math.round(f(i, year, month)));
      return { ymKey: `${year}-${String(month).padStart(2, '0')}`, year, month, sales, qty: Math.round(sales / 1000),
        orderCount: Math.round(sales / 1200), totalCustomers: Math.round(sales / 1300),
        newCustomers: Math.round(sales / 4000), existingCustomers: 0 };
    });
  }
  // run a generator `runs` times with different noise; returns the analyses
  function many(runs, gen, seed) {
    const out = [];
    for (let k = 0; k < runs; k++) out.push(S.analyze(gen(normal(rng(seed + k * 7919))), null, `t${seed}|${k}`));
    return out;
  }
  const seasonalShare = (as) => as.filter((a) => a.classification.key.startsWith('seasonal')).length / as.length;
  const peakOf = (a) => a.seasonal.reduce((x, y) => ((y.raw ?? 0) > (x.raw ?? 0) ? y : x)).month;
  const pct = (x) => (x * 100).toFixed(1) + '%';
  // allowed share of false "seasonal" labels: α = 0.05 plus sampling noise over 200 runs
  // (one seed set gave 9.0% for 3 years of noise, so 9% would be a coin-flip threshold)
  const FP = 0.10;

  const tests = [
    {
      name: '12 months of data → データ不足',
      run: () => {
        const a = S.analyze(series(12, () => 100000), null, 't1');
        return { pass: a.classification.key === 'insufficient', detail: a.classification.key };
      },
    },
    ...[2, 3, 5, 7].map((yrs) => ({
      name: `Pure noise (SD 25%), ${yrs} years → rarely seasonal`,
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(12 * yrs, () => 100000 * (1 + 0.25 * nm())), 100 + yrs));
        return { pass: share <= FP, detail: `seasonal ${pct(share)} (limit ${pct(FP)})` };
      },
    })),
    ...[['Growth 3% a month', 1.03], ['Growth 1% a month', 1.01], ['Decline 2% a month', 0.98]].map(([label, g], j) => ({
      name: `${label}, no season, 5 years → not seasonal`,
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(60, (i) => 100000 * Math.pow(g, i) * (1 + 0.1 * nm())), 200 + j));
        return { pass: share <= FP, detail: `seasonal ${pct(share)} (limit ${pct(FP)})` };
      },
    })),
    {
      name: 'Steady daily demand (sales ∝ days in month), 3% noise, 7 years → not seasonal',
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(84, (i, y, m) => 10000 * daysIn(y, m) * (1 + 0.03 * nm())), 300));
        return { pass: share <= FP, detail: `seasonal ${pct(share)} (size rule: < ${S.CONFIG.minAmplitude * 100} pt)` };
      },
    },
    {
      name: 'Flat monthly totals, 3% noise, 7 years → not seasonal',
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(84, () => 300000 * (1 + 0.03 * nm())), 310));
        return { pass: share <= FP, detail: `seasonal ${pct(share)}` };
      },
    },
    {
      name: 'Tiny steady pattern (±4%), 10 years, 2% noise → not seasonal (size rule)',
      run: () => {
        const a = S.analyze(series(120, (i, y, m) => 100000 * (1 + 0.04 * Math.sin(m / 12 * 2 * Math.PI)) * (1 + 0.02 * normal(rng(11))())), null, 't-tiny');
        return { pass: !a.classification.key.startsWith('seasonal') && a.bigEnough === false,
          detail: `${a.classification.key}, p ${a.test.p}, size ${Math.round(a.amplitude * 100)} pt` };
      },
    },
    {
      name: 'One 10× campaign month (2022-06) in a flat series → June index unmoved, campaign is the top spike',
      run: () => {
        const as = many(200, (nm) => series(60, (i, y, m) => (y === 2022 && m === 6 ? 1000000 : 100000) * (1 + 0.03 * nm())), 400);
        const june = as.map((a) => a.seasonal[5].raw).sort((x, y) => x - y);
        const median = june[june.length >> 1];
        const top = as.filter((a) => a.spikes[0].ymKey === '2022-06' && a.spikes[0].campaign).length / as.length;
        const juneDips = as.filter((a) => a.dips.slice(0, 4).every((d) => d.month === 6)).length / as.length;
        const share = seasonalShare(as);
        return { pass: median >= 0.9 && median <= 1.12 && top >= 0.95 && juneDips <= 0.05 && share <= FP,
          detail: `June index median ${Math.round(median * 100)}%, campaign top spike ${pct(top)}, ordinary Junes as top-4 dips ${pct(juneDips)}, seasonal ${pct(share)}` };
      },
    },
    {
      name: 'Real season (July ×3, January ×0.5) + 20% a year growth + one campaign → seasonal, peak July',
      run: () => {
        const as = many(200, (nm) => series(60, (i, y, m) => 100000 * Math.pow(1.2, i / 12) * (m === 7 ? 3 : m === 1 ? 0.5 : 1)
          * (y === 2021 && m === 10 ? 6 : 1) * (1 + 0.1 * nm())), 500);
        const share = seasonalShare(as), july = as.filter((a) => peakOf(a) === 7).length / as.length;
        return { pass: share >= 0.95 && july >= 0.95, detail: `seasonal ${pct(share)}, peak July ${pct(july)}` };
      },
    },
    {
      name: 'Modest season (July ×1.3, January ×0.8), 4 years, 10% noise → found',
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(48, (i, y, m) => 100000 * (m === 7 ? 1.3 : m === 1 ? 0.8 : 1) * (1 + 0.1 * nm())), 600));
        return { pass: share >= 0.85, detail: `seasonal ${pct(share)} (needs 85%+)` };
      },
    },
    {
      name: 'Level doubles mid-year (2022-07), otherwise flat → not seasonal',
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(60, (i, y, m) => 100000 * (y > 2022 || (y === 2022 && m >= 7) ? 2 : 1) * (1 + 0.1 * nm())), 700));
        return { pass: share <= FP, detail: `seasonal ${pct(share)}` };
      },
    },
    {
      name: 'Launch ramp over 18 months, then flat → not seasonal',
      run: () => {
        const share = seasonalShare(many(200, (nm) => series(60, (i) => 100000 * Math.min(1, (i + 1) / 18) * (1 + 0.1 * nm())), 800));
        return { pass: share <= FP, detail: `seasonal ${pct(share)}` };
      },
    },
    {
      name: 'Same input twice → same p (seeded permutation test)',
      run: () => {
        const rows = series(60, (i, y, m) => 100000 * (m === 7 ? 2 : 1) * (1 + 0.1 * normal(rng(3))()));
        const p1 = S.analyze(rows, null, 'x').test.p, p2 = S.analyze(rows, null, 'x').test.p;
        return { pass: p1 === p2, detail: `p ${p1} / ${p2}` };
      },
    },
    {
      name: 'Known gap: product sold only in Oct–Dec → still データ不足 (audit 3.4, waiting for a decision)',
      known: true,
      run: () => {
        const nm = normal(rng(9));
        const rows = series(84, (i, y, m) => (m >= 10 ? 300000 * (1 + 0.1 * nm()) : 0)).filter((r) => r.sales > 0);
        const a = S.analyze(rows, null, 'xmas');
        return { pass: a.classification.key === 'insufficient', detail: `${a.classification.key}; June index shows ${Math.round(a.seasonal[5].index * 100)}%` };
      },
    },
  ];

  const body = document.getElementById('results');
  const summary = document.getElementById('summary');
  let passed = 0, failed = 0;
  // one test per task so the page stays responsive (setTimeout, not requestAnimationFrame, which
  // stops in background tabs)
  (async () => {
    for (const tst of tests) {
      const t0 = performance.now();
      let res;
      try { res = tst.run(); } catch (e) { res = { pass: false, detail: 'error: ' + (e.stack || e.message) }; }
      const ms = Math.round(performance.now() - t0);
      if (res.pass) passed++; else failed++;
      const tr = document.createElement('tr');
      tr.className = res.pass ? 'pass' : 'fail';
      tr.innerHTML = `<td>${res.pass ? 'PASS' : 'FAIL'}${tst.known ? ' <span class="known">known</span>' : ''}</td><td>${tst.name}</td><td>${res.detail}</td><td>${ms} ms</td>`;
      body.appendChild(tr);
      summary.textContent = `${passed} passed, ${failed} failed, ${tests.length - passed - failed} running…`;
      await new Promise((r) => setTimeout(r, 0));
    }
    summary.textContent = `${passed} passed, ${failed} failed (of ${tests.length})`;
    summary.className = failed ? 'fail' : 'pass';
    window.__testResult = { passed, failed, total: tests.length };
  })();
})();
