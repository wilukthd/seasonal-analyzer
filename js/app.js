// app.js — wires up views, upload handling, and rendering.

// Safety net: if anything throws (e.g. a mismatched deploy where index.html
// and app.js are out of sync), show it instead of silently doing nothing.
window.addEventListener('error', (e) => {
  showFatalError(e.error ? (e.error.stack || e.error.message) : e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  showFatalError(e.reason ? (e.reason.stack || e.reason.message) : String(e.reason));
});
function showFatalError(detail) {
  let banner = document.getElementById('fatal-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'fatal-error-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#9B3B32;color:#fff;padding:12px 20px;font-family:monospace;font-size:12.5px;white-space:pre-wrap;';
    document.body.prepend(banner);
  }
  const msg = (typeof I18N !== 'undefined' && I18N.t)
    ? I18N.t('error.banner', detail)
    : 'An error occurred. Check that index.html / css / js are all the current version: ' + detail;
  banner.textContent = msg;
}

(() => {
  const t = I18N.t;
  const fmtInt = (n) => Math.round(n).toLocaleString(I18N.getLang() === 'en' ? 'en-US' : 'ja-JP');
  const fmtYen = (n) => '¥' + Math.round(n).toLocaleString(I18N.getLang() === 'en' ? 'en-US' : 'ja-JP');
  const fmtPct = (n, digits = 1) => (n * 100).toFixed(digits) + '%';
  const fmtSignedPct = (n, digits = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';
  const clsLabel = (key) => t('classification.' + key + '.label');
  const clsText = (key) => t('classification.' + key + '.text');
  const factorLabel = (key) => t('factor.' + key);
  const monthLabel = (m) => t('month.' + m);

  let currentProduct = null;
  // SKU filter on the detail page: null = the whole series, else a Set of 商品コード.
  // currentView is currentProduct, or the selected SKUs summed into series-shaped rows.
  let skuSelection = null;
  let currentView = null;
  let calendarSortKey = 'eta2';
  let calendarSortDir = -1;
  // Excel-style column filters: null = no filter (show all); Set = only show these values.
  const calendarColumnFilters = { name: null, class: null };
  let openPopover = null;

  // ---------------- view routing ----------------
  function showView(id) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    document.getElementById('view-' + id).classList.add('is-active');
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === id));
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showView(btn.dataset.view);
      if (btn.dataset.view === 'products') renderProductsList();
      if (btn.dataset.view === 'calendar') renderCalendar();
      if (btn.dataset.view === 'notes') renderNotesView();
      if (btn.dataset.view === 'momentum') renderMomentum();
      if (btn.dataset.view === 'channels') renderChannelsTab();
    });
  });

  document.getElementById('back-to-products').addEventListener('click', () => {
    showView('products');
    renderProductsList();
  });

  // ---------------- upload ----------------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const uploadLog = document.getElementById('upload-log');

  ['dragover'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
  }));
  dropzone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.(xlsx|json)$/i.test(f.name));
    handleFiles(files);
  });
  fileInput.addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files || []));
    fileInput.value = '';
  });

  function logRow(name, ok, msg) {
    const row = document.createElement('div');
    row.className = 'log-row ' + (ok ? 'ok' : 'err');
    row.innerHTML = `<span class="name">${escapeHtml(name)}</span><span class="msg">${escapeHtml(msg)}</span>`;
    uploadLog.prepend(row);
  }

  async function handleBundle(file) {
    const bundle = await SalesParser.parseBundle(file);
    const tally = { isNew: 0, added: 0, updated: 0 };
    for (const s of bundle.series) {
      const result = await SalesDB.mergeAndPut({ ...s, sourceFileName: file.name });
      if (result.isNew) tally.isNew++;
      tally.added += result.isNew ? 0 : result.added;
      tally.updated += result.updated;
    }
    logRow(file.name, true, t('upload.bundleDone', bundle.series.length, tally.isNew, tally.added, tally.updated, bundle.dataThrough));
  }

  async function handleFiles(files) {
    for (const file of files) {
      if (/\.json$/i.test(file.name)) {
        try { await handleBundle(file); } catch (err) { logRow(file.name, false, err.message || String(err)); }
        continue;
      }
      try {
        const parsed = await SalesParser.parseWorkbook(file);
        const result = await SalesDB.mergeAndPut({
          name: parsed.name,
          sourceFileName: file.name,
          rows: parsed.rows,
        });

        let msg;
        if (result.isNew) {
          msg = t('upload.newProduct', result.added);
        } else if (result.added === 0 && result.updated === 0) {
          msg = t('upload.noChange', result.unchanged);
        } else {
          const parts = [];
          if (result.added > 0) parts.push(t('upload.addedMonths', result.added));
          if (result.updated > 0) parts.push(t('upload.updatedMonths', result.updated));
          msg = t('upload.appliedSuffix', parts.join(' / '));
        }
        logRow(parsed.name, true, msg);
      } catch (err) {
        logRow(file.name, false, err.message || String(err));
      }
    }
  }

  // A product is "stale" if its latest month is more than ~2 calendar
  // months behind today — a light nudge, not a hard rule (export timing varies).
  function monthsBehind(lastYmKey) {
    const [y, m] = lastYmKey.split('-').map(Number);
    const today = new Date();
    return (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
  }

  // ---------------- scope (会計区分 / ended series) ----------------
  // Shared by the products list and the calendar. Series from products.json carry
  // 会計区分 and an active flag; .xlsx uploads have neither and count as "manual".
  const ACCT_MANUAL = '__manual';
  const SCOPE_KEY = 'thd-sales-ledger-scope';
  const scope = (() => {
    const fallback = { accounts: ['商品売上高', ACCT_MANUAL], includeEnded: false };
    try { return { ...fallback, ...JSON.parse(localStorage.getItem(SCOPE_KEY) || '{}') }; } catch (e) { return fallback; }
  })();
  function saveScope() {
    try { localStorage.setItem(SCOPE_KEY, JSON.stringify(scope)); } catch (e) { /* ignore */ }
  }
  const acctKey = (p) => (p.accounting === undefined ? ACCT_MANUAL : (p.accounting || '—'));
  const acctLabel = (k) => (k === ACCT_MANUAL ? t('scope.manual') : k);
  const isActive = (p) => p.active !== false;
  const inScope = (p) => scope.accounts.includes(acctKey(p)) && (scope.includeEnded || isActive(p));

  function renderScopeBar(container, products, onChange) {
    const counts = new Map();
    products.forEach((p) => {
      if (!scope.includeEnded && !isActive(p)) return;
      counts.set(acctKey(p), (counts.get(acctKey(p)) || 0) + 1);
    });
    const keys = Array.from(new Set([...products.map(acctKey)]))
      .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    const endedCount = products.filter((p) => !isActive(p)).length;
    container.innerHTML = `
      <span class="scope-label">${escapeHtml(t('scope.label'))}</span>
      ${keys.map((k) => `
        <label class="scope-chip${scope.accounts.includes(k) ? ' is-on' : ''}">
          <input type="checkbox" value="${escapeHtml(k)}" ${scope.accounts.includes(k) ? 'checked' : ''} />
          ${escapeHtml(acctLabel(k))} <span class="scope-n">${counts.get(k) || 0}</span>
        </label>`).join('')}
      ${endedCount ? `
        <label class="scope-ended">
          <input type="checkbox" data-ended ${scope.includeEnded ? 'checked' : ''} />
          ${escapeHtml(t('scope.includeEnded', endedCount))}
        </label>` : ''}
    `;
    container.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.addEventListener('change', () => {
        if (box.hasAttribute('data-ended')) scope.includeEnded = box.checked;
        else scope.accounts = Array.from(container.querySelectorAll('input:not([data-ended]):checked')).map((b) => b.value);
        saveScope();
        onChange();
      });
    });
  }

  // ---------------- analysis (shared context + cache) ----------------
  // The shop-wide 月度 pattern and τ² come from the 商品売上高 series of products.json.
  // Manual .xlsx uploads are only used when no bundle is loaded: they usually duplicate
  // a 中区分 series and would be counted twice. The permutation test is the slow part,
  // so results are cached until the data changes.
  let analysisCtx = null;
  let analysisSig = '';
  let ctxRecords = [];
  let latestAll = '';
  const analysisCache = new Map();
  const periodCtxCache = new Map();
  function ensureContext(products) {
    const sig = chFilter + '|' + products.length + '|' + products.reduce((m, p) => (p.lastUpdatedAt > m ? p.lastUpdatedAt : m), '');
    if (sig === analysisSig && analysisCtx) return;
    const bundle = products.filter((p) => acctKey(p) === '商品売上高');
    const manual = products.filter((p) => acctKey(p) === ACCT_MANUAL);
    ctxRecords = bundle.length ? bundle : (manual.length ? manual : products);
    analysisCtx = SalesStats.buildContext(ctxRecords);
    latestAll = latestYm(products);
    analysisSig = sig;
    analysisCache.clear();
    periodCtxCache.clear();
  }

  // 期間: the verdict, seasonal index and spikes can be computed on the last 5 or 3 years only.
  // Windows end at the latest 月度 loaded, so every series uses the same years. Shorter windows
  // are not offered: the model needs every 月度 seen at least twice.
  const PERIOD_KEY = 'thd-sales-ledger-period';
  const PERIODS = [0, 5, 3];   // years; 0 = 全期間
  let period = (() => {
    try { const v = Number(localStorage.getItem(PERIOD_KEY)); return PERIODS.includes(v) ? v : 0; } catch (e) { return 0; }
  })();
  const periodFrom = () => (period ? shiftYm(latestAll, -(12 * period - 1)) : '');
  const windowRows = (rows) => (period ? rows.filter((r) => r.ymKey >= periodFrom()) : rows);
  // A series with no sales in the window has dropped out of it: leave it off the list and calendar.
  const inPeriod = (p) => !period || p.rows.some((r) => r.ymKey >= periodFrom() && r.sales > 0);
  // The shop-wide pattern is recomputed on the same years; τ² keeps its lifetime estimate,
  // because it needs series of 60+ months to measure.
  function periodCtx() {
    if (!period) return analysisCtx;
    if (!periodCtxCache.has(period)) {
      const recs = ctxRecords.map((r) => ({ ...r, rows: windowRows(r.rows) })).filter((r) => r.rows.length);
      periodCtxCache.set(period, { ...SalesStats.buildContext(recs), tau2: analysisCtx.tau2 });
    }
    return periodCtxCache.get(period);
  }
  function periodNote() {
    return period ? t('period.note', period, periodFrom(), latestAll) : '';
  }

  function analysisOf(p) {
    const key = p.name + '|' + p.lastUpdatedAt + '|' + period + '|' + chFilter + (p.selection ? '|' + p.selection.codes.join(',') : '');
    if (!analysisCache.has(key)) analysisCache.set(key, SalesStats.analyze(windowRows(p.rows), periodCtx(), p.name));
    return analysisCache.get(key);
  }
  // ω² and p are only shown when the series has enough data for a verdict; on short
  // series they are noise, which is the whole point of the データ不足 rule.
  const omegaOf = (a) => (a.sufficiency.ok && a.test.omega2 != null ? a.test.omega2 : null);
  const fmtOmega = (a) => (omegaOf(a) == null ? '—' : fmtPct(omegaOf(a)));
  const fmtP = (p) => (p == null ? '—' : p.toFixed(3));

  // 季節指数 display mode, shared by the detail chart and the calendar.
  let seasonMode = 'absolute';   // 'absolute' | 'relative' (÷ shop-wide pattern)
  const seasonValue = (s) => (seasonMode === 'relative' ? s.relative : s.index);

  // Latest 月度 across everything loaded, so "last 12" means the same window for every row.
  function latestYm(products) {
    return products.reduce((max, p) => {
      const last = p.rows[p.rows.length - 1].ymKey;
      return last > max ? last : max;
    }, '');
  }
  function shiftYm(ymKey, months) {
    const [y, m] = ymKey.split('-').map(Number);
    const d = new Date(y, m - 1 + months, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function sumSince(rows, fromYm) {
    return rows.reduce((s, r) => (r.ymKey >= fromYm ? s + r.sales : s), 0);
  }

  let productsSearch = '';
  let productsSortKey = 'sales12';
  let productsSortDir = -1;

  // ---------------- products list ----------------
  async function renderProductsList() {
    const products = await loadAll();
    const tbody = document.querySelector('#products-table tbody');
    const empty = document.getElementById('products-empty');
    const noResults = document.getElementById('products-no-results');
    const countEl = document.getElementById('products-count');
    tbody.innerHTML = '';

    const scopeBar = document.getElementById('products-scope');
    if (products.length === 0) {
      empty.hidden = false;
      noResults.hidden = true;
      countEl.textContent = '';
      scopeBar.innerHTML = '';
      return;
    }
    empty.hidden = true;
    renderScopeBar(scopeBar, products, renderProductsList);
    ensureContext(products);

    const from12 = shiftYm(latestYm(products), -11);
    const scoped = products.filter(inScope).filter(inPeriod);
    const computed = scoped.map((p) => {
      const analysis = analysisOf(p);
      const first = p.rows[0], last = p.rows[p.rows.length - 1];
      return {
        name: p.name,
        firstYm: first.ymKey,
        lastYm: last.ymKey,
        months: p.rows.length,
        sales12: sumSince(p.rows, from12),
        active: isActive(p),
        classification: analysis.classification,
        eta2: omegaOf(analysis) ?? -1,
        eta2Text: fmtOmega(analysis),
        stale: isActive(p) && monthsBehind(last.ymKey) >= 2,
        staleBehind: monthsBehind(last.ymKey),
        rows: p.rows,
        seasonal: analysis.seasonal,
        tentative: !analysis.sufficiency.ok,
        growth: growthOf(p.rows, from12),
      };
    });

    const filtered = productsSearch
      ? computed.filter((p) => p.name.toLowerCase().includes(productsSearch.toLowerCase()))
      : computed;

    filtered.sort((a, b) => {
      let av, bv;
      switch (productsSortKey) {
        case 'span': av = a.firstYm; bv = b.firstYm; break;
        case 'months': av = a.months; bv = b.months; break;
        case 'sales12': av = a.sales12; bv = b.sales12; break;
        case 'class': av = clsLabel(a.classification.key); bv = clsLabel(b.classification.key); break;
        case 'eta2': av = a.eta2; bv = b.eta2; break;
        case 'last': av = a.lastYm; bv = b.lastYm; break;
        default: av = a.name; bv = b.name;
      }
      if (typeof av === 'string') return productsSortDir * av.localeCompare(bv, 'ja');
      return productsSortDir * (av - bv);
    });

    countEl.textContent = t('products.count', filtered.length, products.length) + periodNote() + channelNote();
    noResults.hidden = filtered.length > 0;

    filtered.forEach((p) => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      const staleTag = p.stale
        ? `<span class="class-tag stale-tag" title="${escapeHtml(t('products.staleTitle', p.staleBehind))}">${escapeHtml(t('products.staleTag'))}</span>`
        : (p.active ? '' : `<span class="class-tag ended-tag">${escapeHtml(t('products.endedTag'))}</span>`);
      tr.innerHTML = `
        <td class="name-cell">${escapeHtml(p.name)}</td>
        <td>${t('products.dateRange', p.firstYm, p.lastYm)}</td>
        <td class="pct-cell">${p.months}</td>
        <td class="pct-cell">${p.sales12 ? fmtCompactYen(p.sales12) : '—'}</td>
        <td><span class="class-tag" style="background:var(--${p.classification.key}-bg); color:var(--${p.classification.key});">${escapeHtml(clsLabel(p.classification.key))}</span></td>
        <td class="pct-cell">${p.eta2Text}</td>
        <td class="last-cell">${p.lastYm}${staleTag}</td>
      `;
      tr.addEventListener('click', () => openProductDetail(p.name));
      tbody.appendChild(tr);
    });
    if (isVisual()) renderProductsVisual(filtered, latestYm(products));
  }

  document.getElementById('prod-search').addEventListener('input', (e) => {
    productsSearch = e.target.value.trim();
    renderProductsList();
  });

  document.querySelectorAll('#products-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (productsSortKey === key) productsSortDir *= -1;
      else { productsSortKey = key; productsSortDir = key === 'sales12' || key === 'eta2' ? -1 : 1; }
      renderProductsList();
    });
  });

  // ---------------- product detail ----------------
  async function openProductDetail(name) {
    const record = await loadOne(name);
    if (!record) return;
    ensureContext(await loadAll());
    if (!currentProduct || currentProduct.name !== name) skuSelection = null;
    currentProduct = record;
    showView('detail');
    renderProductDetailContent(record);
  }

  // Renders detail content for a record WITHOUT navigating — used both by
  // openProductDetail() and by the language-change re-render, since the
  // latter must not force-switch the view if the user is on another tab.
  function renderProductDetailContent(record) {
    const view = selectionView(record);
    currentView = view;
    const analysis = analysisOf(view);

    document.getElementById('detail-title').textContent = record.name;
    renderSelectionBar(view);
    const first = view.rows[0], last = view.rows[view.rows.length - 1];
    document.getElementById('detail-sub').textContent =
      t('detail.sub', first.ymKey, last.ymKey, record.sourceFileName)
      + (record.accounting !== undefined ? t('detail.subMeta', acctLabel(acctKey(record)), isActive(record)) : '')
      + periodNote() + channelNote();

    const cls = analysis.classification;
    const badge = document.getElementById('detail-classification-badge');
    badge.textContent = clsLabel(cls.key);
    badge.style.color = `var(--${cls.key})`;
    document.getElementById('detail-classification-text').textContent = clsText(cls.key);
    document.getElementById('detail-eta2').textContent = fmtOmega(analysis);
    document.getElementById('detail-fval').textContent = analysis.sufficiency.ok ? fmtP(analysis.test.p) : '—';
    document.getElementById('detail-span').textContent = t('detail.monthsUnit', windowRows(view.rows).length);
    renderReliability(analysis);
    renderClassViz(analysis);

    renderSeasonalBars(analysis);
    renderYoyTable(analysis.yoy);
    renderYoyViz(analysis.yoy);
    renderSpikeList('spike-list', analysis.spikes, true, true);
    renderSpikeList('dip-list', analysis.dips, false, false);
    renderSpikeTimeline(view.rows, analysis);
    renderRawTable(view.rows);
    renderRawViz(view.rows, analysis);
    renderSkuTable(record);
    renderBuyers(view);
    renderChannelCard(view);
    initTrendSection(view.rows, record.name);
  }

  // Sum the selected SKUs into rows shaped like series rows. Sales, units and lines add up;
  // customers do not (one person can buy two SKUs), so they are only kept for a single SKU.
  function selectionView(record) {
    const skus = record.skus || [];
    if (!skuSelection || !skus.length) return record;
    const chosen = skus.filter((s) => skuSelection.has(s.code));
    if (!chosen.length || chosen.length === skus.length) return record;
    const byKey = new Map();
    chosen.forEach((s) => s.rows.forEach((r) => {
      const o = byKey.get(r[0]) || { sales: 0, qty: 0, orderCount: 0, ch: null };
      o.sales += r[1]; o.qty += r[2]; o.orderCount += r[3];
      const c = s.ch && s.ch[r[0]];
      if (c) {
        o.ch = o.ch || {};
        Object.keys(c).forEach((k) => { o.ch[k] = (o.ch[k] || 0) + c[k]; });
      }
      byKey.set(r[0], o);
    }));
    const single = chosen.length === 1 ? new Map(chosen[0].rows.map((r) => [r[0], r])) : null;
    const rows = [...byKey.keys()].sort().map((k) => {
      const [year, month] = k.split('-').map(Number);
      const row = { ymKey: k, year, month, ...byKey.get(k),
        orders: null, totalCustomers: null, newCustomers: null, existingCustomers: null };
      const sr = single && single.get(k);
      if (sr && sr.length >= 10) row.buyers = sr.slice(4, 10);
      if (!row.ch) delete row.ch;
      if (chFilter) { row.qty = null; row.orderCount = null; }
      return row;
    });
    return { ...record, rows, skus: chosen,
      selection: { codes: chosen.map((s) => s.code), total: skus.length, single: chosen.length === 1 } };
  }

  function renderSelectionBar(view) {
    const bar = document.getElementById('detail-selection');
    bar.hidden = !view.selection;
    if (!view.selection) return;
    const names = view.skus.map((s) => s.code).join(', ');
    bar.innerHTML = `<span>${escapeHtml(t('sel.showing', view.selection.codes.length, view.selection.total, names))}</span>
      <button type="button" class="sel-reset">${escapeHtml(t('sel.reset'))}</button>
      <span class="muted-small">${escapeHtml(t('sel.note'))}</span>`;
    bar.querySelector('.sel-reset').addEventListener('click', () => {
      skuSelection = null;
      renderProductDetailContent(currentProduct);
    });
  }

  // ---------------- buyer types (products.json with series_buyers / sku_buyers) ----------------
  // row.buyers = [店舗新規, 商品初回, 継続, 復帰, 再購入, 新顔再購入]; 再購入 is null for
  // the last 6 月度. 新顔 = 店舗新規 + 商品初回 + 復帰 (everyone who is not a 継続 buyer).
  const BUYER_KEYS = ['shopNew', 'productNew', 'regular', 'returning'];
  const sumB = (b) => b[0] + b[1] + b[2] + b[3];
  const newcB = (b) => b[0] + b[1] + b[3];
  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function repeatRates(rows) {
    const m = rows.filter((r) => r.buyers[4] != null);
    const all = m.reduce((s, r) => s + sumB(r.buyers), 0), rep = m.reduce((s, r) => s + r.buyers[4], 0);
    const nc = m.reduce((s, r) => s + newcB(r.buyers), 0), nr = m.reduce((s, r) => s + r.buyers[5], 0);
    return { all: all ? rep / all : null, newc: nc >= 5 ? nr / nc : null, from: m.length ? m[0].ymKey : null, to: m.length ? m[m.length - 1].ymKey : null };
  }

  // What changed in a spike month, against the median month of the 12 月度 before it.
  function buyerDriver(rows, row) {
    if (!row.buyers) return null;
    const prev = rows.filter((r) => r.buyers && r.ymKey >= shiftYm(row.ymKey, -12) && r.ymKey < row.ymKey);
    if (prev.length < 3) return null;
    const base = [0, 1, 2, 3].map((i) => median(prev.map((r) => r.buyers[i])));
    const b = row.buyers, d = b.slice(0, 4).map((v, i) => v - base[i]);
    const reach = d[1] + d[3];
    // 'bigger' when buyer growth explains less than half of the sales growth
    const salesBase = median(prev.map((r) => r.sales));
    const buyerBase = base.reduce((s, v) => s + v, 0);
    const salesUp = salesBase > 0 ? row.sales / salesBase - 1 : 0;
    const buyersUp = buyerBase > 0 ? sumB(b) / buyerBase - 1 : 0;
    let key;
    if (buyersUp < 0.5 * salesUp || sumB(b) <= buyerBase + 2) key = 'bigger';
    else if (reach >= d[0] && reach >= d[2]) key = 'reach';
    else if (d[0] >= d[2]) key = 'acquire';
    else key = 'regular';
    const nc = newcB(b);
    return { key, b, base, newRate: b[5] != null && nc >= 3 ? b[5] / nc : null, baseRate: repeatRates(prev).newc };
  }

  function buyerDriverEl(d) {
    const p = document.createElement('p');
    p.className = 'spike-buyers';
    const parts = BUYER_KEYS.map((k, i) => t('buyers.vsUsual', t('buyers.' + k), d.b[i], Math.round(d.base[i])));
    let text = t('buyers.label') + ' ' + parts.join(' · ');
    text += '\n' + t('buyers.pattern') + ' ' + t('buyers.pattern.' + d.key);
    if (d.newRate != null) {
      text += '\n' + t('buyers.spikeRepeat', fmtPct(d.newRate, 0), d.baseRate != null ? fmtPct(d.baseRate, 0) : '—');
    }
    p.textContent = text;
    return p;
  }

  let buyerRange = 'recent';
  function renderBuyers(view) {
    const card = document.getElementById('buyer-card');
    const rows = view.rows.filter((r) => Array.isArray(r.buyers));
    if (currentProduct.buyersHidden) {
      card.hidden = false;
      document.getElementById('buyer-sub').textContent = '';
      document.getElementById('buyer-summary').innerHTML = document.getElementById('buyer-viz').innerHTML =
        `<p class="is-weak">${escapeHtml(t('buyers.channelHidden'))}</p>`;
      document.getElementById('buyer-chart').innerHTML = '';
      return;
    }
    const seriesHas = (currentProduct.rows || []).some((r) => Array.isArray(r.buyers));
    card.hidden = !seriesHas;
    if (!seriesHas) return;
    const summary = document.getElementById('buyer-summary');
    const chart = document.getElementById('buyer-chart');
    document.getElementById('buyer-sub').textContent = view.selection
      ? (view.selection.single ? t('buyers.subSku', view.selection.codes[0]) : '')
      : t('buyers.subSeries');
    const vizBox = document.getElementById('buyer-viz');
    const noData = view.selection && !view.selection.single ? 'buyers.multiSku' : (!rows.length ? 'buyers.none' : null);
    if (noData) {
      summary.innerHTML = vizBox.innerHTML = `<p class="is-weak">${escapeHtml(t(noData))}</p>`;
      chart.innerHTML = '';
      return;
    }
    summary.innerHTML = buyerSummary(rows).map((x) => `<p class="${x.warn ? 'buyer-warn' : ''}">${escapeHtml(x.text)}</p>`).join('');
    renderBuyerViz(rows);
    renderBuyerChart(chart, buyerRange === 'all' ? rows : rows.filter((r) => r.ymKey >= shiftYm(rows[rows.length - 1].ymKey, -35)));
  }

  // Last 12 月度 against the 12 before: buyer mix, 6-月度 repurchase, and the warnings.
  function buyerStats(rows) {
    const last = rows[rows.length - 1].ymKey;
    const win = (a, b) => rows.filter((r) => r.ymKey > shiftYm(last, a) && r.ymKey <= shiftYm(last, b));
    const tot = (rs) => [0, 1, 2, 3].map((i) => rs.reduce((s, r) => s + r.buyers[i], 0));
    const cur = tot(win(-12, 0)), prev = tot(win(-24, -12));
    const n = cur.reduce((s, v) => s + v, 0), pn = prev.reduce((s, v) => s + v, 0);
    const nc = cur[0] + cur[1] + cur[3], pnc = prev[0] + prev[1] + prev[3];
    const mature = rows.filter((r) => r.buyers[4] != null);
    let rc = null, rp = null;
    if (mature.length) {
      const ml = mature[mature.length - 1].ymKey;
      rc = repeatRates(mature.filter((r) => r.ymKey > shiftYm(ml, -12)));
      rp = repeatRates(mature.filter((r) => r.ymKey > shiftYm(ml, -24) && r.ymKey <= shiftYm(ml, -12)));
    }
    const warns = [];
    if (rc && rc.newc != null && rp.newc != null && rc.newc < rp.newc - 0.1) warns.push('warnStick');
    if (pn && n < pn * 0.85 && n && nc / n < 0.15) warns.push('warnShrinking');
    const inflow = pnc >= 10 && nc >= pnc * 1.5 ? nc / pnc : null;
    return { cur, prev, n, pn, nc, rc, rp, warns, inflow };
  }

  function buyerSummary(rows) {
    const s = buyerStats(rows);
    const out = [{ text: t('buyers.sum12', fmtInt(s.n), s.pn ? fmtInt(s.pn) : '—', s.pn ? fmtSignedPct(s.n / s.pn - 1, 0) : '—',
      s.n ? fmtPct(s.cur[2] / s.n, 0) : '—', fmtInt(s.nc), fmtInt(s.cur[0]), fmtInt(s.cur[1]), fmtInt(s.cur[3])) }];
    if (s.rc) {
      const f = (v) => (v == null ? '—' : fmtPct(v, 0));
      out.push({ text: t('buyers.repeat', s.rc.from, s.rc.to, f(s.rc.all), f(s.rc.newc), f(s.rp.all), f(s.rp.newc)) });
    }
    s.warns.forEach((w) => out.push({ warn: true, text: t('buyers.' + w) }));
    if (s.inflow) out.push({ text: t('buyers.noteInflow', s.inflow.toFixed(1)) });
    return out;
  }

  // Layers switched off in the buyer legend: 0–3 = buyer types, 'repeat' = the repurchase line.
  // Shared by the stacked chart and the visual mix bars; kept while moving between products.
  const buyerHidden = new Set();

  function renderBuyerChart(container, rows) {
    const W = 1000, H = 210, padTop = 14, padBottom = 24, padL = 34, padR = 40;
    const usableW = W - padL - padR, usableH = H - padTop - padBottom;
    const order = [2, 3, 1, 0].filter((k) => !buyerHidden.has(k));   // stack 継続 at the bottom
    const maxV = Math.max(...rows.map((r) => order.reduce((s, k) => s + r.buyers[k], 0)), 1);
    const slot = usableW / rows.length, bw = Math.max(1, slot * 0.72);
    const y = (v) => padTop + usableH - (v / maxV) * usableH;
    const colors = BUYER_KEYS.map((k) => `var(--b-${k})`);
    const bars = rows.map((r, i) => {
      const x = padL + i * slot + (slot - bw) / 2;
      let acc = 0;
      const rects = order.map((k) => {
        const v = r.buyers[k];
        if (!v) return '';
        const y0 = y(acc + v), h = y(acc) - y0;
        acc += v;
        return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[k]}"></rect>`;
      }).join('');
      const nc = newcB(r.buyers);
      const tip = `${r.ymKey}  ` + BUYER_KEYS.map((k, j) => `${t('buyers.' + k)} ${r.buyers[j]}`).join(' / ')
        + (r.buyers[5] != null && nc ? `  ${t('buyers.tipRepeat')} ${fmtPct(r.buyers[5] / nc, 0)}` : '');
      return `<g><title>${escapeHtml(tip)}</title>${rects}<rect x="${(padL + i * slot).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${usableH}" fill="transparent"></rect></g>`;
    }).join('');
    // 新顔の再購入率 on the right axis (0–100%), only where enough newcomers to mean something
    const ry = (v) => padTop + usableH - v * usableH;
    const pts = rows.map((r, i) => {
      const nc = newcB(r.buyers);
      return r.buyers[5] != null && nc >= 5 ? [padL + i * slot + slot / 2, ry(r.buyers[5] / nc)] : null;
    });
    const segs = [];
    let seg = [];
    pts.forEach((pt) => { if (pt) seg.push(pt); else if (seg.length) { segs.push(seg); seg = []; } });
    if (seg.length) segs.push(seg);
    const showLine = !buyerHidden.has('repeat');
    const lines = !showLine ? '' : segs.map((sg) => (sg.length > 1
      ? `<polyline points="${sg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-dasharray="4 3"></polyline>`
      : `<circle cx="${sg[0][0].toFixed(1)}" cy="${sg[0][1].toFixed(1)}" r="2.2" fill="var(--ink)"></circle>`)).join('');
    const xLabels = rows.map((r, i) => ((r.month === 1 || i === 0)
      ? `<text x="${(padL + i * slot + slot / 2).toFixed(1)}" y="${H - 7}" font-size="11" fill="var(--ink-soft)" text-anchor="middle">${r.year}</text>` : '')).join('');
    const axis = `<text x="${padL - 6}" y="${padTop + 9}" font-size="10.5" fill="var(--ink-soft)" text-anchor="end">${fmtInt(maxV)}</text>
      <text x="${padL - 6}" y="${padTop + usableH}" font-size="10.5" fill="var(--ink-soft)" text-anchor="end">0</text>`
      + (showLine ? `<text x="${W - padR + 6}" y="${padTop + 9}" font-size="10.5" fill="var(--ink-soft)">100%</text>
      <text x="${W - padR + 6}" y="${padTop + usableH}" font-size="10.5" fill="var(--ink-soft)">0%</text>` : '');
    container.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="xMidYMid meet">${bars}${lines}${xLabels}${axis}</svg>
      ${buyerLegend(true)}`;
    bindBuyerLegend(container);
  }

  // Clickable legend: each item shows / hides its layer; "only" keeps just that buyer type.
  function buyerLegend(withLine) {
    const item = (key, swatch, label) => `<button type="button" class="legend-btn${buyerHidden.has(key) ? ' is-off' : ''}" data-layer="${key}" aria-pressed="${!buyerHidden.has(key)}">${swatch}${escapeHtml(label)}</button>`;
    return `<div class="buyer-legend">${[2, 3, 1, 0].map((k) => item(k, `<i style="background:var(--b-${BUYER_KEYS[k]})"></i>`, t('buyers.' + BUYER_KEYS[k]))).join('')}`
      + (withLine ? item('repeat', '<i class="legend-line"></i>', t('buyers.legendRepeat')) : '')
      + (buyerHidden.size ? `<button type="button" class="legend-reset">${escapeHtml(t('buyers.legendShowAll'))}</button>` : '')
      + `<span class="legend-hint">${escapeHtml(t('buyers.legendHint'))}</span></div>`;
  }
  function bindBuyerLegend(root) {
    const rerender = () => { if (currentView) renderBuyers(currentView); };
    let pending = null;   // a single click waits briefly so a double-click can replace it
    root.querySelectorAll('.legend-btn').forEach((btn) => {
      const key = btn.dataset.layer === 'repeat' ? 'repeat' : Number(btn.dataset.layer);
      btn.addEventListener('click', () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
          if (buyerHidden.has(key)) buyerHidden.delete(key); else buyerHidden.add(key);
          rerender();
        }, 220);
      });
      // double-click a buyer type: show that type alone
      btn.addEventListener('dblclick', () => {
        clearTimeout(pending);
        if (key === 'repeat') return;
        [0, 1, 2, 3].forEach((k) => (k === key ? buyerHidden.delete(k) : buyerHidden.add(k)));
        rerender();
      });
    });
    const reset = root.querySelector('.legend-reset');
    if (reset) reset.addEventListener('click', () => { buyerHidden.clear(); rerender(); });
  }

  document.querySelectorAll('.buyer-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      buyerRange = btn.dataset.range;
      document.querySelectorAll('.buyer-range-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      if (currentView) renderBuyers(currentView);
    });
  });

  // SKUs inside a series (products.json only). Each SKU row: [ymKey, sales, qty, lines].
  function skuSalesAt(sku, ymKey) {
    const hit = sku.rows.find((r) => r[0] === ymKey);
    return hit ? hit[1] : 0;
  }

  function topSkusFor(record, ymKey, n) {
    const row = record.rows.find((r) => r.ymKey === ymKey);
    const total = row ? row.sales : 0;
    return (record.skus || [])
      .map((s) => ({ s, sales: skuSalesAt(s, ymKey) }))
      .filter((x) => x.sales > 0)
      .sort((a, b) => b.sales - a.sales)
      .slice(0, n)
      .map((x) => ({ name: x.s.name || x.s.code, code: x.s.code, share: total > 0 ? x.sales / total : null }));
  }

  function renderSkuTable(record) {
    const card = document.getElementById('sku-card');
    const skus = record.skus || [];
    card.hidden = skus.length === 0;
    if (!skus.length) return;
    const from12 = shiftYm(record.rows[record.rows.length - 1].ymKey, -11);
    const rows = skus.map((s) => ({
      code: s.code,
      name: s.name,
      active: s.active,
      sales12: s.rows.reduce((sum, r) => (r[0] >= from12 ? sum + r[1] : sum), 0),
      total: s.rows.reduce((sum, r) => sum + r[1], 0),
      last: s.rows.reduce((m, r) => (r[0] > m ? r[0] : m), ''),
      src: s,
    })).sort((a, b) => (b.sales12 - a.sales12) || (b.total - a.total));
    const vis = isVisual();
    const max12 = Math.max(...rows.map((r) => r.sales12), 1);
    const lastYm = record.rows[record.rows.length - 1].ymKey;
    document.querySelector('#sku-table [data-i18n="detail.thSkuTotal"]').textContent = vis ? t('vdet.skuTrend') : t('detail.thSkuTotal');
    document.getElementById('sku-count').textContent = t('detail.skuCount', rows.length, rows.filter((r) => r.active).length);
    const isOn = (code) => !skuSelection || skuSelection.has(code);
    const allBox = document.getElementById('sku-all');
    allBox.checked = !skuSelection;
    allBox.onchange = () => {
      skuSelection = null;
      renderProductDetailContent(currentProduct);
    };
    const tbody = document.querySelector('#sku-table tbody');
    tbody.innerHTML = rows.map((r) => `
      <tr class="${isOn(r.code) ? '' : 'is-off'}">
        <td class="sku-check-cell"><input type="checkbox" data-code="${escapeHtml(r.code)}" ${isOn(r.code) ? 'checked' : ''}></td>
        <td class="mono-cell">${escapeHtml(r.code)} <button type="button" class="sku-only" data-code="${escapeHtml(r.code)}">${escapeHtml(t('sel.only'))}</button></td>
        <td>${escapeHtml(r.name)}${r.active ? '' : ` <span class="class-tag ended-tag">${escapeHtml(t('products.endedTag'))}</span>`}</td>
        <td class="pct-cell">${vis ? cellBar(r.sales12, max12) : (r.sales12 ? fmtYen(r.sales12) : '—')}</td>
        <td class="pct-cell${vis ? ' spark-cell' : ''}">${vis ? sparkline(r.src.rows.map((x) => ({ ymKey: x[0], sales: x[1] })), lastYm, 36, 160, 26) : fmtYen(r.total)}</td>
        <td class="pct-cell">${r.last}</td>
      </tr>`).join('');
    tbody.querySelectorAll('input[data-code]').forEach((cb) => cb.addEventListener('change', () => {
      const sel = new Set(skuSelection || skus.map((s) => s.code));
      if (cb.checked) sel.add(cb.dataset.code); else sel.delete(cb.dataset.code);
      if (!sel.size) { cb.checked = true; return; }
      skuSelection = sel.size === skus.length ? null : sel;
      renderProductDetailContent(currentProduct);
    }));
    tbody.querySelectorAll('.sku-only').forEach((btn) => btn.addEventListener('click', () => {
      skuSelection = skus.length > 1 ? new Set([btn.dataset.code]) : null;
      renderProductDetailContent(currentProduct);
    }));
  }

  // データの信頼性: how much data the verdict rests on, and why it came out as it did.
  function renderReliability(a) {
    const s = a.sufficiency, C = SalesStats.CONFIG;
    const rows = [
      [t('rel.months'), t('rel.monthsVal', s.months, s.excluded)],
      [t('rel.years'), String(s.years)],
      [t('rel.minPerMonth'), t('rel.minPerMonthVal', s.minPerMonth, C.minPerMonth)],
      [t('rel.weight'), fmtPct(a.weight, 0)],
      [t('rel.spikes'), t('rel.spikesVal', a.spikeCount)],
    ];
    const reason = reliabilityReason(a);
    const box = document.getElementById('detail-reliability');
    box.classList.toggle('is-weak', !s.ok);
    box.innerHTML = `
      <h4>${escapeHtml(t('rel.heading'))}</h4>
      <dl class="stat-row">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
      <p class="rel-reason">${escapeHtml(reason)}</p>
    `;
  }

  function reliabilityReason(a) {
    const s = a.sufficiency, C = SalesStats.CONFIG;
    let reason;
    if (!s.ok) reason = t('rel.reasonInsufficient', C.minMonths, C.minPerMonth);
    else if (a.test.p == null) reason = t('rel.reasonNoTest');
    else if (a.test.p < C.alpha) reason = t('rel.reasonSeasonal', fmtP(a.test.p), fmtOmega(a));
    else reason = t('rel.reasonNotSeasonal', fmtP(a.test.p));
    if (a.spiky && s.ok) reason += ' ' + t('rel.reasonSpiky', a.spikeCount, s.years);
    return reason;
  }

  let seasonAnalysis = null;
  function renderSeasonalBars(a) {
    seasonAnalysis = a;
    const wrap = document.getElementById('seasonal-bars');
    const note = document.getElementById('seasonal-note');
    wrap.innerHTML = '';
    note.textContent = !a.sufficiency.ok
      ? t('detail.seasonalTentative', fmtPct(a.weight, 0))
      : (seasonMode === 'relative' ? t('detail.seasonalRelativeNote') : t('detail.seasonalBandNote'));
    note.classList.toggle('is-weak', !a.sufficiency.ok);
    const rel = seasonMode === 'relative';
    const top = (s) => (rel ? s.relative * (s.hi != null ? s.hi / s.index : 1) : (s.hi ?? s.index));
    const maxIdx = Math.max(...a.seasonal.map((s) => top(s) || 0), 1);
    a.seasonal.forEach((s) => {
      const v = seasonValue(s);
      const scale = rel ? s.relative / s.index : 1;
      const col = document.createElement('div');
      col.className = 'season-col' + (s.n === 0 ? ' is-empty' : '');
      const heightPct = Math.max(4, (v / maxIdx) * 100);
      const cls = v >= 1 ? 'above' : 'below';
      const band = s.lo != null
        ? `<div class="season-band" style="bottom:${(s.lo * scale / maxIdx) * 100}%;height:${((s.hi - s.lo) * scale / maxIdx) * 100}%"></div>`
        : '';
      const tip = t('detail.seasonTip', fmtPct(v, 0), s.lo != null ? fmtPct(s.lo * scale, 0) : '—',
        s.hi != null ? fmtPct(s.hi * scale, 0) : '—', s.n, fmtPct(s.weight, 0));
      col.title = tip;
      col.innerHTML = `
        <span class="season-val">${fmtPct(v, 0)}</span>
        <div class="season-bar-track"><div class="season-bar ${cls}" style="height:${heightPct}%"></div>${band}</div>
        <span class="season-label">${monthLabel(s.month)}</span>
      `;
      wrap.appendChild(col);
    });
  }

  function setSeasonMode(mode) {
    seasonMode = mode;
    document.querySelectorAll('.season-mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
  }
  document.querySelectorAll('.season-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSeasonMode(btn.dataset.mode);
      if (seasonAnalysis && document.getElementById('view-detail').classList.contains('is-active')) renderSeasonalBars(seasonAnalysis);
      if (document.getElementById('view-calendar').classList.contains('is-active')) renderCalendar();
    });
  });

  // Compact currency for cramped bar labels — abbreviates in both locales
  // instead of falling back to full-precision yen (which is what was
  // crowding/overlapping in English, where 万円 doesn't apply).
  function fmtCompactYen(n) {
    if (I18N.getLang() === 'en') {
      if (Math.abs(n) >= 1000000) return '¥' + (n / 1000000).toFixed(2) + 'M';
      if (Math.abs(n) >= 1000) return '¥' + Math.round(n / 1000) + 'K';
      return fmtYen(n);
    }
    if (Math.abs(n) < 10000) return fmtYen(n);
    const man = n / 10000;
    return (man >= 100 ? Math.round(man) : man.toFixed(1)) + '万円';
  }

  let trendMode = 'all';
  let trendYear = null;
  let trendProductName = null;

  function initTrendSection(rows, productName) {
    const isNewProduct = productName !== trendProductName;
    trendProductName = productName;

    if (isNewProduct) {
      trendMode = 'all';
      document.querySelectorAll('.trend-controls .trend-mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === 'all'));
    }

    const years = Array.from(new Set(rows.map((r) => r.year))).sort((a, b) => a - b);
    const yearSelect = document.getElementById('trend-year-select');
    yearSelect.innerHTML = years.map((y) => `<option value="${y}">${t('detail.yearOption', y)}</option>`).join('');
    if (isNewProduct || trendYear == null || !years.includes(trendYear)) trendYear = years[years.length - 1];
    yearSelect.value = trendYear;
    yearSelect.hidden = trendMode !== 'year';

    renderTrendChart(rows);
  }

  document.querySelectorAll('.trend-controls .trend-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      trendMode = btn.dataset.mode;
      document.querySelectorAll('.trend-controls .trend-mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.getElementById('trend-year-select').hidden = trendMode !== 'year';
      if (currentView) renderTrendChart(currentView.rows);
    });
  });

  document.getElementById('trend-year-select').addEventListener('change', (e) => {
    trendYear = Number(e.target.value);
    if (currentView) renderTrendChart(currentView.rows);
  });

  function renderTrendChart(rows) {
    const container = document.getElementById('trend-chart');
    container.innerHTML = '';
    if (trendMode === 'all') renderTrendAll(container, rows);
    else renderTrendYear(container, rows, trendYear);
  }

  function renderTrendAll(container, rows) {
    const W = 1000, H = 220, padTop = 18, padBottom = 26, padX = 6;
    const usableW = W - padX * 2;
    const usableH = H - padTop - padBottom;
    const values = rows.map((r) => r.sales);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const range = (maxV - minV) || 1;
    const n = rows.length;

    const points = rows.map((r, i) => ({
      x: padX + (n <= 1 ? 0 : (i / (n - 1)) * usableW),
      y: padTop + usableH - ((r.sales - minV) / range) * usableH,
      r,
    }));

    const linePts = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `M${points[0].x.toFixed(1)},${(padTop + usableH).toFixed(1)} L${linePts.split(' ').join(' L')} L${points[points.length - 1].x.toFixed(1)},${(padTop + usableH).toFixed(1)} Z`;

    const xLabels = points
      .filter((p, i) => p.r.month === 1 || i === 0)
      .map((p) => `<text x="${p.x.toFixed(1)}" y="${H - 8}" font-size="11" fill="var(--ink-soft)" text-anchor="middle">${p.r.year}</text>`)
      .join('');

    const circles = n <= 36
      ? points.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="var(--seasonal)"></circle>`).join('')
      : '';

    container.innerHTML = `
      <div class="trend-range-labels">
        <span>${t('detail.trendHigh')}: ${fmtYen(maxV)}</span>
        <span>${t('detail.trendLow')}: ${fmtYen(minV)}</span>
      </div>
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="xMidYMid meet">
        <path d="${areaPath}" fill="var(--seasonal-bg)"></path>
        <polyline points="${linePts}" fill="none" stroke="var(--seasonal)" stroke-width="2.5"></polyline>
        ${circles}
        ${xLabels}
      </svg>
    `;
  }

  function renderTrendYear(container, rows, year) {
    const byMonth = {};
    rows.filter((r) => r.year === year).forEach((r) => { byMonth[r.month] = r.sales; });
    const vals = Object.values(byMonth);
    const maxV = Math.max(...vals, 1);

    const wrap = document.createElement('div');
    wrap.className = 'trend-year-bars';
    for (let m = 1; m <= 12; m++) {
      const v = byMonth[m];
      const heightPct = v != null ? Math.max(3, (v / maxV) * 100) : 2;
      const col = document.createElement('div');
      col.className = 'trend-year-col';
      col.innerHTML = `
        <div class="trend-year-track">
          <div class="trend-year-bar" style="height:${heightPct}%">
            <span class="trend-year-val">${v != null ? fmtCompactYen(v) : '—'}</span>
          </div>
        </div>
        <span class="trend-year-label">${monthLabel(m)}</span>
      `;
      wrap.appendChild(col);
    }
    container.appendChild(wrap);
  }

  function renderYoyTable(yoy) {
    const tbody = document.querySelector('#yoy-table tbody');
    tbody.innerHTML = '';
    yoy.forEach((y) => {
      const tr = document.createElement('tr');
      const yoyCell = y.yoy == null ? '—'
        : `<span class="${y.yoy >= 0 ? 'up' : 'down'}" title="${escapeHtml(t('detail.yoyCompared', y.compared))}">${fmtSignedPct(y.yoy)}</span>`
          + (y.compared < 12 ? ` <span class="muted-small">${escapeHtml(t('detail.yoyComparedShort', y.compared))}</span>` : '');
      const yearCell = y.partial ? `${y.year} <span class="muted-small">${escapeHtml(t('detail.partialYear', y.n))}</span>` : String(y.year);
      tr.innerHTML = `<td>${yearCell}</td><td>${fmtYen(y.avg)}</td><td>${yoyCell}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderSpikeList(elId, items, withFactor, withNotes) {
    const list = document.getElementById(elId);
    list.innerHTML = '';
    const viewRows = currentView ? currentView.rows : [];
    const vis = isVisual();
    items.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'spike-item';
      li.dataset.ym = r.ymKey;
      const driver = withFactor ? buyerDriver(viewRows, r) : null;

      const main = document.createElement('div');
      main.className = 'spike-item-main';
      main.innerHTML = `
        <div>
          <div class="ym">${vis ? (withFactor ? `<span class="spike-no">${i + 1}</span>` : '<span class="dip-no">▼</span>') : ''}${r.ymKey}</div>
          ${withFactor && !driver ? `<div class="factor">${escapeHtml(factorLabel(r.factorKey))}</div>` : ''}
        </div>
        <div class="ratio ${r.ratio >= 1 ? 'up' : 'down'}">${fmtPct(r.ratio, 0)}</div>
      `;
      li.appendChild(main);

      if (driver) li.appendChild(vis ? buyerDriverViz(driver) : buyerDriverEl(driver));

      if (withFactor && currentView && currentView.skus && currentView.skus.length > 1) {
        const drivers = topSkusFor(currentView, r.ymKey, 3);
        if (drivers.length && vis) {
          li.appendChild(skuShareViz(drivers));
        } else if (drivers.length) {
          const p = document.createElement('p');
          p.className = 'spike-skus';
          p.textContent = t('detail.spikeSkus') + ' ' + drivers
            .map((d) => d.name + (d.share != null ? ` (${fmtPct(d.share, 0)})` : ''))
            .join(' · ');
          li.appendChild(p);
        }
      }

      if (withNotes) {
        li.appendChild(buildNoteSection(r.ymKey));
      }

      list.appendChild(li);
    });
  }

  function buildNoteSection(ymKey) {
    const wrap = document.createElement('div');
    wrap.className = 'spike-note';
    const existingNote = (currentProduct.notes && currentProduct.notes[ymKey]) || '';
    renderNoteView(wrap, ymKey, existingNote);
    return wrap;
  }

  function renderNoteView(wrap, ymKey, note) {
    wrap.innerHTML = '';
    if (note) {
      const p = document.createElement('p');
      p.className = 'spike-note-text';
      p.textContent = note;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'spike-note-toggle';
      editBtn.textContent = t('detail.editNote');
      editBtn.addEventListener('click', () => renderNoteEdit(wrap, ymKey, note));
      wrap.appendChild(p);
      wrap.appendChild(editBtn);
    } else {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'spike-note-toggle';
      addBtn.textContent = t('detail.addNote');
      addBtn.addEventListener('click', () => renderNoteEdit(wrap, ymKey, ''));
      wrap.appendChild(addBtn);
    }
  }

  function renderNoteEdit(wrap, ymKey, note) {
    wrap.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'spike-note-edit-row';

    const textarea = document.createElement('textarea');
    textarea.className = 'spike-note-textarea';
    textarea.placeholder = t('detail.notePlaceholder');
    textarea.value = note;

    const actions = document.createElement('div');
    actions.className = 'spike-note-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'spike-note-save';
    saveBtn.textContent = t('detail.save');
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'spike-note-cancel';
    cancelBtn.textContent = t('detail.cancel');

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = t('detail.saving');
      const value = textarea.value.trim();
      const updated = await SalesDB.setNote(currentProduct.name, ymKey, value);
      if (updated) currentProduct.notes = updated.notes;
      renderNoteView(wrap, ymKey, value);
    });
    cancelBtn.addEventListener('click', () => renderNoteView(wrap, ymKey, note));

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    row.appendChild(textarea);
    row.appendChild(actions);
    wrap.appendChild(row);
    textarea.focus();
  }

  function renderRawTable(rows) {
    const tbody = document.querySelector('#raw-table tbody');
    tbody.innerHTML = '';
    [...rows].reverse().forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.ymKey}</td><td>${fmtYen(r.sales)}</td><td>${r.qty != null ? fmtInt(r.qty) : '—'}</td>
        <td>${r.orderCount != null ? fmtInt(r.orderCount) : '—'}</td><td>${r.orders != null ? fmtInt(r.orders) : '—'}</td><td>${r.totalCustomers != null ? fmtInt(r.totalCustomers) : '—'}</td>
        <td>${r.newCustomers != null ? fmtInt(r.newCustomers) : '—'}</td><td>${r.existingCustomers != null ? fmtInt(r.existingCustomers) : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.getElementById('print-detail').addEventListener('click', () => {
    window.print();
  });

  document.getElementById('delete-product').addEventListener('click', async () => {
    if (!currentProduct) return;
    if (!confirm(t('detail.deleteConfirm', currentProduct.name))) return;
    await SalesDB.remove(currentProduct.name);
    currentProduct = null;
    showView('products');
    renderProductsList();
  });

  // ---------------- notes (cross-product) ----------------
  let notesSearch = '';
  let notesSortKey = 'ym';
  let notesSortDir = -1;
  let notesMode = 'list';

  async function renderNotesView() {
    const products = await loadAll();
    const tbody = document.querySelector('#notes-table tbody');
    const calGrid = document.getElementById('notes-calendar-grid');
    const empty = document.getElementById('notes-empty');
    const noResults = document.getElementById('notes-no-results');
    const countEl = document.getElementById('notes-count');
    tbody.innerHTML = '';
    calGrid.innerHTML = '';

    const allNotes = [];
    ensureContext(products);
    products.forEach((p) => {
      if (!p.notes || Object.keys(p.notes).length === 0) return;
      const analysis = analysisOf(p);
      const byYm = {};
      analysis.rowsWithRatio.forEach((r) => { byYm[r.ymKey] = r; });
      Object.entries(p.notes).forEach(([ymKey, note]) => {
        const row = byYm[ymKey];
        allNotes.push({
          productName: p.name,
          ymKey,
          note,
          ratio: row ? row.ratio : null,
        });
      });
    });

    if (allNotes.length === 0) {
      empty.hidden = false;
      noResults.hidden = true;
      countEl.textContent = '';
      return;
    }
    empty.hidden = true;

    const q = notesSearch.toLowerCase();
    const filtered = notesSearch
      ? allNotes.filter((n) => n.productName.toLowerCase().includes(q) || n.note.toLowerCase().includes(q))
      : allNotes;

    countEl.textContent = t('notes.count', filtered.length, allNotes.length);
    noResults.hidden = filtered.length > 0;

    if (notesMode === 'list') {
      const sorted = [...filtered].sort((a, b) => {
        let av, bv;
        switch (notesSortKey) {
          case 'product': av = a.productName; bv = b.productName; break;
          case 'ratio': av = a.ratio ?? -Infinity; bv = b.ratio ?? -Infinity; break;
          default: av = a.ymKey; bv = b.ymKey;
        }
        if (typeof av === 'string') return notesSortDir * av.localeCompare(bv, 'ja');
        return notesSortDir * (av - bv);
      });
      sorted.forEach((n) => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.innerHTML = `
          <td class="name-cell">${escapeHtml(n.productName)}</td>
          <td class="pct-cell">${n.ymKey}</td>
          <td class="note-cell">${escapeHtml(n.note)}</td>
          <td class="pct-cell">${n.ratio != null ? fmtPct(n.ratio, 0) : '—'}</td>
        `;
        tr.addEventListener('click', () => openProductDetail(n.productName));
        tbody.appendChild(tr);
      });
    } else {
      renderNotesCalendarGrid(calGrid, filtered);
    }
  }

  // Groups notes by calendar month (ignoring year) so recurring events —
  // a campaign that touches several products every October, say — become
  // visible even though nothing in the flat list view would surface that.
  function renderNotesCalendarGrid(grid, notes) {
    const byMonth = {};
    for (let m = 1; m <= 12; m++) byMonth[m] = [];
    notes.forEach((n) => {
      const month = Number(n.ymKey.split('-')[1]);
      byMonth[month].push(n);
    });

    for (let m = 1; m <= 12; m++) {
      const entries = [...byMonth[m]].sort((a, b) => b.ymKey.localeCompare(a.ymKey));
      const distinctProducts = new Set(entries.map((e) => e.productName)).size;
      const card = document.createElement('div');
      card.className = 'card notes-month-card' + (distinctProducts >= 2 ? ' has-cross-product' : '');

      const entriesHtml = entries.length
        ? entries.map((e) => `
            <li>
              <div class="nmc-meta">
                <span class="nmc-product">${escapeHtml(e.productName)}</span>
                <span class="nmc-year">${escapeHtml(e.ymKey.split('-')[0])}</span>
              </div>
              <p class="nmc-note">${escapeHtml(e.note)}</p>
            </li>
          `).join('')
        : `<li class="nmc-empty">${escapeHtml(t('notesCal.noEntries'))}</li>`;

      card.innerHTML = `
        <div class="nmc-header">
          <h4>${monthLabel(m)}</h4>
          ${distinctProducts >= 2 ? `<span class="nmc-badge">${escapeHtml(t('notesCal.productCount', distinctProducts))}</span>` : ''}
        </div>
        <ul class="nmc-list">${entriesHtml}</ul>
      `;
      card.querySelectorAll('li:not(.nmc-empty)').forEach((li, i) => {
        li.style.cursor = 'pointer';
        li.addEventListener('click', () => openProductDetail(entries[i].productName));
      });
      grid.appendChild(card);
    }
  }

  document.querySelectorAll('.notes-mode-group .trend-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      notesMode = btn.dataset.mode;
      document.querySelectorAll('.notes-mode-group .trend-mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.getElementById('notes-list-mode').hidden = notesMode !== 'list';
      document.getElementById('notes-calendar-mode').hidden = notesMode !== 'calendar';
      renderNotesView();
    });
  });

  document.getElementById('notes-search').addEventListener('input', (e) => {
    notesSearch = e.target.value.trim();
    renderNotesView();
  });

  document.querySelectorAll('#notes-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (notesSortKey === key) notesSortDir *= -1;
      else { notesSortKey = key; notesSortDir = key === 'ym' ? -1 : 1; }
      renderNotesView();
    });
  });

  // ---------------- calendar ----------------
  async function renderCalendar() {
    const products = await loadAll();
    const empty = document.getElementById('calendar-empty');
    const noResults = document.getElementById('calendar-no-results');
    const countEl = document.getElementById('calendar-count');
    const tbody = document.querySelector('#calendar-table tbody');
    tbody.innerHTML = '';

    const scopeBar = document.getElementById('calendar-scope');
    if (products.length === 0) {
      empty.hidden = false;
      noResults.hidden = true;
      countEl.textContent = '';
      scopeBar.innerHTML = '';
      updateCalendarSortIndicators();
      return;
    }
    empty.hidden = true;
    renderScopeBar(scopeBar, products, renderCalendar);
    ensureContext(products);

    const from12 = shiftYm(latestYm(products), -11);
    const computed = products.filter(inScope).filter(inPeriod).map((p) => {
      const analysis = analysisOf(p);
      const peak = analysis.seasonal.reduce((a, b) => (seasonValue(b) > seasonValue(a) ? b : a));
      return {
        name: p.name,
        growth: growthOf(p.rows, from12),
        seasonal: analysis.seasonal,
        classification: analysis.classification,
        tentative: !analysis.sufficiency.ok,
        eta2: omegaOf(analysis) ?? -1,
        eta2Text: fmtOmega(analysis),
        peakMonth: peak.month,
      };
    });

    const filtered = applyCalendarFilters(computed);
    sortCalendarRows(filtered);

    countEl.textContent = t('calendar.count', filtered.length, products.length) + periodNote() + channelNote();
    noResults.hidden = filtered.length > 0;
    filtered.forEach((c) => tbody.appendChild(buildCalendarRow(c)));
    updateCalendarSortIndicators();
    // the visual view has its own 判定 chips, so only the name filter carries over
    if (isVisual()) renderCalendarVisual(computed.filter((c) => !calendarColumnFilters.name || calendarColumnFilters.name.has(c.name)));
  }

  function calHeaderLabel(key) {
    if (key === 'name') return t('calendar.thName');
    if (key === 'class') return t('calendar.thClass');
    if (key === 'eta2') return t('calendar.thEta2');
    if (key.startsWith('m')) return monthLabel(key.slice(1));
    return '';
  }

  function updateCalendarSortIndicators() {
    document.querySelectorAll('#calendar-table th[data-sort]').forEach((th) => {
      const key = th.dataset.sort;
      const base = calHeaderLabel(key);
      const arrow = calendarSortKey === key ? (calendarSortDir === 1 ? ' ▲' : ' ▼') : '';
      const labelSpan = th.querySelector('.th-label');
      if (labelSpan) labelSpan.textContent = base + arrow;
      else th.textContent = base + arrow;
    });
  }

  function applyCalendarFilters(rows) {
    return rows.filter((r) => {
      if (calendarColumnFilters.name && !calendarColumnFilters.name.has(r.name)) return false;
      if (calendarColumnFilters.class && !calendarColumnFilters.class.has(r.classification.key)) return false;
      return true;
    });
  }

  function sortCalendarRows(rows) {
    rows.sort((a, b) => {
      let av, bv;
      if (calendarSortKey === 'name') { av = a.name; bv = b.name; return calendarSortDir * av.localeCompare(bv, 'ja'); }
      if (calendarSortKey === 'eta2') { av = a.eta2; bv = b.eta2; }
      else if (calendarSortKey === 'class') { av = clsLabel(a.classification.key); bv = clsLabel(b.classification.key); return calendarSortDir * av.localeCompare(bv, 'ja'); }
      else {
        const idx = parseInt(calendarSortKey.replace('m', ''), 10) - 1;
        av = seasonValue(a.seasonal[idx]);
        bv = seasonValue(b.seasonal[idx]);
      }
      return calendarSortDir * (av - bv);
    });
  }

  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  function mixHex(hexA, hexB, t) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    const rgb = a.map((v, i) => Math.round(v + (b[i] - v) * t));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // Continuous heatmap centered on 100% (that month = the year's average).
  // Below 100% shades toward red, above shades toward green; saturation
  // grows with distance from the midpoint so it reads clearly even on a
  // light background, and text flips to white once the fill gets dark.
  // Color is never the ONLY signal: a ▲/▼ symbol carries the same
  // above/below-average distinction so the calendar still reads correctly
  // for red-green color blindness.
  const HEAT_LOW = '#B4483C';   // strong red, below-average months
  const HEAT_HIGH = '#1F7A5C';  // strong green, above-average months
  function heatBg(index) {
    if (index == null) return null;
    const k = Math.max(-1, Math.min(1, (index - 1) / 0.5)); // ±50% = full saturation
    if (Math.abs(k) < 0.04) return null; // essentially 100%, leave neutral
    return k < 0 ? mixHex('#FFFFFF', HEAT_LOW, -k) : mixHex('#FFFFFF', HEAT_HIGH, k);
  }

  function pctColor(index) {
    const bg = heatBg(index);
    if (!bg) return index == null ? '' : 'style="color:var(--ink);"';
    const textColor = Math.abs((index - 1) / 0.5) > 0.55 ? '#FFFFFF' : 'var(--ink)';
    return `style="background:${bg}; color:${textColor}; font-weight:700;"`;
  }

  function pctSymbol(index) {
    if (index == null) return '';
    const t = (index - 1) / 0.5;
    if (Math.abs(t) < 0.04) return '';
    return t > 0 ? ' ▲' : ' ▼';
  }

  function buildCalendarRow(c) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    if (c.tentative) {
      tr.classList.add('is-tentative');
      tr.title = t('calendar.tentativeTitle');
    }
    const monthCells = c.seasonal.map((s) => {
      const v = seasonValue(s);
      const peakMark = s.month === c.peakMonth ? ' ★' : '';
      // tentative rows: neutral cells, the shrunk value is shown as text only
      const style = c.tentative ? '' : pctColor(v);
      return `<td class="pct-cell" ${style}>${fmtPct(v, 0) + pctSymbol(v) + peakMark}</td>`;
    }).join('');
    tr.innerHTML = `
      <td class="name-cell">${escapeHtml(c.name)}${c.tentative ? ` <span class="class-tag ended-tag">${escapeHtml(t('calendar.tentativeTag'))}</span>` : ''}</td>
      ${monthCells}
      <td><span class="class-tag" style="background:var(--${c.classification.key}-bg); color:var(--${c.classification.key});">${escapeHtml(clsLabel(c.classification.key))}</span></td>
      <td class="pct-cell">${c.eta2Text}</td>
    `;
    tr.addEventListener('click', () => openProductDetail(c.name));
    return tr;
  }

  document.querySelectorAll('#calendar-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (calendarSortKey === key) calendarSortDir *= -1;
      else { calendarSortKey = key; calendarSortDir = -1; }
      renderCalendar();
    });
  });

  // ---- calendar header filters (Excel-style dropdown) ----
  function closePopover() {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
      document.removeEventListener('mousedown', onOutsideClick);
    }
  }

  function onOutsideClick(e) {
    if (openPopover && !openPopover.contains(e.target) && !e.target.closest('.th-filter-btn')) {
      closePopover();
    }
  }

  async function openColumnFilter(colKey, buttonEl) {
    if (openPopover) { closePopover(); return; }

    const products = (await loadAll()).filter(inScope).filter(inPeriod);
    let valueList; // [{ value, label }]
    if (colKey === 'name') {
      valueList = products.map((p) => ({ value: p.name, label: p.name })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
    } else {
      const seen = new Map();
      ensureContext(await loadAll());
      products.forEach((p) => {
        const a = analysisOf(p);
        seen.set(a.classification.key, clsLabel(a.classification.key));
      });
      valueList = Array.from(seen, ([value, label]) => ({ value, label }));
    }

    const activeSet = calendarColumnFilters[colKey]; // null = all shown/checked
    const pop = document.createElement('div');
    pop.className = 'col-filter-popover';

    const searchHtml = colKey === 'name' ? `<input type="text" class="col-filter-search" placeholder="${escapeHtml(t('calendar.filterSearchPlaceholder'))}" />` : '';
    pop.innerHTML = `
      ${searchHtml}
      <div class="col-filter-actions">
        <button type="button" data-act="all">${escapeHtml(t('calendar.filterAll'))}</button>
        <button type="button" data-act="none">${escapeHtml(t('calendar.filterNone'))}</button>
      </div>
      <div class="col-filter-list">
        ${valueList.map((v) => `
          <label>
            <input type="checkbox" value="${escapeHtml(v.value)}" ${!activeSet || activeSet.has(v.value) ? 'checked' : ''} />
            <span>${escapeHtml(v.label)}</span>
          </label>
        `).join('')}
      </div>
    `;

    document.body.appendChild(pop);
    const rect = buttonEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = rect.left;
    if (left + popRect.width > window.innerWidth - 10) left = window.innerWidth - popRect.width - 10;
    pop.style.position = 'fixed';
    pop.style.top = (rect.bottom + 4) + 'px';
    pop.style.left = Math.max(10, left) + 'px';

    openPopover = pop;
    setTimeout(() => document.addEventListener('mousedown', onOutsideClick), 0);

    function applyFromCheckboxes() {
      const boxes = Array.from(pop.querySelectorAll('input[type="checkbox"]'));
      const checked = boxes.filter((b) => b.checked).map((b) => b.value);
      calendarColumnFilters[colKey] = checked.length === boxes.length ? null : new Set(checked);
      buttonEl.classList.toggle('is-filtered', calendarColumnFilters[colKey] !== null);
      renderCalendar();
    }

    pop.querySelectorAll('input[type="checkbox"]').forEach((box) => {
      box.addEventListener('change', applyFromCheckboxes);
    });
    pop.querySelector('[data-act="all"]').addEventListener('click', () => {
      pop.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = true; });
      applyFromCheckboxes();
    });
    pop.querySelector('[data-act="none"]').addEventListener('click', () => {
      pop.querySelectorAll('input[type="checkbox"]').forEach((b) => { b.checked = false; });
      applyFromCheckboxes();
    });
    const searchBox = pop.querySelector('.col-filter-search');
    if (searchBox) {
      searchBox.addEventListener('input', () => {
        const q = searchBox.value.toLowerCase();
        pop.querySelectorAll('.col-filter-list label').forEach((label) => {
          const text = label.textContent.toLowerCase();
          label.style.display = text.includes(q) ? '' : 'none';
        });
      });
      searchBox.focus();
    }
  }

  document.querySelectorAll('.th-filter-btn').forEach((btn) => {
    btn.classList.toggle('is-filtered', calendarColumnFilters[btn.dataset.filterCol] !== null);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColumnFilter(btn.dataset.filterCol, btn);
    });
  });

  // ---------------- display mode: 数値 / ビジュアル ----------------
  // Visual mode swaps tables and number lists for charts. Both read the same analysis;
  // the visual pieces are only built while visual mode is on.
  const DISPLAY_KEY = 'thd-sales-ledger-display';
  let displayMode = (() => {
    try { return localStorage.getItem(DISPLAY_KEY) === 'visual' ? 'visual' : 'numbers'; } catch (e) { return 'numbers'; }
  })();
  function isVisual() { return displayMode === 'visual'; }
  function applyDisplayMode() {
    document.body.classList.toggle('is-visual', isVisual());
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.display === displayMode));
  }
  applyDisplayMode();
  document.querySelectorAll('.mode-btn').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.display === displayMode) return;
    displayMode = btn.dataset.display;
    try { localStorage.setItem(DISPLAY_KEY, displayMode); } catch (e) { /* ignore */ }
    applyDisplayMode();
    rerenderActive();
  }));
  function rerenderActive() {
    const active = document.querySelector('.view.is-active').id;
    if (active === 'view-products') renderProductsList();
    else if (active === 'view-calendar') renderCalendar();
    else if (active === 'view-momentum') renderMomentum();
    else if (active === 'view-channels') renderChannelsTab();
    else if (active === 'view-detail' && currentProduct) {
      loadOne(currentProduct.name).then((rec) => { if (rec) { currentProduct = rec; renderProductDetailContent(rec); } });
    }
  }

  function applyPeriod() {
    document.querySelectorAll('.period-btn').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.period) === period));
  }
  applyPeriod();
  document.querySelectorAll('.period-btn').forEach((btn) => btn.addEventListener('click', () => {
    const v = Number(btn.dataset.period);
    if (v === period) return;
    period = v;
    try { localStorage.setItem(PERIOD_KEY, String(period)); } catch (e) { /* ignore */ }
    applyPeriod();
    rerenderActive();
  }));

  // Last 12 月度 against the 12 before; null when there were no sales a year earlier.
  function growthOf(rows, from12) {
    const cur = sumSince(rows, from12);
    const prev = sumSince(rows, shiftYm(from12, -12)) - cur;
    return prev > 0 ? cur / prev - 1 : null;
  }
  function growthChip(g, tip = t('viz.growthTip')) {
    if (g == null) return `<span class="g-chip" title="${escapeHtml(t('vprod.noPrev'))}">—</span>`;
    const cls = g >= 0.1 ? ' is-up' : (g <= -0.1 ? ' is-down' : '');
    return `<span class="g-chip${cls}" title="${escapeHtml(tip)}">${g >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(g), 0)}</span>`;
  }
  function cellBar(v, max) {
    return `<span class="cell-bar"><i style="width:${(Math.max(0, v) / max * 100).toFixed(1)}%"></i><em>${v ? fmtCompactYen(v) : '—'}</em></span>`;
  }
  function seasonStrip(seasonal, tentative) {
    return `<span class="season-strip${tentative ? ' is-tentative' : ''}">${seasonal.map((s) => {
      const v = seasonValue(s);
      const bg = tentative ? null : heatBg(v);
      return `<i style="background:${bg || 'var(--line-soft)'}" title="${escapeHtml(monthLabel(s.month) + ' ' + fmtPct(v, 0))}"></i>`;
    }).join('')}</span>`;
  }

  // Sales for the `months` 月度 ending at lastYm (missing = 0); the last 12 are drawn in colour.
  function sparkline(rows, lastYm, months, w, h) {
    const from = shiftYm(lastYm, -(months - 1));
    const by = new Map(rows.map((r) => [r.ymKey, r.sales]));
    const vals = Array.from({ length: months }, (_, i) => Math.max(0, by.get(shiftYm(from, i)) || 0));
    const max = Math.max(...vals, 1);
    const pt = (v, i) => `${((i / (months - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`;
    const cut = Math.max(0, months - 12);
    const xCut = (cut / (months - 1)) * w;
    const older = vals.slice(0, cut + 1).map((v, i) => pt(v, i)).join(' ');
    const recent = vals.slice(cut).map((v, i) => pt(v, i + cut)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" height="${h}">
      <rect x="${xCut.toFixed(1)}" y="0" width="${(w - xCut).toFixed(1)}" height="${h}" fill="var(--seasonal-bg)"></rect>
      <polyline points="${older}" fill="none" stroke="var(--ink-soft)" stroke-width="1.2" vector-effect="non-scaling-stroke"></polyline>
      <polyline points="${recent}" fill="none" stroke="var(--seasonal)" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
    </svg>`;
  }

  // ---- products: map + tiles ----
  function renderProductsVisual(items, lastYm) {
    renderProductMap(document.getElementById('products-map'), items);
    const tiles = document.getElementById('products-tiles');
    tiles.innerHTML = items.map((p) => `
      <div class="tile" role="button" tabindex="0" data-name="${escapeHtml(p.name)}">
        <div class="tile-head">
          <span class="tile-name">${escapeHtml(p.name)}</span>
          <span class="class-tag" style="background:var(--${p.classification.key}-bg); color:var(--${p.classification.key});">${escapeHtml(clsLabel(p.classification.key))}</span>
        </div>
        <div class="tile-nums"><b>${p.sales12 ? fmtCompactYen(p.sales12) : '—'}</b>${growthChip(p.growth)}${p.active ? '' : `<span class="class-tag ended-tag">${escapeHtml(t('products.endedTag'))}</span>`}</div>
        ${sparkline(p.rows, lastYm, 36, 240, 38)}
        ${seasonStrip(p.seasonal, p.tentative)}
      </div>`).join('');
    tiles.querySelectorAll('.tile').forEach((el) => {
      el.addEventListener('click', () => openProductDetail(el.dataset.name));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openProductDetail(el.dataset.name); });
    });
  }

  // Round powers of ten for a log axis: ¥1,000 / 1万円 / 1億円 (¥1K / ¥1M in English).
  function axisYen(n) {
    if (I18N.getLang() === 'en') return n >= 1e6 ? '¥' + n / 1e6 + 'M' : (n >= 1e3 ? '¥' + n / 1e3 + 'K' : '¥' + n);
    return n >= 1e8 ? n / 1e8 + '億円' : (n >= 1e4 ? n / 1e4 + '万円' : '¥' + n.toLocaleString('ja-JP'));
  }

  // x = last-12 sales (log), y = last 12 ÷ the 12 before (log2, clipped at ¼× and 4×).
  function renderProductMap(container, items) {
    const legend = document.getElementById('products-map-legend');
    const pts = items.filter((p) => p.sales12 > 0);
    if (!pts.length) { container.innerHTML = ''; legend.innerHTML = ''; return; }
    const W = 1000, H = 430, padL = 58, padR = 16, padT = 14, padB = 30;
    const lx = pts.map((p) => Math.log10(p.sales12));
    const x0 = Math.floor(Math.min(...lx)), x1 = Math.max(x0 + 1, Math.ceil(Math.max(...lx)));
    const X = (v) => padL + ((Math.log10(v) - x0) / (x1 - x0)) * (W - padL - padR);
    const G = 2;
    const lg = (g) => (g == null ? G : Math.max(-G, Math.min(G, Math.log2(Math.max(1e-9, 1 + g)))));
    const Y = (l) => padT + ((G - l) / (2 * G)) * (H - padT - padB);
    let grid = '';
    for (let k = x0; k <= x1; k++) {
      const x = X(10 ** k).toFixed(1);
      grid += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H - padB}" stroke="var(--line-soft)"></line>
        <text x="${x}" y="${H - 10}" font-size="11" fill="var(--ink-soft)" text-anchor="middle">${axisYen(10 ** k)}</text>`;
    }
    [-2, -1, 0, 1, 2].forEach((l) => {
      const y = Y(l).toFixed(1);
      grid += `<line x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}" stroke="${l === 0 ? 'var(--ink-soft)' : 'var(--line)'}"${l === 0 ? '' : ' stroke-dasharray="3 3"'}></line>
        <text x="${padL - 6}" y="${(+y + 4).toFixed(1)}" font-size="11" fill="var(--ink-soft)" text-anchor="end">${l === 0 ? '±0%' : fmtSignedPct(2 ** l - 1, 0)}</text>`;
    });
    const zones = `<rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${(Y(0) - padT).toFixed(1)}" fill="var(--seasonal-bg)" opacity="0.6"></rect>
      <rect x="${padL}" y="${Y(0).toFixed(1)}" width="${W - padL - padR}" height="${(H - padB - Y(0)).toFixed(1)}" fill="#FBEDEB" opacity="0.6"></rect>
      <text x="${padL + 8}" y="${padT + 15}" font-size="12" font-weight="700" fill="var(--seasonal)">${escapeHtml(t('vprod.up'))}</text>
      <text x="${padL + 8}" y="${H - padB - 8}" font-size="12" font-weight="700" fill="var(--danger)">${escapeHtml(t('vprod.down'))}</text>`;
    const bySize = [...pts].sort((a, b) => b.sales12 - a.sales12);
    const dots = bySize.map((p) => {   // biggest first, so small dots stay on top
      const col = `var(--${p.classification.key})`;
      const x = X(p.sales12), y = Y(lg(p.growth));
      const tip = t('vprod.tip', p.name, fmtCompactYen(p.sales12), p.growth == null ? t('vprod.noPrev') : fmtSignedPct(p.growth, 0), clsLabel(p.classification.key));
      const shape = p.growth == null
        ? `<path d="M${x.toFixed(1)},${(y - 6).toFixed(1)} L${(x + 6).toFixed(1)},${(y + 5).toFixed(1)} L${(x - 6).toFixed(1)},${(y + 5).toFixed(1)} Z" fill="${col}"></path>`
        : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5.5" fill="${p.active ? col : 'var(--surface)'}" fill-opacity="0.85" stroke="${col}" stroke-width="1.6"></circle>`;
      return `<g class="map-dot" data-name="${escapeHtml(p.name)}"><title>${escapeHtml(tip)}</title>${shape}</g>`;
    }).join('');
    // names for the biggest series, skipping any that would overlap one already placed
    const placed = [];
    const labels = bySize.slice(0, 20).map((p) => {
      const x = X(p.sales12), y = Y(lg(p.growth));
      const right = x < W - 180;
      const box = { a: right ? x + 8 : x - 168, b: right ? x + 168 : x - 8, y };
      if (placed.some((q) => Math.abs(q.y - y) < 13 && box.a < q.b && q.a < box.b)) return '';
      placed.push(box);
      return `<text class="map-label" x="${(right ? x + 8 : x - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="${right ? 'start' : 'end'}">${escapeHtml(p.name)}</text>`;
    }).join('');
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg map-svg" preserveAspectRatio="xMidYMid meet">${zones}${grid}${dots}${labels}</svg>`;
    container.querySelectorAll('.map-dot').forEach((g) => g.addEventListener('click', () => openProductDetail(g.dataset.name)));
    const keys = ['seasonal', 'seasonal-spiky', 'spiky', 'stable', 'insufficient'].filter((k) => pts.some((p) => p.classification.key === k));
    legend.innerHTML = keys.map((k) => `<span><i style="background:var(--${k})"></i>${escapeHtml(clsLabel(k))}</span>`).join('')
      + `<span>${escapeHtml(t('vprod.legendShapes'))}</span>`;
  }

  // ---- calendar: strong / weak for one 月度, and the season map ----
  let vcalMonth = (() => {
    const d = new Date();
    const cur = d.getMonth() + 1 + (d.getDate() >= 21 ? 1 : 0);   // this 月度 (13 = next January)
    return (cur % 12) + 1;                                           // the 月度 after it
  })();
  const vcalClasses = new Set(['seasonal', 'seasonal-spiky']);
  let vcalItems = [];

  function renderCalendarVisual(items) {
    vcalItems = items;
    const at = (c) => seasonValue(c.seasonal[vcalMonth - 1]);
    const picker = document.getElementById('vcal-months');
    picker.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
      `<button type="button" class="month-btn${m === vcalMonth ? ' is-active' : ''}" data-m="${m}">${escapeHtml(monthLabel(m))}</button>`).join('');
    picker.querySelectorAll('.month-btn').forEach((b) => b.addEventListener('click', () => {
      vcalMonth = Number(b.dataset.m);
      renderCalendarVisual(vcalItems);
    }));
    // only series with a seasonal verdict: elsewhere the 月度 differences are noise
    const pool = items.filter((c) => !c.tentative && (c.classification.key === 'seasonal' || c.classification.key === 'seasonal-spiky'));
    const strong = pool.filter((c) => at(c) > 1.02).sort((a, b) => at(b) - at(a)).slice(0, 15);
    const weak = pool.filter((c) => at(c) < 0.98).sort((a, b) => at(a) - at(b)).slice(0, 10);
    const maxDev = Math.max(0.2, ...[...strong, ...weak].map((c) => Math.abs(at(c) - 1)));
    const list = (arr, up) => (arr.length ? arr.map((c) => {
      const v = at(c);
      return `<div class="dv-row" data-name="${escapeHtml(c.name)}" title="${escapeHtml(t('vcal.rowTip', c.name, monthLabel(vcalMonth), fmtPct(v, 0)))}">
        <span class="dv-name">${escapeHtml(c.name)}</span>
        <span class="dv-bar"><i class="${up ? 'is-up' : 'is-down'}" style="width:${(Math.abs(v - 1) / maxDev * 100).toFixed(1)}%"></i></span>
        <span class="dv-val ${up ? 'up' : 'down'}">${fmtSignedPct(v - 1, 0)}</span>
        ${growthChip(c.growth)}
      </div>`;
    }).join('') : `<p class="muted-small">${escapeHtml(t('vcal.none'))}</p>`);
    document.getElementById('vcal-strong').innerHTML = list(strong, true);
    document.getElementById('vcal-weak').innerHTML = list(weak, false);
    renderSeasonMap(items);
    document.querySelectorAll('#calendar-visual [data-name]').forEach((el) => el.addEventListener('click', () => openProductDetail(el.dataset.name)));
  }

  function renderSeasonMap(items) {
    const chips = document.getElementById('vcal-classes');
    const counts = new Map();
    items.forEach((c) => counts.set(c.classification.key, (counts.get(c.classification.key) || 0) + 1));
    chips.innerHTML = `<span class="scope-label">${escapeHtml(t('vcal.classes'))}</span>`
      + ['seasonal', 'seasonal-spiky', 'spiky', 'stable', 'insufficient'].filter((k) => counts.has(k)).map((k) => `
        <label class="scope-chip${vcalClasses.has(k) ? ' is-on' : ''}"><input type="checkbox" value="${k}" ${vcalClasses.has(k) ? 'checked' : ''} />
          ${escapeHtml(clsLabel(k))} <span class="scope-n">${counts.get(k)}</span></label>`).join('');
    chips.querySelectorAll('input').forEach((box) => box.addEventListener('change', () => {
      if (box.checked) vcalClasses.add(box.value); else vcalClasses.delete(box.value);
      renderCalendarVisual(vcalItems);
    }));
    const cells = (seasonal, peak, tentative) => seasonal.map((s) => {
      const v = seasonValue(s);
      const bg = tentative ? null : heatBg(v);
      return `<i class="${s.month === peak ? 'is-peak' : ''}" style="background:${bg || 'var(--line-soft)'}" title="${escapeHtml(monthLabel(s.month) + ' ' + fmtPct(v, 0))}"></i>`;
    }).join('');
    const head = `<div class="smap-row smap-head"><span class="smap-name"></span><span class="smap-cells">${
      Array.from({ length: 12 }, (_, i) => `<b>${escapeHtml(monthLabel(i + 1))}</b>`).join('')}</span></div>`;
    let shop = '';
    if (seasonMode === 'absolute' && analysisCtx) {
      const ss = periodCtx().mu.map((m, i) => ({ month: i + 1, index: Math.exp(m), relative: 1 }));
      const peak = ss.reduce((a, b) => (b.index > a.index ? b : a)).month;
      shop = `<div class="smap-row smap-shop"><span class="smap-name">${escapeHtml(t('vcal.shop'))}</span><span class="smap-cells">${cells(ss, peak, false)}</span></div>`;
    }
    const shown = items.filter((c) => vcalClasses.has(c.classification.key));
    const groups = Array.from({ length: 12 }, () => []);
    shown.forEach((c) => groups[c.peakMonth - 1].push(c));
    const body = groups.map((g, i) => {
      if (!g.length) return '';
      g.sort((a, b) => seasonValue(b.seasonal[i]) - seasonValue(a.seasonal[i]));
      return `<div class="smap-group">${escapeHtml(t('vcal.peakGroup', monthLabel(i + 1), g.length))}</div>`
        + g.map((c) => `<div class="smap-row" data-name="${escapeHtml(c.name)}"><span class="smap-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span><span class="smap-cells">${cells(c.seasonal, c.peakMonth, c.tentative)}</span></div>`).join('');
    }).join('');
    document.getElementById('vcal-map').innerHTML = shown.length ? head + shop + body : `<p class="muted-small">${escapeHtml(t('vcal.none'))}</p>`;
  }

  // ---- detail: verdict card ----
  function renderClassViz(a) {
    const box = document.getElementById('viz-class');
    if (!isVisual()) { box.innerHTML = ''; return; }
    const s = a.sufficiency, C = SalesStats.CONFIG;
    const om = omegaOf(a);
    const p = s.ok ? a.test.p : null;
    const meter = (label, value, track, left, right) => `
      <div class="meter">
        <div class="meter-head"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
        <div class="meter-track">${track}</div>
        <div class="meter-scale"><span>${escapeHtml(left)}</span><span>${escapeHtml(right)}</span></div>
      </div>`;
    let html = meter(t('vdet.omega'), om == null ? '—' : fmtPct(om, 0),
      `<i class="meter-fill" style="width:${om == null ? 0 : Math.min(100, om * 100).toFixed(1)}%"></i>`, t('vdet.omegaLow'), t('vdet.omegaHigh'));
    if (p != null) {
      // p on a log scale from the smallest a permutation test can give, up to 1
      const pMin = 1 / (C.permutations + 1);
      const pos = (v) => (Math.log(Math.max(v, pMin) / pMin) / Math.log(1 / pMin) * 100).toFixed(1);
      html += meter(t('vdet.p'), fmtP(p),
        `<span class="meter-zone" style="width:${pos(C.alpha)}%"></span><em class="meter-cut" style="left:${pos(C.alpha)}%"></em><i class="meter-dot${p < C.alpha ? ' is-sig' : ''}" style="left:${pos(p)}%"></i>`,
        t('vdet.pSure'), t('vdet.pChance'));
    }
    const scaleMax = Math.max(s.months, C.minMonths * 2);
    html += meter(t('rel.months'), t('vdet.monthsVal', s.months),
      `<i class="meter-fill is-grey" style="width:${(s.months / scaleMax * 100).toFixed(1)}%"></i><em class="meter-cut" style="left:${(C.minMonths / scaleMax * 100).toFixed(1)}%" title="${C.minMonths}"></em>`,
      '0', t('vdet.monthsNeed', C.minMonths));
    html += meter(t('rel.weight'), fmtPct(a.weight, 0),
      `<i class="meter-fill is-grey" style="width:${(a.weight * 100).toFixed(1)}%"></i>`, t('vdet.weightLow'), t('vdet.weightHigh'));
    const maxN = Math.max(...a.seasonal.map((x) => x.n), C.minPerMonth + 1);
    html += `<div class="nbars-wrap"><div class="meter-head"><span>${escapeHtml(t('vdet.nHeading', C.minPerMonth))}</span></div>
      <div class="nbars"><em class="nbars-cut" style="bottom:${(C.minPerMonth / maxN * 100).toFixed(1)}%"></em>${a.seasonal.map((x) => `
        <div class="nbar${x.n < C.minPerMonth ? ' is-short' : ''}" title="${escapeHtml(monthLabel(x.month))}: ${x.n}"><i style="height:${(x.n / maxN * 100).toFixed(1)}%"></i><span>${x.month}</span></div>`).join('')}</div></div>`;
    html += `<p class="rel-reason${s.ok ? '' : ' is-weak'}">${escapeHtml(reliabilityReason(a))}</p>`;
    box.innerHTML = html;
  }

  // ---- detail: average monthly sales per year ----
  function renderYoyViz(yoy) {
    const box = document.getElementById('viz-yoy');
    if (!isVisual() || !yoy.length) { box.innerHTML = ''; return; }
    const W = 520, H = 210, padT = 26, padB = 30, padX = 6;
    const max = Math.max(...yoy.map((y) => y.avg), 1);
    const slot = (W - padX * 2) / yoy.length, bw = Math.min(44, slot * 0.66);
    const bars = yoy.map((y, i) => {
      const x = padX + i * slot + (slot - bw) / 2, cx = (x + bw / 2).toFixed(1);
      const h = (y.avg / max) * (H - padT - padB), top = H - padB - h;
      const g = y.yoy;
      const tip = `${y.year}: ${fmtYen(y.avg)}${g == null ? '' : ' / ' + fmtSignedPct(g)}${y.partial ? ' ' + t('detail.partialYear', y.n) : ''}`;
      return `<g><title>${escapeHtml(tip)}</title>
        <rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--seasonal)" opacity="${y.partial ? 0.35 : 0.9}"></rect>
        ${g == null ? '' : `<text x="${cx}" y="${(top - 6).toFixed(1)}" font-size="11" font-weight="700" text-anchor="middle" fill="${g >= 0 ? 'var(--seasonal)' : 'var(--danger)'}">${fmtSignedPct(g, 0)}</text>`}
        <text x="${cx}" y="${H - padB + 16}" font-size="11" text-anchor="middle" fill="var(--ink-soft)">${y.year}</text></g>`;
    }).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg">${bars}</svg><p class="muted-small viz-caption">${escapeHtml(t('vdet.yoyCaption'))}</p>`;
  }

  // ---- detail: where the spikes and dips sit on the sales line ----
  function renderSpikeTimeline(rows, a) {
    const box = document.getElementById('viz-spikes');
    if (!isVisual() || rows.length < 2) { box.innerHTML = ''; return; }
    const W = 1000, H = 200, padT = 22, padB = 26, padX = 12;
    const n = rows.length;
    const max = Math.max(...rows.map((r) => r.sales), 1), min = Math.min(0, ...rows.map((r) => r.sales));
    const X = (i) => padX + (i / (n - 1)) * (W - padX * 2);
    const Y = (v) => padT + (1 - (v - min) / (max - min || 1)) * (H - padT - padB);
    const idx = new Map(rows.map((r, i) => [r.ymKey, i]));
    const line = rows.map((r, i) => `${X(i).toFixed(1)},${Y(r.sales).toFixed(1)}`).join(' ');
    const marks = (list, up) => list.map((r, k) => {
      const i = idx.get(r.ymKey);
      if (i == null) return '';
      const x = X(i).toFixed(1), y = Y(rows[i].sales);
      const tip = `${r.ymKey}  ${fmtYen(rows[i].sales)}  ${t('vdet.vsExpected', fmtPct(r.ratio, 0))}`;
      return up
        ? `<g class="tl-mark" data-ym="${r.ymKey}"><title>${escapeHtml(tip)}</title><circle cx="${x}" cy="${y.toFixed(1)}" r="8.5" fill="var(--campaign)" stroke="#fff" stroke-width="1.5"></circle><text x="${x}" y="${(y + 3.6).toFixed(1)}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${k + 1}</text></g>`
        : `<g class="tl-mark" data-ym="${r.ymKey}"><title>${escapeHtml(tip)}</title><path d="M${(+x - 6).toFixed(1)},${(y + 5).toFixed(1)} L${(+x + 6).toFixed(1)},${(y + 5).toFixed(1)} L${x},${(y + 15).toFixed(1)} Z" fill="var(--danger)"></path></g>`;
    }).join('');
    const years = rows.map((r, i) => ((r.month === 1 || i === 0)
      ? `<text x="${X(i).toFixed(1)}" y="${H - 7}" font-size="11" fill="var(--ink-soft)" text-anchor="middle">${r.year}</text>` : '')).join('');
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="xMidYMid meet">
        <polyline points="${line}" fill="none" stroke="var(--ink-soft)" stroke-width="1.5"></polyline>${years}${marks(a.dips, false)}${marks(a.spikes, true)}</svg>
      <p class="muted-small viz-caption">${escapeHtml(t('vdet.timelineCaption'))}</p>`;
    box.querySelectorAll('.tl-mark').forEach((g) => g.addEventListener('click', () => {
      const li = document.querySelector(`.spike-item[data-ym="${g.dataset.ym}"]`);
      if (!li) return;
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li.classList.add('is-flash');
      setTimeout(() => li.classList.remove('is-flash'), 1400);
    }));
  }

  // Bullet bars: this 月度's buyers per type, with a tick at the usual month.
  function buyerDriverViz(d) {
    const el = document.createElement('div');
    el.className = 'drv';
    const max = Math.max(1, ...d.b.slice(0, 4), ...d.base);
    el.innerHTML = BUYER_KEYS.map((k, i) => `
      <div class="drv-row" title="${escapeHtml(t('buyers.vsUsual', t('buyers.' + k), d.b[i], Math.round(d.base[i])))}">
        <span class="drv-k">${escapeHtml(t('buyers.' + k))}</span>
        <span class="drv-track"><i class="drv-now" style="width:${(d.b[i] / max * 100).toFixed(1)}%;background:var(--b-${k})"></i><i class="drv-usual" style="left:${(d.base[i] / max * 100).toFixed(1)}%"></i></span>
        <span class="drv-v">${fmtInt(d.b[i])}<small> / ${fmtInt(d.base[i])}</small></span>
      </div>`).join('')
      + `<p class="drv-pattern">→ ${escapeHtml(t('buyers.pattern.' + d.key))}</p>`
      + (d.newRate != null ? `<p class="muted-small">${escapeHtml(t('buyers.spikeRepeat', fmtPct(d.newRate, 0), d.baseRate != null ? fmtPct(d.baseRate, 0) : '—'))}</p>` : '');
    return el;
  }

  function skuShareViz(drivers) {
    const el = document.createElement('div');
    el.className = 'drv drv-skus';
    el.innerHTML = `<p class="muted-small">${escapeHtml(t('detail.spikeSkus'))}</p>` + drivers.map((d) => `
      <div class="drv-row"><span class="drv-k" title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</span>
        <span class="drv-track"><i class="drv-now" style="width:${((d.share || 0) * 100).toFixed(1)}%;background:var(--ink-soft)"></i></span>
        <span class="drv-v">${d.share != null ? fmtPct(d.share, 0) : '—'}</span></div>`).join('');
    return el;
  }

  // ---- detail: buyer mix and repurchase ----
  function renderBuyerViz(rows) {
    const box = document.getElementById('buyer-viz');
    if (!isVisual()) { box.innerHTML = ''; return; }
    const s = buyerStats(rows);
    const order = [2, 3, 1, 0];   // 継続, 復帰, 商品初回, 店舗新規 — same stack as the chart
    const scale = Math.max(s.n, s.pn, 1);
    const mix = (label, v, total) => `
      <div class="mix-row"><span class="mix-label">${escapeHtml(label)}</span>
        <span class="mix-track"><span class="mix-bar" style="width:${(total / scale * 100).toFixed(1)}%">${order.map((k) => {
          const w = total ? v[k] / total * 100 : 0;
          return w && !buyerHidden.has(k) ? `<i style="width:${w.toFixed(2)}%;background:var(--b-${BUYER_KEYS[k]})" title="${escapeHtml(t('buyers.' + BUYER_KEYS[k]) + ' ' + fmtInt(v[k]))}">${w >= 9 ? fmtInt(v[k]) : ''}</i>` : '';
        }).join('')}</span></span></div>`;
    let html = `<div class="bviz-block"><h4>${escapeHtml(t('vdet.mixHeading'))}</h4>
      ${mix(t('vdet.mixCur', fmtInt(s.n)), s.cur, s.n)}${s.pn ? mix(t('vdet.mixPrev', fmtInt(s.pn)), s.prev, s.pn) : ''}</div>`;
    if (s.rc && s.rc.all != null) {
      const dumb = (label, cur, prev) => {
        if (cur == null) return '';
        const up = prev == null || cur >= prev;
        const lo = prev == null ? cur : Math.min(cur, prev), hi = prev == null ? cur : Math.max(cur, prev);
        return `<div class="dumb-row"><span class="mix-label">${escapeHtml(label)}</span>
          <span class="dumb-track">
            <i class="dumb-line ${up ? 'is-up' : 'is-down'}" style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></i>
            ${prev == null ? '' : `<i class="dumb-prev" style="left:${(prev * 100).toFixed(1)}%"></i>`}
            <i class="dumb-cur ${up ? 'is-up' : 'is-down'}" style="left:${(cur * 100).toFixed(1)}%"></i>
          </span>
          <span class="dumb-val">${prev == null ? '' : fmtPct(prev, 0) + ' → '}<b>${fmtPct(cur, 0)}</b></span></div>`;
      };
      html += `<div class="bviz-block"><h4>${escapeHtml(t('vdet.repHeading', s.rc.from, s.rc.to))}</h4>
        ${dumb(t('vdet.repAll'), s.rc.all, s.rp.all)}${dumb(t('vdet.repNew'), s.rc.newc, s.rp.newc)}
        <p class="muted-small">${escapeHtml(t('vdet.repLegend'))}</p></div>`;
    }
    const flags = s.warns.map((w) => `<span class="viz-flag is-warn">⚠ ${escapeHtml(t('buyers.' + w))}</span>`);
    if (s.inflow) flags.push(`<span class="viz-flag">↑ ${escapeHtml(t('buyers.noteInflow', s.inflow.toFixed(1)))}</span>`);
    box.innerHTML = `<div class="bviz">${html}</div>${flags.length ? `<div class="viz-flags">${flags.join('')}</div>` : ''}`;
  }

  // ---- detail: year × 月度 heatmap in place of the monthly table ----
  function renderRawViz(rows, a) {
    const box = document.getElementById('viz-raw');
    if (!isVisual()) { box.innerHTML = ''; return; }
    const zBy = new Map(a.rowsWithRatio.map((r) => [r.ymKey, r]));
    const spikes = new Set(a.spikes.map((r) => r.ymKey));
    const dips = new Set(a.dips.map((r) => r.ymKey));
    const by = new Map(rows.map((r) => [r.ymKey, r]));
    const max = Math.max(...rows.map((r) => r.sales), 1);
    const years = [...new Set(rows.map((r) => r.year))].sort((x, y) => y - x);
    const totals = years.map((y) => rows.reduce((s, r) => (r.year === y ? s + r.sales : s), 0));
    const maxT = Math.max(...totals, 1);
    const head = `<div class="hm-row hm-head"><span></span>${Array.from({ length: 12 }, (_, i) => `<b>${i + 1}</b>`).join('')}<b>${escapeHtml(t('vdet.yearTotal'))}</b></div>`;
    const body = years.map((y, yi) => `<div class="hm-row"><span class="hm-year">${y}</span>${Array.from({ length: 12 }, (_, i) => {
      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
      const r = by.get(key);
      if (!r) return '<i class="hm-cell is-none"></i>';
      const z = zBy.get(key);
      const cls = spikes.has(key) ? ' is-spike' : (dips.has(key) ? ' is-dip' : '');
      const tip = [key, fmtYen(r.sales), `${t('detail.thRawQty')} ${fmtInt(r.qty)}`,
        r.totalCustomers != null ? `${t('detail.thRawTotalCust')} ${fmtInt(r.totalCustomers)}` : null,
        z && z.ratio != null ? t('vdet.vsExpected', fmtPct(z.ratio, 0)) : null].filter(Boolean).join('  ');
      return `<i class="hm-cell${cls}" style="background:${mixHex('#FFFFFF', '#2F6F5E', Math.sqrt(Math.max(0, r.sales) / max))}" title="${escapeHtml(tip)}"></i>`;
    }).join('')}<span class="hm-total"><i style="width:${(totals[yi] / maxT * 100).toFixed(1)}%"></i><em>${fmtCompactYen(totals[yi])}</em></span></div>`).join('');
    box.innerHTML = `<div class="hm">${head}${body}</div><p class="muted-small viz-caption">${escapeHtml(t('vdet.rawCaption'))}</p>`;
  }


  // ---------------- 受注方法 (the order header's チャネル区分) ----------------
  // products.json rows carry ch = {code: 売上金額}; SKUs carry ch = {ymKey: {code: 売上金額}}.
  // The site works with seven groups of codes; a code not listed here counts as その他.
  const CHANNEL_GROUPS = [
    { key: 'web', codes: ['11'], color: '#2F6F5E' },
    { key: 'mall', codes: ['12', '13', '14'], color: '#C9962E' },
    { key: 'phone', codes: ['41', '42', '44'], color: '#3E5F78' },
    { key: 'mail', codes: ['43', '45'], color: '#8A6E96' },
    { key: 'store', codes: ['31', '32', '33', '34'], color: '#B4483C' },
    { key: 'seminar', codes: ['71', '72', '73', '74', '75'], color: '#86B49C' },
    { key: 'other', codes: ['81', '91'], color: '#A9B6BD' },
  ];
  const CHANNEL_NAMES = {
    11: 'WEB本店', 12: '楽天', 13: 'Yahoo', 14: 'Amazon', 31: '京都来店', 32: '東京来店', 33: '京都来店(受注)',
    34: '東京来店(受注)', 41: '京都電話', 42: '東京電話', 43: 'FAX', 44: 'コールセンター', 45: 'ハガキ・メール',
    71: '大阪美健セミナー', 72: '東京美健セミナー', 73: '京都ショップセミナー', 74: '東京ショップセミナー',
    75: 'その他セミナー', 81: '社員販売', 91: 'その他',
  };
  const groupOfCode = new Map();
  CHANNEL_GROUPS.forEach((g, i) => g.codes.forEach((c) => groupOfCode.set(c, i)));
  const groupIndex = (code) => (groupOfCode.has(code) ? groupOfCode.get(code) : CHANNEL_GROUPS.length - 1);
  const chLabel = (key) => t('ch.' + key);
  function chGroups(ch) {
    const out = new Array(CHANNEL_GROUPS.length).fill(0);
    if (ch) Object.keys(ch).forEach((c) => { out[groupIndex(c)] += ch[c]; });
    return out;
  }

  // Top-bar filter: '' = every 受注方法, else one group key. Remembered per browser.
  const CHANNEL_KEY = 'thd-sales-ledger-channel';
  let chFilter = (() => {
    try { const v = localStorage.getItem(CHANNEL_KEY) || ''; return CHANNEL_GROUPS.some((g) => g.key === v) ? v : ''; } catch (e) { return ''; }
  })();
  function chSales(ch) {
    const i = CHANNEL_GROUPS.findIndex((g) => g.key === chFilter);
    let s = 0;
    if (ch) Object.keys(ch).forEach((c) => { if (groupIndex(c) === i) s += ch[c]; });
    return s;
  }
  // With a filter on, every page works on that group's sales only. Units, lines, customers and
  // buyer types are not split by 受注方法, so they are blanked rather than shown wrong.
  function withChannel(rec) {
    if (!chFilter) return rec;
    const rows = rec.rows.map((r) => ({
      ymKey: r.ymKey, year: r.year, month: r.month, sales: chSales(r.ch), qty: null, orderCount: null,
      orders: null, totalCustomers: null, newCustomers: null, existingCustomers: null, ch: r.ch,
    }));
    const skus = (rec.skus || []).map((s) => ({ ...s, rows: s.rows.map((r) => [r[0], chSales(s.ch && s.ch[r[0]]), null, null]) }));
    return { ...rec, rows, skus, buyersHidden: rec.rows.some((r) => Array.isArray(r.buyers)) };
  }
  // .xlsx uploads and older products.json files have no 受注方法: they drop out while filtering.
  async function loadAll() {
    const all = await SalesDB.getAll();
    if (!chFilter) return all;
    return all.filter((p) => p.rows.some((r) => r.ch)).map(withChannel).filter((p) => p.rows.some((r) => r.sales > 0));
  }
  async function loadOne(name) {
    const rec = await SalesDB.get(name);
    return rec && withChannel(rec);
  }
  function channelNote() {
    return chFilter ? t('ch.note', chLabel(chFilter)) : '';
  }

  function fillChannelSelect() {
    const sel = document.getElementById('channel-filter');
    sel.innerHTML = `<option value="">${escapeHtml(t('ch.all'))}</option>`
      + CHANNEL_GROUPS.map((g) => `<option value="${g.key}">${escapeHtml(chLabel(g.key))}</option>`).join('');
    sel.value = chFilter;
    sel.classList.toggle('is-on', !!chFilter);
  }
  fillChannelSelect();
  document.getElementById('channel-filter').addEventListener('change', (e) => {
    chFilter = e.target.value;
    try { localStorage.setItem(CHANNEL_KEY, chFilter); } catch (err) { /* ignore */ }
    e.target.classList.toggle('is-on', !!chFilter);
    skuSelection = null;
    rerenderActive();
  });

  // Last 12 月度 against the 12 before, per group. rows: series-shaped rows with ch.
  function channelStats(rows, last) {
    const from12 = shiftYm(last, -11), from24 = shiftYm(last, -23);
    const n = CHANNEL_GROUPS.length;
    const cur = new Array(n).fill(0), prev = new Array(n).fill(0);
    rows.forEach((r) => {
      if (r.ymKey > last || r.ymKey < from24) return;
      const g = chGroups(r.ch), into = r.ymKey >= from12 ? cur : prev;
      g.forEach((v, i) => { into[i] += v; });
    });
    const total = cur.reduce((s, v) => s + v, 0), ptotal = prev.reduce((s, v) => s + v, 0);
    return {
      total, ptotal, from12, last,
      groups: CHANNEL_GROUPS.map((g, i) => ({
        ...g, index: i, cur: cur[i], prev: prev[i],
        share: total > 0 ? cur[i] / total : 0, prevShare: ptotal > 0 ? prev[i] / ptotal : 0,
        yoy: prev[i] > 0 ? cur[i] / prev[i] - 1 : null,
      })),
    };
  }

  // Monthly stacked bars, one layer per 受注方法 group. The legend toggles layers (double-click
  // shows one alone) and the axis rescales to what is left. hidden: a Set of group indexes.
  function stackChart(container, rows, hidden, rerender) {
    const W = 1000, H = 220, padTop = 14, padBottom = 24, padL = 56, padR = 8;
    const usableW = W - padL - padR, usableH = H - padTop - padBottom;
    const vals = rows.map((r) => chGroups(r.ch).map((v) => Math.max(0, v)));
    const order = CHANNEL_GROUPS.map((g, i) => i).filter((i) => !hidden.has(i));
    const maxV = Math.max(...vals.map((v) => order.reduce((s, i) => s + v[i], 0)), 1);
    const slot = usableW / Math.max(1, rows.length), bw = Math.max(1, slot * 0.72);
    const y = (v) => padTop + usableH - (v / maxV) * usableH;
    const bars = rows.map((r, j) => {
      const x = padL + j * slot + (slot - bw) / 2;
      let acc = 0;
      const rects = order.map((i) => {
        const v = vals[j][i];
        if (!v) return '';
        const y0 = y(acc + v), h = y(acc) - y0;
        acc += v;
        return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${CHANNEL_GROUPS[i].color}"></rect>`;
      }).join('');
      const tip = `${r.ymKey}  ` + CHANNEL_GROUPS.map((g, i) => (vals[j][i] ? `${chLabel(g.key)} ${fmtCompactYen(vals[j][i])}` : '')).filter(Boolean).join(' / ');
      return `<g><title>${escapeHtml(tip)}</title>${rects}<rect x="${(padL + j * slot).toFixed(1)}" y="${padTop}" width="${slot.toFixed(1)}" height="${usableH}" fill="transparent"></rect></g>`;
    }).join('');
    const xLabels = rows.map((r, j) => ((r.month === 1 || j === 0)
      ? `<text x="${(padL + j * slot + slot / 2).toFixed(1)}" y="${H - 7}" font-size="11" fill="var(--ink-soft)" text-anchor="middle">${r.year}</text>` : '')).join('');
    const axis = `<text x="${padL - 6}" y="${padTop + 9}" font-size="10.5" fill="var(--ink-soft)" text-anchor="end">${escapeHtml(fmtCompactYen(maxV))}</text>
      <text x="${padL - 6}" y="${padTop + usableH}" font-size="10.5" fill="var(--ink-soft)" text-anchor="end">0</text>`;
    const present = CHANNEL_GROUPS.map((g, i) => i).filter((i) => vals.some((v) => v[i] > 0));
    const legend = '<div class="buyer-legend">'
      + present.map((i) => `<button type="button" class="legend-btn${hidden.has(i) ? ' is-off' : ''}" data-layer="${i}">`
      + `<i style="background:${CHANNEL_GROUPS[i].color}"></i>${escapeHtml(chLabel(CHANNEL_GROUPS[i].key))}</button>`).join('')
      + (hidden.size ? `<button type="button" class="legend-reset">${escapeHtml(t('buyers.legendShowAll'))}</button>` : '')
      + `<span class="legend-hint">${escapeHtml(t('buyers.legendHint'))}</span></div>`;
    container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="trend-svg" preserveAspectRatio="xMidYMid meet">${bars}${xLabels}${axis}</svg>${legend}`;
    let pending = null;
    container.querySelectorAll('.legend-btn').forEach((btn) => {
      const i = Number(btn.dataset.layer);
      btn.addEventListener('click', () => {
        clearTimeout(pending);
        pending = setTimeout(() => { if (hidden.has(i)) hidden.delete(i); else hidden.add(i); rerender(); }, 220);
      });
      btn.addEventListener('dblclick', () => {
        clearTimeout(pending);
        CHANNEL_GROUPS.forEach((g, k) => (k === i ? hidden.delete(k) : hidden.add(k)));
        rerender();
      });
    });
    const reset = container.querySelector('.legend-reset');
    if (reset) reset.addEventListener('click', () => { hidden.clear(); rerender(); });
  }

  // Share bar + change chip per group (visual mode), and the same as a table (numbers mode).
  function channelShareHtml(st) {
    const max = Math.max(...st.groups.map((g) => g.cur), 1);
    return st.groups.filter((g) => g.cur > 0 || g.prev > 0).map((g) => `
      <div class="chs-row" title="${escapeHtml(g.codes.map((c) => CHANNEL_NAMES[c] || c).join(' / '))}">
        <span class="chs-name"><i style="background:${g.color}"></i>${escapeHtml(chLabel(g.key))}</span>
        <span class="cell-bar"><i style="width:${(g.cur / max * 100).toFixed(1)}%;background:${g.color};opacity:0.35"></i><em>${fmtCompactYen(g.cur)}</em></span>
        <span class="chs-share">${fmtPct(g.share, 0)}</span>
        ${growthChip(g.yoy, t('mom.yoyTip'))}
      </div>`).join('');
  }
  // extra: optional { heads: [label], cells: (group) => '<td>…</td>' } for more columns.
  function channelTableHtml(st, extra) {
    const rows = st.groups.filter((g) => g.cur > 0 || g.prev > 0).map((g) => `
      <tr><td><i class="chs-dot" style="background:${g.color}"></i>${escapeHtml(chLabel(g.key))}</td>
        <td class="muted-small">${escapeHtml(g.codes.map((c) => CHANNEL_NAMES[c] || c).join('・'))}</td>
        <td class="pct-cell">${fmtYen(g.cur)}</td><td class="pct-cell">${fmtPct(g.share, 1)}</td>
        <td class="pct-cell">${fmtPct(g.prevShare, 1)}</td>
        <td class="pct-cell">${g.yoy != null ? `<span class="${g.yoy >= 0 ? 'up' : 'down'}">${fmtSignedPct(g.yoy, 0)}</span>` : '—'}</td>
        ${extra ? extra.cells(g) : ''}</tr>`).join('');
    const heads = [t('ch.thGroup'), t('ch.thCodes'), t('ch.thCur'), t('ch.thShare'), t('ch.thPrevShare'), t('mom.thYoy'), ...(extra ? extra.heads : [])];
    return `<table class="ch-table"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows}<tr class="ch-total"><td>${escapeHtml(t('ch.total'))}</td><td></td><td class="pct-cell">${fmtYen(st.total)}</td><td class="pct-cell">100%</td><td></td>
      <td class="pct-cell">${st.ptotal > 0 ? fmtSignedPct(st.total / st.ptotal - 1, 0) : '—'}</td>${extra ? '<td></td>'.repeat(extra.heads.length) : ''}</tr></tbody></table>`;
  }

  // ---- detail page card ----
  let chRange = 'recent';
  const chHidden = new Set();
  function renderChannelCard(view) {
    const card = document.getElementById('channel-card');
    const rows = view.rows.filter((r) => r.ch);
    card.hidden = !rows.length;
    if (!rows.length) return;
    const last = rows[rows.length - 1].ymKey > latestAll ? rows[rows.length - 1].ymKey : (latestAll || rows[rows.length - 1].ymKey);
    const st = channelStats(rows, last);
    document.getElementById('channel-sub').textContent = t('ch.cardSub', st.from12, st.last)
      + (view.selection ? ' ' + t('ch.subSkus', view.selection.codes.length) : '');
    document.getElementById('channel-summary').innerHTML = `<div class="table-wrap">${channelTableHtml(st)}</div>`;
    document.getElementById('channel-viz').innerHTML = channelShareHtml(st);
    const shown = chRange === 'all' ? rows : rows.filter((r) => r.ymKey >= shiftYm(last, -35));
    stackChart(document.getElementById('channel-chart'), shown, chHidden, () => renderChannelCard(currentView));
  }
  document.querySelectorAll('.ch-range-btn').forEach((btn) => btn.addEventListener('click', () => {
    chRange = btn.dataset.range;
    document.querySelectorAll('.ch-range-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    if (currentView) renderChannelCard(currentView);
  }));

  // ---- 受注方法 tab: the groups side by side, shop-wide ----
  let chTabRange = 'recent';
  let chTabGroup = 'web';
  const chTabHidden = new Set();
  async function renderChannelsTab() {
    const products = await SalesDB.getAll();   // always every 受注方法: this tab compares them
    const scopeBar = document.getElementById('channels-scope');
    const empty = document.getElementById('channels-empty');
    const withCh = products.filter((p) => p.rows.some((r) => r.ch));
    empty.hidden = withCh.length > 0;
    document.getElementById('channels-body').hidden = !withCh.length;
    if (!withCh.length) { scopeBar.innerHTML = ''; return; }
    renderScopeBar(scopeBar, products, renderChannelsTab);
    const scoped = withCh.filter(inScope);
    const last = latestYm(withCh);

    // shop-wide monthly totals per code
    const byYm = new Map();
    scoped.forEach((p) => p.rows.forEach((r) => {
      if (!r.ch) return;
      const acc = byYm.get(r.ymKey) || {};
      Object.keys(r.ch).forEach((c) => { acc[c] = (acc[c] || 0) + r.ch[c]; });
      byYm.set(r.ymKey, acc);
    }));
    const rows = [...byYm.keys()].sort().map((k) => {
      const [year, month] = k.split('-').map(Number);
      return { ymKey: k, year, month, ch: byYm.get(k) };
    });
    const st = channelStats(rows, last);
    document.getElementById('chtab-sub').textContent = t('ch.cardSub', st.from12, st.last) + ' ' + t('ch.tabScope', scoped.length);
    const shown = chTabRange === 'all' ? rows : rows.filter((r) => r.ymKey >= shiftYm(last, -35));
    stackChart(document.getElementById('chtab-chart'), shown, chTabHidden, renderChannelsTab);

    // each group's own seasonal pattern; groups are long, large series, so no shrinkage
    const from = period ? shiftYm(last, -(12 * period - 1)) : '';
    const flat = { mu: new Array(12).fill(0), tau2: 1e6 };
    const seasons = CHANNEL_GROUPS.map((g, i) => {
      const gr = rows.filter((r) => r.ymKey >= from).map((r) => ({ ymKey: r.ymKey, year: r.year, month: r.month, sales: chGroups(r.ch)[i] }));
      if (!gr.some((r) => r.sales > 0)) return null;
      const a = SalesStats.analyze(gr, flat, 'ch:' + g.key + '|' + from);
      const peak = a.seasonal.reduce((x, y) => (y.index > x.index ? y : x)).month;
      return { a, peak };
    });
    document.getElementById('chtab-table').innerHTML = channelTableHtml(st, {
      heads: [t('ch.thVerdict'), t('ch.thPeak')],
      cells: (g) => {
        const s = seasons[g.index];
        if (!s) return '<td></td><td></td>';
        const k = s.a.classification.key;
        return `<td><span class="class-tag" style="background:var(--${k}-bg); color:var(--${k});">${escapeHtml(clsLabel(k))}</span></td><td class="pct-cell">${escapeHtml(monthLabel(s.peak))}</td>`;
      },
    });
    const present = st.groups.filter((g) => g.cur > 0 || g.prev > 0);
    document.getElementById('chtab-share').innerHTML = channelShareHtml(st);
    document.getElementById('chtab-season').innerHTML = `<div class="smap-row smap-head"><span class="smap-name"></span><span class="smap-cells">${
      Array.from({ length: 12 }, (_, i) => `<b>${escapeHtml(monthLabel(i + 1))}</b>`).join('')}</span></div>`
      + present.map((g) => {
        const s = seasons[g.index];
        if (!s) return '';
        const tentative = !s.a.sufficiency.ok;
        return `<div class="smap-row" title="${escapeHtml(clsLabel(s.a.classification.key))}"><span class="smap-name"><i class="chs-dot" style="background:${g.color}"></i>${escapeHtml(chLabel(g.key))}</span><span class="smap-cells">${
          s.a.seasonal.map((x) => `<i class="${x.month === s.peak ? 'is-peak' : ''}" style="background:${(tentative ? null : heatBg(x.index)) || 'var(--line-soft)'}" title="${escapeHtml(monthLabel(x.month) + ' ' + fmtPct(x.index, 0))}"></i>`).join('')}</span></div>`;
      }).join('');
    renderChannelMovers(scoped, last);
  }

  // Products whose sales in one group moved most (in yen) against the 12 月度 before.
  function renderChannelMovers(products, last) {
    const gi = CHANNEL_GROUPS.findIndex((g) => g.key === chTabGroup);
    const picker = document.getElementById('chtab-groups');
    picker.innerHTML = CHANNEL_GROUPS.map((g) => `<button type="button" class="month-btn${g.key === chTabGroup ? ' is-active' : ''}" data-g="${g.key}">${escapeHtml(chLabel(g.key))}</button>`).join('');
    picker.querySelectorAll('.month-btn').forEach((b) => b.addEventListener('click', () => { chTabGroup = b.dataset.g; renderChannelMovers(products, last); }));
    const from12 = shiftYm(last, -11), from24 = shiftYm(last, -23);
    const items = products.map((p) => {
      let cur = 0, prev = 0, all = 0;
      p.rows.forEach((r) => {
        if (!r.ch || r.ymKey > last || r.ymKey < from24) return;
        const v = chGroups(r.ch)[gi];
        if (r.ymKey >= from12) { cur += v; all += r.sales; } else prev += v;
      });
      return { name: p.name, cur, prev, diff: cur - prev, yoy: prev > 0 ? cur / prev - 1 : null, share: all > 0 ? cur / all : null };
    }).filter((x) => Math.max(x.cur, x.prev) >= 1000000 && x.diff !== 0);
    items.sort((a, b) => b.diff - a.diff);
    document.querySelector('#chtab-movers tbody').innerHTML = items.map((x) => `
      <tr data-name="${escapeHtml(x.name)}"><td class="name-cell">${escapeHtml(x.name)}</td>
        <td class="pct-cell">${fmtCompactYen(x.cur)}</td><td class="pct-cell">${fmtCompactYen(x.prev)}</td>
        <td class="pct-cell"><span class="${x.diff >= 0 ? 'up' : 'down'}">${x.diff >= 0 ? '+' : '−'}${fmtCompactYen(Math.abs(x.diff))}</span></td>
        <td class="pct-cell">${x.yoy != null ? fmtSignedPct(x.yoy, 0) : '—'}</td>
        <td class="pct-cell">${x.share != null ? fmtPct(x.share, 0) : '—'}</td></tr>`).join('');
    const up = items.filter((x) => x.diff > 0).slice(0, 15);
    const down = items.filter((x) => x.diff < 0).reverse().slice(0, 15);
    const max = Math.max(1, ...[...up, ...down].map((x) => Math.abs(x.diff)));
    const list = (arr, isUp) => (arr.length ? arr.map((x) => `
      <div class="dv-row" data-name="${escapeHtml(x.name)}" title="${escapeHtml(t('ch.moverTip', x.name, fmtCompactYen(x.cur), fmtCompactYen(x.prev), x.share != null ? fmtPct(x.share, 0) : '—'))}">
        <span class="dv-name">${escapeHtml(x.name)}</span>
        <span class="dv-bar"><i class="${isUp ? 'is-up' : 'is-down'}" style="width:${(Math.abs(x.diff) / max * 100).toFixed(1)}%"></i></span>
        <span class="dv-val ${isUp ? 'up' : 'down'}">${isUp ? '+' : '−'}${fmtCompactYen(Math.abs(x.diff))}</span>
        ${growthChip(x.yoy, t('mom.yoyTip'))}
      </div>`).join('') : `<p class="muted-small">${escapeHtml(t('vcal.none'))}</p>`);
    document.getElementById('chtab-up').innerHTML = list(up, true);
    document.getElementById('chtab-down').innerHTML = list(down, false);
    document.querySelectorAll('#view-channels [data-name]').forEach((el) => el.addEventListener('click', () => openProductDetail(el.dataset.name)));
  }
  document.querySelectorAll('.chtab-range-btn').forEach((btn) => btn.addEventListener('click', () => {
    chTabRange = btn.dataset.range;
    document.querySelectorAll('.chtab-range-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderChannelsTab();
  }));

  // ---------------- 勢い: recent sales against what the usual pattern predicts ----------------
  // For the last n 月度 (window) and the 12 月度 before it (base):
  //   level    = Σ base sales ÷ Σ base seasonal index   (deseasonalised monthly level)
  //   予測     = level × Σ window seasonal index
  //   勢い     = Σ window sales ÷ 予測;  前年同期比 = Σ window sales ÷ the same 月度 a year earlier.
  // The seasonal index is the one the 期間 switch gives. Windows end at the latest 月度 loaded.
  let momN = 3;
  let momMin = 1000000;
  let momSortKey = 'ratio';
  let momSortDir = -1;

  function momentumOf(p, n) {
    const a = analysisOf(p);
    const by = new Map(p.rows.map((r) => [r.ymKey, r.sales]));
    const span = (from, len) => Array.from({ length: len }, (_, i) => shiftYm(from, i));
    const win = span(shiftYm(latestAll, -(n - 1)), n);
    const base = span(shiftYm(latestAll, -(n + 11)), 12);
    const idx = (k) => a.seasonal[Number(k.slice(5)) - 1].index;
    const sales = (k) => Math.max(0, by.get(k) || 0);
    const sum = (ks, f) => ks.reduce((s, k) => s + f(k), 0);
    const baseSales = sum(base, sales);
    if (baseSales <= 0) return null;
    const level = baseSales / sum(base, idx);
    const actual = sum(win, sales), expected = level * sum(win, idx);
    const lastYear = sum(win.map((k) => shiftYm(k, -12)), sales);
    const firstSale = (p.rows.find((r) => r.sales > 0) || {}).ymKey;
    return {
      actual, expected, baseSales, level, base, win, idx, sales,
      ratio: expected > 0 ? actual / expected : null,
      yoy: lastYear > 0 ? actual / lastYear - 1 : null,
      // launched inside the base period: the level is understated, so 勢い runs high
      isNew: !firstSale || firstSale > base[0],
    };
  }

  async function renderMomentum() {
    const products = await loadAll();
    const empty = document.getElementById('momentum-empty');
    const scopeBar = document.getElementById('momentum-scope');
    const tbody = document.querySelector('#momentum-table tbody');
    tbody.innerHTML = '';
    if (!products.length) {
      empty.hidden = false;
      scopeBar.innerHTML = '';
      document.getElementById('momentum-count').textContent = '';
      return;
    }
    empty.hidden = true;
    renderScopeBar(scopeBar, products, renderMomentum);
    ensureContext(products);
    document.querySelectorAll('.mom-win-btn').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.n) === momN));
    document.getElementById('momentum-min').value = String(momMin);

    const items = products.filter(inScope).filter(inPeriod).map((p) => {
      const m = momentumOf(p, momN);
      return m && { name: p.name, cls: analysisOf(p).classification.key, ...m };
    }).filter((x) => x && x.baseSales >= momMin);

    const val = (x) => {
      switch (momSortKey) {
        case 'name': return x.name;
        case 'class': return clsLabel(x.cls);
        case 'actual': return x.actual;
        case 'expected': return x.expected;
        case 'yoy': return x.yoy ?? -Infinity;
        default: return x.ratio ?? -Infinity;
      }
    };
    items.sort((a, b) => {
      const av = val(a), bv = val(b);
      return typeof av === 'string' ? momSortDir * av.localeCompare(bv, 'ja') : momSortDir * (av - bv);
    });
    const win = shiftYm(latestAll, -(momN - 1));
    document.getElementById('momentum-count').textContent = t('mom.count', items.length, momN, win, latestAll) + periodNote() + channelNote();
    document.querySelectorAll('#momentum-table th[data-sort]').forEach((th) => {
      const label = th.querySelector('.th-label');
      label.textContent = t(label.dataset.key) + (th.dataset.sort === momSortKey ? (momSortDir === 1 ? ' ▲' : ' ▼') : '');
    });

    tbody.innerHTML = items.map((x) => `
      <tr data-name="${escapeHtml(x.name)}">
        <td class="name-cell">${escapeHtml(x.name)}${x.isNew ? ` <span class="class-tag ended-tag" title="${escapeHtml(t('mom.newTitle'))}">${escapeHtml(t('mom.newTag'))}</span>` : ''}</td>
        <td><span class="class-tag" style="background:var(--${x.cls}-bg); color:var(--${x.cls});">${escapeHtml(clsLabel(x.cls))}</span></td>
        <td class="pct-cell">${fmtCompactYen(x.actual)}</td>
        <td class="pct-cell">${fmtCompactYen(x.expected)}</td>
        <td class="pct-cell"><b class="${x.ratio >= 1 ? 'up' : 'down'}">${x.ratio != null ? fmtPct(x.ratio, 0) : '—'}</b></td>
        <td class="pct-cell">${x.yoy != null ? `<span class="${x.yoy >= 0 ? 'up' : 'down'}">${fmtSignedPct(x.yoy, 0)}</span>` : '—'}</td>
      </tr>`).join('');
    tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openProductDetail(tr.dataset.name)));
    document.getElementById('momentum-no-results').hidden = items.length > 0;
    if (isVisual()) renderMomentumVisual(items);
  }

  // Actual (solid) against expected (dashed) over the base and the window (shaded).
  function momentumSpark(m, w, h) {
    const ks = [...m.base, ...m.win];
    const act = ks.map(m.sales), exp = ks.map((k) => m.level * m.idx(k));
    const max = Math.max(...act, ...exp, 1);
    const step = w / (ks.length - 1);
    const X = (i) => i * step, Y = (v) => h - 2 - (v / max) * (h - 4);
    const pts = (vals) => vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const xs = Math.max(0, X(m.base.length) - step / 2);
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" height="${h}">
      <rect x="${xs.toFixed(1)}" y="0" width="${(w - xs).toFixed(1)}" height="${h}" fill="var(--seasonal-bg)"></rect>
      <polyline points="${pts(exp)}" fill="none" stroke="var(--ink-soft)" stroke-width="1.2" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"></polyline>
      <polyline points="${pts(act)}" fill="none" stroke="var(--ink)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline>
    </svg>`;
  }

  function renderMomentumVisual(items) {
    const ranked = items.filter((x) => !x.isNew && x.ratio != null);
    const up = ranked.filter((x) => x.ratio >= 1).sort((a, b) => b.ratio - a.ratio).slice(0, 20);
    const down = ranked.filter((x) => x.ratio < 1).sort((a, b) => a.ratio - b.ratio).slice(0, 20);
    // bars on a log scale, so ×2 and ×½ are the same length; capped at ×8 / ⅛ so a product
    // that stopped selling doesn't squash every other bar
    const dev = (x) => Math.min(3, Math.abs(Math.log2(Math.max(x.ratio, 1e-3))));
    const maxDev = Math.max(0.3, ...[...up, ...down].map(dev));
    const list = (arr, isUp) => (arr.length ? arr.map((x) => `
      <div class="mom-row" data-name="${escapeHtml(x.name)}" title="${escapeHtml(t('mom.rowTip', x.name, fmtCompactYen(x.actual), fmtCompactYen(x.expected)))}">
        <span class="dv-name">${escapeHtml(x.name)}</span>
        <span class="dv-bar"><i class="${isUp ? 'is-up' : 'is-down'}" style="width:${Math.min(100, dev(x) / maxDev * 100).toFixed(1)}%"></i></span>
        <span class="dv-val ${isUp ? 'up' : 'down'}">${fmtPct(x.ratio, 0)}</span>
        ${growthChip(x.yoy, t('mom.yoyTip'))}
        ${momentumSpark(x, 120, 24)}
      </div>`).join('') : `<p class="muted-small">${escapeHtml(t('vcal.none'))}</p>`);
    document.getElementById('mom-up').innerHTML = list(up, true);
    document.getElementById('mom-down').innerHTML = list(down, false);
    document.querySelectorAll('#momentum-visual .mom-row').forEach((el) => el.addEventListener('click', () => openProductDetail(el.dataset.name)));
  }

  document.querySelectorAll('.mom-win-btn').forEach((btn) => btn.addEventListener('click', () => {
    momN = Number(btn.dataset.n);
    renderMomentum();
  }));
  document.getElementById('momentum-min').addEventListener('change', (e) => {
    momMin = Number(e.target.value);
    renderMomentum();
  });
  document.querySelectorAll('#momentum-table th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (momSortKey === key) momSortDir *= -1;
    else { momSortKey = key; momSortDir = key === 'name' || key === 'class' ? 1 : -1; }
    renderMomentum();
  }));

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Re-render dynamically-built content (tables, charts, lists) on language
  // change — static text is handled by I18N's own data-i18n pass. Detail-page
  // content is only re-rendered if that view is currently visible, so a
  // language switch never force-navigates the user back to a product they
  // already left.
  document.addEventListener('langchange', () => {
    closePopover();
    renderProductsList();
    renderCalendar();
    renderNotesView();
    if (document.getElementById('view-momentum').classList.contains('is-active')) renderMomentum();
    if (document.getElementById('view-channels').classList.contains('is-active')) renderChannelsTab();
    fillChannelSelect();
    if (currentProduct && document.getElementById('view-detail').classList.contains('is-active')) {
      renderProductDetailContent(currentProduct);
    }
  });

  // init
  renderProductsList();
})();
