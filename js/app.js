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
  const analysisCache = new Map();
  function ensureContext(products) {
    const sig = products.length + '|' + products.reduce((m, p) => (p.lastUpdatedAt > m ? p.lastUpdatedAt : m), '');
    if (sig === analysisSig && analysisCtx) return;
    const bundle = products.filter((p) => acctKey(p) === '商品売上高');
    const manual = products.filter((p) => acctKey(p) === ACCT_MANUAL);
    analysisCtx = SalesStats.buildContext(bundle.length ? bundle : (manual.length ? manual : products));
    analysisSig = sig;
    analysisCache.clear();
  }
  function analysisOf(p) {
    const key = p.name + '|' + p.lastUpdatedAt;
    if (!analysisCache.has(key)) analysisCache.set(key, SalesStats.analyze(p.rows, analysisCtx, p.name));
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
    const products = await SalesDB.getAll();
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
    const scoped = products.filter(inScope);
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

    countEl.textContent = t('products.count', filtered.length, products.length);
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
    const record = await SalesDB.get(name);
    if (!record) return;
    ensureContext(await SalesDB.getAll());
    currentProduct = record;
    showView('detail');
    renderProductDetailContent(record);
  }

  // Renders detail content for a record WITHOUT navigating — used both by
  // openProductDetail() and by the language-change re-render, since the
  // latter must not force-switch the view if the user is on another tab.
  function renderProductDetailContent(record) {
    const analysis = analysisOf(record);

    document.getElementById('detail-title').textContent = record.name;
    const first = record.rows[0], last = record.rows[record.rows.length - 1];
    document.getElementById('detail-sub').textContent =
      t('detail.sub', first.ymKey, last.ymKey, record.sourceFileName)
      + (record.accounting !== undefined ? t('detail.subMeta', acctLabel(acctKey(record)), isActive(record)) : '');

    const cls = analysis.classification;
    const badge = document.getElementById('detail-classification-badge');
    badge.textContent = clsLabel(cls.key);
    badge.style.color = `var(--${cls.key})`;
    document.getElementById('detail-classification-text').textContent = clsText(cls.key);
    document.getElementById('detail-eta2').textContent = fmtOmega(analysis);
    document.getElementById('detail-fval').textContent = analysis.sufficiency.ok ? fmtP(analysis.test.p) : '—';
    document.getElementById('detail-span').textContent = t('detail.monthsUnit', record.rows.length);
    renderReliability(analysis);

    renderSeasonalBars(analysis);
    renderYoyTable(analysis.yoy);
    renderSpikeList('spike-list', analysis.spikes, true, true);
    renderSpikeList('dip-list', analysis.dips, false, false);
    renderRawTable(record.rows);
    renderSkuTable(record);
    initTrendSection(record.rows, record.name);
  }

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
    })).sort((a, b) => (b.sales12 - a.sales12) || (b.total - a.total));
    document.getElementById('sku-count').textContent = t('detail.skuCount', rows.length, rows.filter((r) => r.active).length);
    document.querySelector('#sku-table tbody').innerHTML = rows.map((r) => `
      <tr>
        <td class="mono-cell">${escapeHtml(r.code)}</td>
        <td>${escapeHtml(r.name)}${r.active ? '' : ` <span class="class-tag ended-tag">${escapeHtml(t('products.endedTag'))}</span>`}</td>
        <td class="pct-cell">${r.sales12 ? fmtYen(r.sales12) : '—'}</td>
        <td class="pct-cell">${fmtYen(r.total)}</td>
        <td class="pct-cell">${r.last}</td>
      </tr>`).join('');
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
    let reason;
    if (!s.ok) reason = t('rel.reasonInsufficient', C.minMonths, C.minPerMonth);
    else if (a.test.p == null) reason = t('rel.reasonNoTest');
    else if (a.test.p < C.alpha) reason = t('rel.reasonSeasonal', fmtP(a.test.p), fmtOmega(a));
    else reason = t('rel.reasonNotSeasonal', fmtP(a.test.p));
    if (a.spiky && s.ok) reason += ' ' + t('rel.reasonSpiky', a.spikeCount, s.years);
    const box = document.getElementById('detail-reliability');
    box.classList.toggle('is-weak', !s.ok);
    box.innerHTML = `
      <h4>${escapeHtml(t('rel.heading'))}</h4>
      <dl class="stat-row">${rows.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>
      <p class="rel-reason">${escapeHtml(reason)}</p>
    `;
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
      if (currentProduct) renderTrendChart(currentProduct.rows);
    });
  });

  document.getElementById('trend-year-select').addEventListener('change', (e) => {
    trendYear = Number(e.target.value);
    if (currentProduct) renderTrendChart(currentProduct.rows);
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
    items.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'spike-item';

      const main = document.createElement('div');
      main.className = 'spike-item-main';
      main.innerHTML = `
        <div>
          <div class="ym">${r.ymKey}</div>
          ${withFactor ? `<div class="factor">${escapeHtml(factorLabel(r.factorKey))}</div>` : ''}
        </div>
        <div class="ratio ${r.ratio >= 1 ? 'up' : 'down'}">${fmtPct(r.ratio, 0)}</div>
      `;
      li.appendChild(main);

      if (withFactor && currentProduct && currentProduct.skus && currentProduct.skus.length) {
        const drivers = topSkusFor(currentProduct, r.ymKey, 3);
        if (drivers.length) {
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
        <td>${r.ymKey}</td><td>${fmtYen(r.sales)}</td><td>${fmtInt(r.qty)}</td>
        <td>${fmtInt(r.orderCount)}</td><td>${r.orders != null ? fmtInt(r.orders) : '—'}</td><td>${fmtInt(r.totalCustomers)}</td>
        <td>${fmtInt(r.newCustomers)}</td><td>${fmtInt(r.existingCustomers)}</td>
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
    const products = await SalesDB.getAll();
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
    const products = await SalesDB.getAll();
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

    const computed = products.filter(inScope).map((p) => {
      const analysis = analysisOf(p);
      const peak = analysis.seasonal.reduce((a, b) => (seasonValue(b) > seasonValue(a) ? b : a));
      return {
        name: p.name,
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

    countEl.textContent = t('calendar.count', filtered.length, products.length);
    noResults.hidden = filtered.length > 0;
    filtered.forEach((c) => tbody.appendChild(buildCalendarRow(c)));
    updateCalendarSortIndicators();
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
  function pctColor(index) {
    if (index == null) return '';
    const t = Math.max(-1, Math.min(1, (index - 1) / 0.5)); // ±50% = full saturation
    if (Math.abs(t) < 0.04) return 'style="color:var(--ink);"'; // essentially 100%, leave neutral
    const bg = t < 0 ? mixHex('#FFFFFF', HEAT_LOW, -t) : mixHex('#FFFFFF', HEAT_HIGH, t);
    const textColor = Math.abs(t) > 0.55 ? '#FFFFFF' : 'var(--ink)';
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

    const products = (await SalesDB.getAll()).filter(inScope);
    let valueList; // [{ value, label }]
    if (colKey === 'name') {
      valueList = products.map((p) => ({ value: p.name, label: p.name })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
    } else {
      const seen = new Map();
      ensureContext(await SalesDB.getAll());
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
    if (currentProduct && document.getElementById('view-detail').classList.contains('is-active')) {
      renderProductDetailContent(currentProduct);
    }
  });

  // init
  renderProductsList();
})();
