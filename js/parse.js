// parse.js — turns an uploaded .xlsx File into { name, rows } using SheetJS.
// Looks for a sheet whose header row contains the expected column labels
// (月別推移 / 売上金額 / 購入個数 / 購入件数 / 総顧客数 / 新規顧客数 / 既存顧客数).
// The sheet's own name is used as the product name (falls back to the file name).

const SalesParser = (() => {
  const EXPECTED_HEADERS = ['月別推移', '売上金額', '購入個数', '購入件数', '総顧客数', '新規顧客数', '既存顧客数'];

  function parseYearMonth(raw) {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    const m = s.match(/^(\d{2,4})[_\-\/](\d{1,2})$/);
    if (!m) return null;
    let year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (year < 100) year += 2000;
    if (month < 1 || month > 12) return null;
    return { year, month, ymKey: `${year}-${String(month).padStart(2, '0')}` };
  }

  function findHeaderRow(sheetRows) {
    for (let i = 0; i < Math.min(sheetRows.length, 5); i++) {
      const row = (sheetRows[i] || []).map((c) => (c === null || c === undefined ? '' : String(c).trim()));
      const hits = EXPECTED_HEADERS.filter((h) => row.includes(h)).length;
      if (hits >= 4) return { index: i, row };
    }
    return null;
  }

  async function parseWorkbook(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });

    let best = null;
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
      const header = findHeaderRow(sheetRows);
      if (header) {
        best = { sheetName, sheetRows, header };
        break;
      }
    }

    if (!best) {
      throw new Error('対応する見出し行（月別推移・売上金額など）が見つかりませんでした。');
    }

    const colIndex = {};
    EXPECTED_HEADERS.forEach((h) => { colIndex[h] = best.header.row.indexOf(h); });

    const rows = [];
    for (let i = best.header.index + 1; i < best.sheetRows.length; i++) {
      const r = best.sheetRows[i];
      if (!r || r.every((c) => c === null || c === '')) continue;
      const ym = parseYearMonth(r[colIndex['月別推移']]);
      if (!ym) continue;
      rows.push({
        ymKey: ym.ymKey,
        year: ym.year,
        month: ym.month,
        sales: Number(r[colIndex['売上金額']]) || 0,
        qty: Number(r[colIndex['購入個数']]) || 0,
        orderCount: Number(r[colIndex['購入件数']]) || 0,
        totalCustomers: Number(r[colIndex['総顧客数']]) || 0,
        newCustomers: Number(r[colIndex['新規顧客数']]) || 0,
        existingCustomers: Number(r[colIndex['既存顧客数']]) || 0,
      });
    }

    if (rows.length === 0) {
      throw new Error('見出しは見つかりましたが、月別の行が読み取れませんでした。');
    }

    rows.sort((a, b) => (a.year - b.year) || (a.month - b.month));

    const productName = best.sheetName && best.sheetName.trim() !== 'Sheet1'
      ? best.sheetName.trim()
      : file.name.replace(/\.xlsx$/i, '');

    return { name: productName, rows };
  }

  return { parseWorkbook, parseYearMonth };
})();
