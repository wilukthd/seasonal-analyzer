# Total Health Design Sales Ledger — 商品別 季節性・トレンド分析

A static web app for uploading per-product sales export files (like `テラクレ.xlsx`),
storing them, and running the same seasonality-vs-campaign analysis you've been doing
by hand — automatically, for every product, in one comparison calendar.

Available in Japanese and English — toggle in the top-right corner. The choice is
remembered (via `localStorage`) for your next visit.

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
  cause: 客単価上昇 / 既存顧客の再購買 / 新規顧客の増加, plus a free-text note you can attach
  to any spike — click メモを追加 to record the real reason once you know it, e.g. a
  campaign name), lowest months, and the full raw monthly table.
- **メモ (Notes)** — every note you've recorded across every product, in one searchable, sortable
  table. This is the canonical place to find a note, not just a convenience: if a product gets
  new data and a bigger spike bumps an older noted month out of that product's own top-10 list,
  the note itself is never deleted — it just stops appearing on that product's detail page. This
  view always shows it regardless of current ranking. Search matches both product name and note
  text (e.g. search "campaign" to find every spike you tagged with that reason, across every
  product).
- **季節カレンダー** — every stored product's monthly seasonal index side by side, colour-coded,
  sortable by any month or by η² — this is the automated version of your master Google Sheet.
  Each row's single highest month is marked with a ★. 商品名 and 判定 columns have an
  Excel-style header filter (▾ icon → checklist of values, uncheck what you don't want) —
  click sort headers to order, click ▾ to filter, same as a spreadsheet autofilter.

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

## If something looks broken (blank table, buttons doing nothing)

The app now shows a red banner at the top of the page if any JavaScript error occurs,
instead of failing silently. The most common cause is a **partial deploy** — e.g. an old
`index.html` sitting alongside a newer `app.js` (or vice versa) after only some files got
pushed to the repo. If you see the banner, or a table stays empty with no error banner
(older cached version without this safety net), replace the *entire* `sales-analyzer`
folder in your repo in one go rather than individual files, and hard-refresh the page
(Ctrl/Cmd+Shift+R) to bypass the browser cache.

Notes on spikes are stored per product, keyed by year-month, and are preserved across
re-uploads/merges — re-uploading a product's file never wipes out a note you've already
written on one of its months.

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
    ├── i18n.js    # ja/en translation dictionary + language switching
    ├── db.js      # IndexedDB wrapper
    ├── parse.js   # xlsx → structured rows (SheetJS)
    ├── stats.js   # seasonal index / eta^2 / spike diagnostics (language-agnostic)
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
