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
  banner.textContent = 'アプリでエラーが発生しました。index.html / css / js のファイルが全て最新版か（新旧混在していないか）確認してください: ' + detail;
}

(() => {
  const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
  const fmtYen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const fmtPct = (n, digits = 1) => (n * 100).toFixed(digits) + '%';
  const fmtSignedPct = (n, digits = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';

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
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.name.endsWith('.xlsx'));
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

  async function handleFiles(files) {
    for (const file of files) {
      try {
        const parsed = await SalesParser.parseWorkbook(file);
        const result = await SalesDB.mergeAndPut({
          name: parsed.name,
          sourceFileName: file.name,
          rows: parsed.rows,
        });

        let msg;
        if (result.isNew) {
          msg = `新規登録：${result.added}ヶ月分を保存しました`;
        } else if (result.added === 0 && result.updated === 0) {
          msg = `変更なし（すでに最新です・${result.unchanged}ヶ月分は一致）`;
        } else {
          const parts = [];
          if (result.added > 0) parts.push(`新規 ${result.added}ヶ月`);
          if (result.updated > 0) parts.push(`更新 ${result.updated}ヶ月`);
          msg = `${parts.join(' / ')} を反映しました`;
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

  let productsSearch = '';
  let productsSortKey = 'name';
  let productsSortDir = 1;

  // ---------------- products list ----------------
  async function renderProductsList() {
    const products = await SalesDB.getAll();
    const tbody = document.querySelector('#products-table tbody');
    const empty = document.getElementById('products-empty');
    const noResults = document.getElementById('products-no-results');
    const countEl = document.getElementById('products-count');
    tbody.innerHTML = '';

    if (products.length === 0) {
      empty.hidden = false;
      noResults.hidden = true;
      countEl.textContent = '';
      return;
    }
    empty.hidden = true;

    const computed = products.map((p) => {
      const analysis = SalesStats.analyze(p.rows);
      const first = p.rows[0], last = p.rows[p.rows.length - 1];
      return {
        name: p.name,
        firstYm: first.ymKey,
        lastYm: last.ymKey,
        months: p.rows.length,
        classification: analysis.classification,
        eta2: analysis.anova.eta2,
        stale: monthsBehind(last.ymKey) >= 2,
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
        case 'class': av = a.classification.label; bv = b.classification.label; break;
        case 'eta2': av = a.eta2; bv = b.eta2; break;
        case 'last': av = a.lastYm; bv = b.lastYm; break;
        default: av = a.name; bv = b.name;
      }
      if (typeof av === 'string') return productsSortDir * av.localeCompare(bv, 'ja');
      return productsSortDir * (av - bv);
    });

    countEl.textContent = `${filtered.length} / ${products.length} 商品を表示中`;
    noResults.hidden = filtered.length > 0;

    filtered.forEach((p) => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      const staleTag = p.stale
        ? `<span class="class-tag stale-tag" title="最新データが${p.staleBehind}ヶ月前で止まっています">更新推奨</span>`
        : '';
      tr.innerHTML = `
        <td class="name-cell">${escapeHtml(p.name)}</td>
        <td>${p.firstYm} 〜 ${p.lastYm}</td>
        <td class="pct-cell">${p.months}</td>
        <td><span class="class-tag" style="background:var(--${p.classification.key}-bg); color:var(--${p.classification.key});">${p.classification.label}</span></td>
        <td class="pct-cell">${fmtPct(p.eta2)}</td>
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
      else { productsSortKey = key; productsSortDir = 1; }
      renderProductsList();
    });
  });

  // ---------------- product detail ----------------
  async function openProductDetail(name) {
    const record = await SalesDB.get(name);
    if (!record) return;
    currentProduct = record;
    const analysis = SalesStats.analyze(record.rows);

    showView('detail');
    document.getElementById('detail-title').textContent = record.name;
    const first = record.rows[0], last = record.rows[record.rows.length - 1];
    document.getElementById('detail-sub').textContent =
      `${first.ymKey} 〜 ${last.ymKey} ・ 元ファイル: ${record.sourceFileName}`;

    const cls = analysis.classification;
    const badge = document.getElementById('detail-classification-badge');
    badge.textContent = cls.label;
    badge.style.color = `var(--${cls.key})`;
    document.getElementById('detail-classification-text').textContent = cls.text;
    document.getElementById('detail-eta2').textContent = fmtPct(analysis.anova.eta2);
    document.getElementById('detail-fval').textContent =
      analysis.anova.F != null ? `${analysis.anova.F.toFixed(2)} (${analysis.anova.dfBetween}, ${analysis.anova.dfWithin})` : '—';
    document.getElementById('detail-span').textContent = `${record.rows.length}ヶ月分`;

    renderSeasonalBars(analysis.seasonal);
    renderYoyTable(analysis.yoy);
    renderSpikeList('spike-list', analysis.spikes, true, true);
    renderSpikeList('dip-list', analysis.dips, false, false);
    renderRawTable(record.rows);
    initTrendSection(record.rows);
  }

  function renderSeasonalBars(seasonal) {
    const wrap = document.getElementById('seasonal-bars');
    wrap.innerHTML = '';
    const maxIdx = Math.max(...seasonal.map((s) => s.index || 0), 1);
    seasonal.forEach((s) => {
      const col = document.createElement('div');
      col.className = 'season-col';
      const heightPct = s.index != null ? Math.max(4, (s.index / maxIdx) * 100) : 2;
      const cls = s.index == null ? '' : (s.index >= 1 ? 'above' : 'below');
      col.innerHTML = `
        <span class="season-val">${s.index != null ? fmtPct(s.index, 0) : '—'}</span>
        <div class="season-bar-track"><div class="season-bar ${cls}" style="height:${heightPct}%"></div></div>
        <span class="season-label">${s.label}</span>
      `;
      wrap.appendChild(col);
    });
  }

  function fmtManYen(n) {
    if (Math.abs(n) < 10000) return fmtYen(n);
    const man = n / 10000;
    return (man >= 100 ? Math.round(man) : man.toFixed(1)) + '万円';
  }

  let trendMode = 'all';
  let trendYear = null;

  function initTrendSection(rows) {
    trendMode = 'all';
    document.querySelectorAll('.trend-mode-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === 'all'));

    const years = Array.from(new Set(rows.map((r) => r.year))).sort((a, b) => a - b);
    const yearSelect = document.getElementById('trend-year-select');
    yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}年</option>`).join('');
    trendYear = years[years.length - 1];
    yearSelect.value = trendYear;
    yearSelect.hidden = true;

    renderTrendChart(rows);
  }

  document.querySelectorAll('.trend-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      trendMode = btn.dataset.mode;
      document.querySelectorAll('.trend-mode-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
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
        <span>最高: ${fmtYen(maxV)}</span>
        <span>最低: ${fmtYen(minV)}</span>
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
    wrap.className = 'seasonal-bars';
    for (let m = 1; m <= 12; m++) {
      const v = byMonth[m];
      const heightPct = v != null ? Math.max(3, (v / maxV) * 100) : 2;
      const col = document.createElement('div');
      col.className = 'season-col';
      col.innerHTML = `
        <span class="season-val">${v != null ? fmtManYen(v) : '—'}</span>
        <div class="season-bar-track"><div class="season-bar trend" style="height:${heightPct}%"></div></div>
        <span class="season-label">${m}月</span>
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
      const yoyCell = y.yoy == null ? '—' : `<span class="${y.yoy >= 0 ? 'up' : 'down'}">${fmtSignedPct(y.yoy)}</span>`;
      tr.innerHTML = `<td>${y.year}</td><td>${fmtYen(y.avg)}</td><td>${yoyCell}</td>`;
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
          ${withFactor ? `<div class="factor">${escapeHtml(r.factor || '')}</div>` : ''}
        </div>
        <div class="ratio ${r.ratio >= 1 ? 'up' : 'down'}">${fmtPct(r.ratio, 0)}</div>
      `;
      li.appendChild(main);

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
      editBtn.textContent = 'メモを編集';
      editBtn.addEventListener('click', () => renderNoteEdit(wrap, ymKey, note));
      wrap.appendChild(p);
      wrap.appendChild(editBtn);
    } else {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'spike-note-toggle';
      addBtn.textContent = '+ メモを追加';
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
    textarea.placeholder = 'このスパイクに心当たりがあれば記録してください（例：キャンペーン名、実施理由など）';
    textarea.value = note;

    const actions = document.createElement('div');
    actions.className = 'spike-note-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'spike-note-save';
    saveBtn.textContent = '保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'spike-note-cancel';
    cancelBtn.textContent = 'キャンセル';

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中...';
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
        <td>${fmtInt(r.orderCount)}</td><td>${fmtInt(r.totalCustomers)}</td>
        <td>${fmtInt(r.newCustomers)}</td><td>${fmtInt(r.existingCustomers)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  document.getElementById('delete-product').addEventListener('click', async () => {
    if (!currentProduct) return;
    if (!confirm(`「${currentProduct.name}」のデータを削除しますか？この操作は取り消せません。`)) return;
    await SalesDB.remove(currentProduct.name);
    currentProduct = null;
    showView('products');
    renderProductsList();
  });

  // ---------------- calendar ----------------
  async function renderCalendar() {
    const products = await SalesDB.getAll();
    const empty = document.getElementById('calendar-empty');
    const noResults = document.getElementById('calendar-no-results');
    const countEl = document.getElementById('calendar-count');
    const tbody = document.querySelector('#calendar-table tbody');
    tbody.innerHTML = '';

    if (products.length === 0) {
      empty.hidden = false;
      noResults.hidden = true;
      countEl.textContent = '';
      return;
    }
    empty.hidden = true;

    const computed = products.map((p) => {
      const analysis = SalesStats.analyze(p.rows);
      const withIdx = analysis.seasonal.filter((s) => s.index != null);
      const peak = withIdx.length ? withIdx.reduce((a, b) => (b.index > a.index ? b : a)) : null;
      return {
        name: p.name,
        seasonal: analysis.seasonal,
        classification: analysis.classification,
        eta2: analysis.anova.eta2,
        peakMonth: peak ? peak.month : null,
      };
    });

    const filtered = applyCalendarFilters(computed);
    sortCalendarRows(filtered);

    countEl.textContent = `${filtered.length} / ${products.length} 商品を表示中`;
    noResults.hidden = filtered.length > 0;
    filtered.forEach((c) => tbody.appendChild(buildCalendarRow(c)));
    updateCalendarSortIndicators();
  }

  const CAL_HEADER_LABELS = {
    name: '商品名', class: '判定', eta2: '季節の影響',
    m1: '1月', m2: '2月', m3: '3月', m4: '4月', m5: '5月', m6: '6月',
    m7: '7月', m8: '8月', m9: '9月', m10: '10月', m11: '11月', m12: '12月',
  };

  function updateCalendarSortIndicators() {
    document.querySelectorAll('#calendar-table th[data-sort]').forEach((th) => {
      const key = th.dataset.sort;
      const base = CAL_HEADER_LABELS[key] || '';
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
      else if (calendarSortKey === 'class') { av = a.classification.label; bv = b.classification.label; return calendarSortDir * av.localeCompare(bv, 'ja'); }
      else {
        const idx = parseInt(calendarSortKey.replace('m', ''), 10) - 1;
        av = a.seasonal[idx].index ?? -1;
        bv = b.seasonal[idx].index ?? -1;
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

  function buildCalendarRow(c) {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    const monthCells = c.seasonal.map((s) => {
      const isPeak = s.index != null && s.month === c.peakMonth;
      const peakMark = isPeak ? ' ★' : '';
      return `<td class="pct-cell" ${pctColor(s.index)}>${s.index != null ? fmtPct(s.index, 0) + peakMark : '—'}</td>`;
    }).join('');
    tr.innerHTML = `
      <td class="name-cell">${escapeHtml(c.name)}</td>
      ${monthCells}
      <td><span class="class-tag" style="background:var(--${c.classification.key}-bg); color:var(--${c.classification.key});">${c.classification.label}</span></td>
      <td class="pct-cell">${fmtPct(c.eta2)}</td>
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

    const products = await SalesDB.getAll();
    let valueList; // [{ value, label }]
    if (colKey === 'name') {
      valueList = products.map((p) => ({ value: p.name, label: p.name })).sort((a, b) => a.label.localeCompare(b.label, 'ja'));
    } else {
      const seen = new Map();
      products.forEach((p) => {
        const a = SalesStats.analyze(p.rows);
        seen.set(a.classification.key, a.classification.label);
      });
      valueList = Array.from(seen, ([value, label]) => ({ value, label }));
    }

    const activeSet = calendarColumnFilters[colKey]; // null = all shown/checked
    const pop = document.createElement('div');
    pop.className = 'col-filter-popover';

    const searchHtml = colKey === 'name' ? `<input type="text" class="col-filter-search" placeholder="検索..." />` : '';
    pop.innerHTML = `
      ${searchHtml}
      <div class="col-filter-actions">
        <button type="button" data-act="all">すべて選択</button>
        <button type="button" data-act="none">すべて解除</button>
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

  // init
  renderProductsList();
})();
