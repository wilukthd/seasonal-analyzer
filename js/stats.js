// stats.js — reproduces the seasonality-vs-campaign methodology already used
// in the master 季節性_トレンド分析 sheet: per-year averages, a monthly
// seasonal index (each month as a % of that year's average), a one-way
// ANOVA of month-on-ratio to get eta^2 / F, and simple spike diagnostics.

const SalesStats = (() => {
  const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
  function std(arr, m) {
    const mu = m ?? mean(arr);
    return Math.sqrt(arr.reduce((s, v) => s + (v - mu) ** 2, 0) / arr.length);
  }

  function yearlyAverages(rows, field = 'sales') {
    const byYear = {};
    rows.forEach((r) => {
      byYear[r.year] = byYear[r.year] || [];
      byYear[r.year].push(r[field]);
    });
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    const out = years.map((year) => ({ year, avg: mean(byYear[year]), n: byYear[year].length }));
    // attach YoY
    for (let i = 1; i < out.length; i++) {
      out[i].yoy = out[i - 1].avg > 0 ? (out[i].avg / out[i - 1].avg) - 1 : null;
    }
    return out;
  }

  function withRatios(rows) {
    const yAvg = {};
    yearlyAverages(rows, 'sales').forEach((y) => { yAvg[y.year] = y.avg; });
    return rows.map((r) => ({ ...r, ratio: yAvg[r.year] > 0 ? r.sales / yAvg[r.year] : 0 }));
  }

  function seasonalIndex(rowsWithRatio) {
    const byMonth = {};
    rowsWithRatio.forEach((r) => {
      byMonth[r.month] = byMonth[r.month] || [];
      byMonth[r.month].push(r.ratio);
    });
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const vals = byMonth[m] || [];
      return { month: m, label: MONTH_LABELS[i], index: vals.length ? mean(vals) : null, n: vals.length };
    });
  }

  // One-way ANOVA of ratio ~ month. Returns eta^2, F, df.
  function anovaByMonth(rowsWithRatio) {
    const N = rowsWithRatio.length;
    const grand = mean(rowsWithRatio.map((r) => r.ratio));
    const byMonth = {};
    rowsWithRatio.forEach((r) => {
      byMonth[r.month] = byMonth[r.month] || [];
      byMonth[r.month].push(r.ratio);
    });
    const groups = Object.values(byMonth);
    const k = groups.length;

    let ssBetween = 0, ssTotal = 0;
    groups.forEach((g) => { const gm = mean(g); ssBetween += g.length * (gm - grand) ** 2; });
    rowsWithRatio.forEach((r) => { ssTotal += (r.ratio - grand) ** 2; });
    const ssWithin = ssTotal - ssBetween;

    const dfBetween = k - 1;
    const dfWithin = N - k;
    const eta2 = ssTotal > 0 ? ssBetween / ssTotal : 0;
    const msBetween = ssBetween / dfBetween;
    const msWithin = dfWithin > 0 ? ssWithin / dfWithin : 0;
    const F = msWithin > 0 ? msBetween / msWithin : null;

    return { eta2, F, dfBetween, dfWithin };
  }

  function classify(eta2) {
    if (eta2 >= 0.25) {
      return {
        key: 'seasonal',
        label: '季節性主導型',
        text: '月の要因（季節性）で売上の変動の大部分を説明できます。毎年同じ時期に繰り返す傾向が強いタイプです。',
      };
    }
    if (eta2 >= 0.10) {
      return {
        key: 'mixed',
        label: '混合型（季節性＋単発要因）',
        text: '月の要因である程度は説明できますが、単発のキャンペーン等の影響も無視できません。両方を要因として管理する必要があります。',
      };
    }
    return {
      key: 'campaign',
      label: 'キャンペーン/イベント主導型',
      text: '月による説明力は小さく、特定の施策・キャンペーンなど単発要因が売上変動の主因である可能性が高いタイプです。',
    };
  }

  function diagnoseFactor(row, rowsWithRatio) {
    const aovs = rowsWithRatio.filter((r) => r.orderCount > 0).map((r) => r.sales / r.orderCount);
    const meanAov = aovs.length ? mean(aovs) : 0;
    const aov = row.orderCount > 0 ? row.sales / row.orderCount : 0;

    const custYearAvg = {};
    yearlyAverages(rowsWithRatio, 'totalCustomers').forEach((y) => { custYearAvg[y.year] = y.avg; });
    const custRatio = custYearAvg[row.year] > 0 ? row.totalCustomers / custYearAvg[row.year] : 1;

    const newPcts = rowsWithRatio.filter((r) => r.totalCustomers > 0).map((r) => r.newCustomers / r.totalCustomers);
    const meanNewPct = newPcts.length ? mean(newPcts) : 0;
    const newPct = row.totalCustomers > 0 ? row.newCustomers / row.totalCustomers : 0;

    if (meanAov > 0 && aov > meanAov * 1.15) return '客単価上昇（まとめ買い等）';
    if (custRatio > 1.15 && newPct <= meanNewPct * 1.3) return '既存顧客の再購買';
    if (meanNewPct > 0 && newPct > meanNewPct * 1.5) return '新規顧客の増加';
    if (custRatio > 1.1) return '顧客数の増加';
    return '要因不明瞭';
  }

  function spikesAndDips(rowsWithRatio, topN = 10, bottomN = 5) {
    const ratios = rowsWithRatio.map((r) => r.ratio);
    const mu = mean(ratios);
    const sigma = std(ratios, mu) || 1;
    const withZ = rowsWithRatio.map((r) => ({ ...r, z: (r.ratio - mu) / sigma }));
    const sorted = [...withZ].sort((a, b) => b.ratio - a.ratio);
    const spikes = sorted.slice(0, topN).map((r) => ({ ...r, factor: diagnoseFactor(r, rowsWithRatio) }));
    const dips = [...withZ].sort((a, b) => a.ratio - b.ratio).slice(0, bottomN);
    return { spikes, dips };
  }

  function analyze(rows) {
    const rowsWithRatio = withRatios(rows);
    const yoy = yearlyAverages(rows, 'sales');
    const seasonal = seasonalIndex(rowsWithRatio);
    const anova = anovaByMonth(rowsWithRatio);
    const cls = classify(anova.eta2);
    const { spikes, dips } = spikesAndDips(rowsWithRatio);
    return { rowsWithRatio, yoy, seasonal, anova, classification: cls, spikes, dips };
  }

  return { analyze, yearlyAverages, MONTH_LABELS };
})();
