// stats.js — seasonality analysis per series (月度 data).
//
// Model:   log(sales) = year effect + 月度 effect + noise      (months with sales > 0)
//   Year effects absorb level and trend, so partial years and growth don't distort the
//   月度 pattern; logs make "+50%" mean the same for small and large series.
// Test:    F for the 月度 effect after year effects, p from a within-year permutation
//   test (月度 labels shuffled inside each year). Strength = ω² (bias-corrected η²).
// Short series: each 月度 effect is shrunk toward the shop-wide pattern (empirical Bayes),
//   weight = τ² / (τ² + se²); the weight and a 90% band are reported.
// Data sufficiency: no verdict unless ≥ 24 months with sales and every 月度 seen ≥ 2 times.
// Spikes: robust z (median / MAD) of model residuals — unusual for that year and 月度.
//
// Language-agnostic: returns keys; labels live in i18n.js.

const SalesStats = (() => {
  const CONFIG = {
    minMonths: 24,          // months with sales > 0
    minPerMonth: 2,         // every 月度 observed at least this often
    alpha: 0.05,            // permutation p below this = seasonal
    permutations: 199,
    spikeZ: 3.5,            // robust z of a residual to count as a spike
    spikesPerYear: 0.5,     // at or above = "spiky"
    band: 1.645,            // 90% band
    defaultTau2: 0.17,      // between-series variance of log 月度 effects if it can't be estimated
  };
  const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }

  // Deterministic RNG so a series always gets the same p-value.
  function seededRandom(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return () => {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- two-way additive fit (year + 月度) by backfitting ----------
  // y: year index per obs, m: 月度 0..11, v: log sales
  function fitTwoWay(y, m, v, nYears) {
    const n = v.length;
    const me = new Float64Array(12), ye = new Float64Array(nYears);
    const cntM = new Float64Array(12), cntY = new Float64Array(nYears);
    for (let i = 0; i < n; i++) { cntM[m[i]]++; cntY[y[i]]++; }
    let present = 0;
    for (let k = 0; k < 12; k++) if (cntM[k] > 0) present++;
    const nm = new Float64Array(12);
    for (let it = 0; it < 200; it++) {
      ye.fill(0);
      for (let i = 0; i < n; i++) ye[y[i]] += v[i] - me[m[i]];
      for (let k = 0; k < nYears; k++) ye[k] /= cntY[k];
      nm.fill(0);
      for (let i = 0; i < n; i++) nm[m[i]] += v[i] - ye[y[i]];
      let c = 0;
      for (let k = 0; k < 12; k++) if (cntM[k] > 0) { nm[k] /= cntM[k]; c += nm[k]; }
      c /= present;
      let delta = 0;
      for (let k = 0; k < 12; k++) if (cntM[k] > 0) { nm[k] -= c; delta = Math.max(delta, Math.abs(nm[k] - me[k])); me[k] = nm[k]; }
      if (delta < 1e-9) break;
    }
    let ssr = 0;
    const res = new Float64Array(n);
    for (let i = 0; i < n; i++) { res[i] = v[i] - ye[y[i]] - me[m[i]]; ssr += res[i] * res[i]; }
    return { me, ye, res, ssr, cntM, present };
  }

  function ssrYearOnly(y, v, nYears) {
    const s = new Float64Array(nYears), c = new Float64Array(nYears);
    for (let i = 0; i < v.length; i++) { s[y[i]] += v[i]; c[y[i]]++; }
    let ssr = 0;
    for (let i = 0; i < v.length; i++) { const d = v[i] - s[y[i]] / c[y[i]]; ssr += d * d; }
    return ssr;
  }

  function fStat(y, m, v, nYears, ssrRed) {
    const fit = fitTwoWay(y, m, v, nYears);
    const df1 = fit.present - 1, df2 = v.length - df1 - nYears;
    if (df1 <= 0 || df2 <= 0 || fit.ssr <= 0) return { fit, F: null, df1, df2 };
    return { fit, F: ((ssrRed - fit.ssr) / df1) / (fit.ssr / df2), df1, df2 };
  }

  function buildObs(rows) {
    const pos = rows.filter((r) => r.sales > 0);
    const years = Array.from(new Set(pos.map((r) => r.year))).sort((a, b) => a - b);
    const yi = new Map(years.map((yr, i) => [yr, i]));
    return {
      rows: pos,
      years,
      y: Int32Array.from(pos.map((r) => yi.get(r.year))),
      m: Int32Array.from(pos.map((r) => r.month - 1)),
      v: Float64Array.from(pos.map((r) => Math.log(r.sales))),
    };
  }

  // ---------- shop-wide context (shared by every series) ----------
  // records: all loaded series that count as products. Returns { mu[12], tau2 }.
  function buildContext(records) {
    const tot = new Map();
    records.forEach((rec) => rec.rows.forEach((r) => {
      const k = r.year * 100 + r.month;
      tot.set(k, (tot.get(k) || 0) + r.sales);
    }));
    const shopRows = Array.from(tot, ([k, sales]) => ({ year: Math.floor(k / 100), month: k % 100, sales }));
    let mu = new Float64Array(12);
    if (shopRows.length >= 24) {
      const o = buildObs(shopRows);
      mu = fitTwoWay(o.y, o.m, o.v, o.years.length).me;
    }
    // τ² from long series: spread of their 月度 effects around the shop pattern, minus noise.
    const devs = [];
    records.forEach((rec) => {
      const o = buildObs(rec.rows);
      if (o.v.length < 60) return;
      const fit = fitTwoWay(o.y, o.m, o.v, o.years.length);
      const df2 = o.v.length - (fit.present - 1) - o.years.length;
      if (df2 <= 0) return;
      const mse = fit.ssr / df2;
      for (let k = 0; k < 12; k++) if (fit.cntM[k] > 0) devs.push((fit.me[k] - mu[k]) ** 2 - mse / fit.cntM[k]);
    });
    const tau2 = devs.length >= 60 ? Math.max(1e-4, mean(devs)) : CONFIG.defaultTau2;
    return { mu: Array.from(mu), tau2, seriesCount: records.length };
  }

  // ---------- spike diagnosis (unchanged heuristic, keyed for i18n) ----------
  function yearlyAverages(rows, field = 'sales') {
    const byYear = {};
    rows.forEach((r) => { (byYear[r.year] = byYear[r.year] || []).push(r[field]); });
    return Object.keys(byYear).map(Number).sort((a, b) => a - b)
      .map((year) => ({ year, avg: mean(byYear[year]), n: byYear[year].length }));
  }

  function diagnoseFactor(row, rows) {
    const aovs = rows.filter((r) => r.orderCount > 0).map((r) => r.sales / r.orderCount);
    const meanAov = aovs.length ? mean(aovs) : 0;
    const aov = row.orderCount > 0 ? row.sales / row.orderCount : 0;
    const custYearAvg = {};
    yearlyAverages(rows, 'totalCustomers').forEach((y) => { custYearAvg[y.year] = y.avg; });
    const custRatio = custYearAvg[row.year] > 0 ? row.totalCustomers / custYearAvg[row.year] : 1;
    const newPcts = rows.filter((r) => r.totalCustomers > 0).map((r) => r.newCustomers / r.totalCustomers);
    const meanNewPct = newPcts.length ? mean(newPcts) : 0;
    const newPct = row.totalCustomers > 0 ? row.newCustomers / row.totalCustomers : 0;
    if (meanAov > 0 && aov > meanAov * 1.15) return 'aov_increase';
    if (custRatio > 1.15 && newPct <= meanNewPct * 1.3) return 'repeat_purchase';
    if (meanNewPct > 0 && newPct > meanNewPct * 1.5) return 'new_customer_growth';
    if (custRatio > 1.1) return 'customer_increase';
    return 'unclear';
  }

  // ---------- year-on-year on matching 月度 only ----------
  function yearOnYear(rows) {
    const byYear = new Map();
    rows.forEach((r) => {
      if (!byYear.has(r.year)) byYear.set(r.year, new Map());
      byYear.get(r.year).set(r.month, r.sales);
    });
    const years = Array.from(byYear.keys()).sort((a, b) => a - b);
    return years.map((year) => {
      const cur = byYear.get(year);
      const out = { year, avg: mean(Array.from(cur.values())), n: cur.size, partial: cur.size < 12, yoy: null, compared: 0 };
      const prev = byYear.get(year - 1);
      if (prev) {
        let a = 0, b = 0, k = 0;
        cur.forEach((sales, month) => { if (prev.has(month)) { a += sales; b += prev.get(month); k++; } });
        if (k > 0 && b > 0) { out.yoy = a / b - 1; out.compared = k; }
      }
      return out;
    });
  }

  // ---------- main ----------
  function analyze(rows, ctx, seedKey = '') {
    ctx = ctx || { mu: new Array(12).fill(0), tau2: CONFIG.defaultTau2 };
    const o = buildObs(rows);
    const n = o.v.length, nYears = o.years.length;
    const perMonth = new Array(12).fill(0);
    o.m.forEach((k) => { perMonth[k]++; });
    const minPerMonth = Math.min(...perMonth);
    const sufficiency = {
      ok: n >= CONFIG.minMonths && minPerMonth >= CONFIG.minPerMonth,
      months: n, years: nYears, minPerMonth,
      excluded: rows.length - n,        // months with sales ≤ 0, left out of the model
    };

    let test = { F: null, p: null, omega2: null, df1: 0, df2: 0 };
    let fit = null, mse = null;
    if (n >= 14) {
      const ssrRed = ssrYearOnly(o.y, o.v, nYears);
      const base = fStat(o.y, o.m, o.v, nYears, ssrRed);
      if (base.F != null) {
        fit = base.fit;
        mse = fit.ssr / base.df2;
        const ssb = ssrRed - fit.ssr;
        test = {
          F: base.F, df1: base.df1, df2: base.df2, p: null,
          omega2: Math.max(0, (ssb - base.df1 * mse) / (ssrRed + mse)),
        };
        // within-year permutation of 月度 labels
        const rand = seededRandom(seedKey + '|' + n);
        const groups = Array.from({ length: nYears }, () => []);
        for (let i = 0; i < n; i++) groups[o.y[i]].push(i);
        const mp = Int32Array.from(o.m);
        let hits = 0;
        for (let b = 0; b < CONFIG.permutations; b++) {
          groups.forEach((idx) => {
            for (let i = idx.length - 1; i > 0; i--) {
              const j = Math.floor(rand() * (i + 1));
              const a = idx[i], c = idx[j];
              const t = mp[a]; mp[a] = mp[c]; mp[c] = t;
            }
          });
          const st = fStat(o.y, mp, o.v, nYears, ssrRed);
          if (st.F != null && st.F >= base.F) hits++;
        }
        test.p = (hits + 1) / (CONFIG.permutations + 1);
      }
    }

    // 月度 index: own estimate shrunk toward the shop pattern
    const seasonal = MONTH_LABELS.map((label, k) => {
      const shop = Math.exp(ctx.mu[k]);
      if (!fit || !fit.cntM[k]) {
        return { month: k + 1, label, index: shop, lo: null, hi: null, raw: null, n: perMonth[k], weight: 0, shop, relative: 1 };
      }
      const se2 = mse / fit.cntM[k];
      const w = ctx.tau2 / (ctx.tau2 + se2);
      const est = ctx.mu[k] + w * (fit.me[k] - ctx.mu[k]);
      const sd = Math.sqrt(w * se2);
      const index = Math.exp(est);
      return {
        month: k + 1, label, index, raw: Math.exp(fit.me[k]),
        lo: Math.exp(est - CONFIG.band * sd), hi: Math.exp(est + CONFIG.band * sd),
        n: perMonth[k], weight: w, shop, relative: index / shop,
      };
    });
    const withW = seasonal.filter((s) => s.n > 0);
    const weight = fit && withW.length ? mean(withW.map((s) => s.weight)) : 0;

    // residuals → ratio to the model's expectation, robust z, spikes
    let rowsWithRatio = rows.map((r) => ({ ...r, ratio: null, z: null }));
    let spikeCount = 0;
    if (fit) {
      const med = median(Array.from(fit.res));
      const mad = median(Array.from(fit.res, (r) => Math.abs(r - med))) * 1.4826 || 1e-9;
      const byKey = new Map();
      o.rows.forEach((r, i) => byKey.set(r.ymKey, { ratio: Math.exp(fit.res[i]), z: (fit.res[i] - med) / mad }));
      rowsWithRatio = rows.map((r) => ({ ...r, ...(byKey.get(r.ymKey) || { ratio: null, z: null }) }));
      spikeCount = rowsWithRatio.filter((r) => r.z != null && r.z > CONFIG.spikeZ).length;
    }
    const spiky = nYears > 0 && spikeCount / nYears >= CONFIG.spikesPerYear;
    const modeled = rowsWithRatio.filter((r) => r.z != null);
    const spikes = [...modeled].sort((a, b) => b.z - a.z).slice(0, 10)
      .map((r) => ({ ...r, factorKey: diagnoseFactor(r, rows) }));
    const dips = [...modeled].sort((a, b) => a.z - b.z).slice(0, 5);

    let key;
    if (!sufficiency.ok || test.p == null) key = 'insufficient';
    else if (test.p < CONFIG.alpha) key = spiky ? 'seasonal-spiky' : 'seasonal';
    else key = spiky ? 'spiky' : 'stable';

    return {
      rowsWithRatio, seasonal, weight, sufficiency, test, spikeCount, spiky,
      yoy: yearOnYear(rows), classification: { key }, spikes, dips,
    };
  }

  return { analyze, buildContext, yearlyAverages, CONFIG, MONTH_LABELS };
})();
