// app.js — wires up views, upload handling, and rendering.

(() => {
  const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
  const fmtYen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const fmtPct = (n, digits = 1) => (n * 100).toFixed(digits) + '%';
  const fmtSignedPct = (n, digits = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';

  let currentProduct = null;
  let calendarSortKey = 'eta2';
  let calendarSortDir = -1;
  const calendarFilters = { search: '', classes: new Set(), peakMonth: '', etaMin: 0 };

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
    renderSpikeList('spike-list', analysis.spikes, true);
    renderSpikeList('dip-list', analysis.dips, false);
    renderRawTable(record.rows);
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

  function renderSpikeList(elId, items, withFactor) {
    const list = document.getElementById(elId);
    list.innerHTML = '';
    items.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'spike-item';
      li.innerHTML = `
        <div>
          <div class="ym">${r.ymKey}</div>
          ${withFactor ? `<div class="factor">${escapeHtml(r.factor || '')}</div>` : ''}
        </div>
        <div class="ratio ${r.ratio >= 1 ? 'up' : 'down'}">${fmtPct(r.ratio, 0)}</div>
      `;
      list.appendChild(li);
    });
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
  }

  function applyCalendarFilters(rows) {
    return rows.filter((r) => {
      if (calendarFilters.search && !r.name.toLowerCase().includes(calendarFilters.search.toLowerCase())) return false;
      if (calendarFilters.classes.size > 0 && !calendarFilters.classes.has(r.classification.key)) return false;
      if (calendarFilters.peakMonth && r.peakMonth !== Number(calendarFilters.peakMonth)) return false;
      if (r.eta2 < calendarFilters.etaMin) return false;
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

  function pctColor(index) {
    if (index == null) return '';
    if (index >= 1.15) return 'style="background:var(--seasonal-bg); color:var(--seasonal); font-weight:700;"';
    if (index <= 0.85) return 'style="background:var(--campaign-bg); color:var(--campaign); font-weight:700;"';
    return '';
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

  // ---- calendar filters ----
  const calSearch = document.getElementById('cal-search');
  const calPeakMonth = document.getElementById('cal-peak-month');
  const calEtaMin = document.getElementById('cal-eta-min');
  const calEtaVal = document.getElementById('cal-eta-val');
  const calReset = document.getElementById('cal-filter-reset');

  let searchDebounce = null;
  calSearch.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      calendarFilters.search = calSearch.value.trim();
      renderCalendar();
    }, 150);
  });

  document.querySelectorAll('#cal-class-filter .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const key = chip.dataset.class;
      if (calendarFilters.classes.has(key)) {
        calendarFilters.classes.delete(key);
        chip.classList.remove('is-active');
      } else {
        calendarFilters.classes.add(key);
        chip.classList.add('is-active');
      }
      renderCalendar();
    });
  });

  calPeakMonth.addEventListener('change', () => {
    calendarFilters.peakMonth = calPeakMonth.value;
    renderCalendar();
  });

  calEtaMin.addEventListener('input', () => {
    const pct = Number(calEtaMin.value);
    calendarFilters.etaMin = pct / 100;
    calEtaVal.textContent = pct + '%';
    renderCalendar();
  });

  calReset.addEventListener('click', () => {
    calendarFilters.search = '';
    calendarFilters.classes.clear();
    calendarFilters.peakMonth = '';
    calendarFilters.etaMin = 0;
    calSearch.value = '';
    calPeakMonth.value = '';
    calEtaMin.value = 0;
    calEtaVal.textContent = '0%';
    document.querySelectorAll('#cal-class-filter .chip').forEach((c) => c.classList.remove('is-active'));
    renderCalendar();
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // init
  renderProductsList();
})();
