# Sales Ledger — 商品別 季節性・トレンド分析

A static web app for uploading per-product sales export files (like `テラクレ.xlsx`),
storing them, and running the same seasonality-vs-campaign analysis you've been doing
by hand — automatically, for every product, in one comparison calendar.

## What it does

- **Upload** — drag & drop `.xlsx` files. It looks for a sheet whose header row contains
  `月別推移 / 売上金額 / 購入個数 / 購入件数 / 総顧客数 / 新規顧客数 / 既存顧客数`, and uses that
  sheet's own name as the product name (falling back to the file name).
- **Store** — parsed data is saved to your browser's IndexedDB. No server, no account.
  Data lives only in the browser/device you uploaded it in.
- **Products** — a sortable, searchable table of everything you've uploaded (商品名 /
  データ期間 / ヶ月数 / 判定 / 季節の影響 / 最終データ月), with a `更新推奨` tag on any
  product whose latest data is 2+ months behind today. Click any row to open its detail.
- **Product detail** — the same analysis your Python script produces per file: η² / F
  statistic, seasonal index bars, year-over-year table, top spikes (with a heuristic
  cause: 客単価上昇 / 既存顧客の再購買 / 新規顧客の増加), lowest months, and the full raw
  monthly table.
- **季節カレンダー** — every stored product's monthly seasonal index side by side, colour-coded,
  sortable by any month or by η² — this is the automated version of your master Google Sheet.
  Each row's single highest month is marked with a ★. Filterable by product name, classification
  (季節性主導型/混合型/キャンペーン・イベント主導型), peak month (e.g. "show everything that
  peaks in December"), and a minimum η² threshold — this is the "find a clue" layer: e.g. set
  peak month = 12 to see every product that spikes around the holidays, or raise the η² minimum
  to isolate your most reliably seasonal SKUs.

## Run it locally

No build step — just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly via `file://` also works in most browsers, but IndexedDB
and the CDN scripts are more reliable over `http://`.)

## Monthly re-uploads

Since sales data piles up month over month, re-uploading a product's file doesn't
overwrite it — it merges by year-month. Whatever export you drop in (whether it's the
full history again, like your current file, or eventually just the newest months), the
upload log tells you exactly what changed: `新規 X ヶ月 / 更新 Y ヶ月`, or `変更なし` if
nothing did. On the 商品一覧 list, any product whose latest month is 2+ months behind
today gets a `更新推奨` tag as a lightweight reminder of what still needs a fresh file.

## Deploy to GitHub Pages

1. Push this folder's contents to a repo (e.g. `sales-ledger`).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` and `/ (root)`.
3. Your app is live at `https://<username>.github.io/sales-ledger/`.

That's it — there's no backend to configure. Every visit re-reads whatever is in that
browser's IndexedDB, so treat the site as a personal tool tied to one browser profile,
not a shared multi-user database.

## Known limitation — storage is per-browser

GitHub Pages only serves static files, so this version stores data in the browser
itself (IndexedDB). That means:

- Data does **not** sync across devices or browsers.
- Clearing site data / browsing history can wipe it (re-upload the source files to restore).
- It's fine for one person's own analysis workflow, which is what v1 is scoped for.

If you outgrow this (need multi-device sync, or want to share the tool with teammates),
the fix is to swap `js/db.js` for calls to a hosted database — e.g. Supabase (free tier,
Postgres + file storage) — while keeping `parse.js` and `stats.js` untouched, since the
parsing and analysis logic doesn't depend on where the data is stored.

## File structure

```
sales-analyzer/
├── index.html
├── css/style.css
└── js/
    ├── db.js      # IndexedDB wrapper
    ├── parse.js   # xlsx → structured rows (SheetJS)
    ├── stats.js   # seasonal index / eta^2 / spike diagnostics
    └── app.js     # view routing + rendering
```

## Notes on the analysis method

`stats.js` mirrors the methodology already in your workbook's `季節性_トレンド分析` sheet:

- Each month's `ratio = sales / that year's average sales`.
- **Seasonal index** = mean ratio for that calendar month across all years.
- **η²** = between-month sum of squares / total sum of squares from a one-way ANOVA of
  ratio grouped by calendar month (F-stat included).
- **Classification thresholds**: η² < 10% → campaign-driven, 10–25% → mixed, ≥ 25% →
  seasonal-driven — matching the guide text in your sheet.
- **Spike factor diagnosis** is a simplified heuristic (average order value vs. baseline,
  customer-count ratio, new-customer share) — treat it as a starting hypothesis, not a
  final answer, same as in your original notes.
