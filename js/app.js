// app.js — wires up views, upload handling, and rendering.

(() => {
  const fmtInt = (n) => Math.round(n).toLocaleString('ja-JP');
  const fmtYen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
  const fmtPct = (n, digits = 1) => (n * 100).toFixed(digits) + '%';
  const fmtSignedPct = (n, digits = 1) => (n >= 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';

  let currentProduct = null;
  let calendarSortKey = 'eta2';
  let calendarSortDir = -1;

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
        const record = {
          name: parsed.name,
          uploadedAt: new Date().toISOString(),
          sourceFileName: file.name,
          rows: parsed.rows,
        };
        await SalesDB.put(record);
        logRow(parsed.name, true, `${parsed.rows.length}件の月次データを保存しました`);
      } catch (err) {
        logRow(file.name, false, err.message || String(err));
      }
    }
  }

  // ---------------- products list ----------------
  async function renderProductsList() {
    const products = await SalesDB.getAll();
    const grid = document.getElementById('products-list');
    const empty = document.getElementById('products-empty');
    grid.innerHTML = '';

    if (products.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    products.sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    products.forEach((p) => {
      const analysis = SalesStats.analyze(p.rows);
      const first = p.rows[0], last = p.rows[p.rows.length - 1];
      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <h3>${escapeHtml(p.name)}</h3>
        <p class="meta">${first.ymKey} 〜 ${last.ymKey}（${p.rows.length}ヶ月）</p>
        <span class="badge ${analysis.classification.key}">${analysis.classification.label}</span>
      `;
      card.addEventListener('click', () => openProductDetail(p.name));
      grid.appendChild(card);
    });
  }

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
    const tbody = document.querySelector('#calendar-table tbody');
    tbody.innerHTML = '';

    if (products.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const computed = products.map((p) => {
      const analysis = SalesStats.analyze(p.rows);
      return { name: p.name, seasonal: analysis.seasonal, classification: analysis.classification, eta2: analysis.anova.eta2 };
    });

    sortCalendarRows(computed);
    computed.forEach((c) => tbody.appendChild(buildCalendarRow(c)));
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
    const monthCells = c.seasonal.map((s) =>
      `<td class="pct-cell" ${pctColor(s.index)}>${s.index != null ? fmtPct(s.index, 0) : '—'}</td>`
    ).join('');
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

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // init
  renderProductsList();
})();
