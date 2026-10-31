# Total Health Design Sales Ledger — 商品別 季節性・トレンド分析

A static web app for uploading per-product sales export files (like `テラクレ.xlsx`),
storing them, and running the same seasonality-vs-campaign analysis you've been doing
by hand — automatically, for every product, in one comparison calendar.

Available in Japanese and English — toggle in the top-right corner. The choice is
remembered (via `localStorage`) for your next visit.

## Loading all products (products.json)

The main input is `products.json`, built monthly by `seasonal\run.ps1` in the kago-analysis
repo: every 中区分 series × 月度 with sales, quantity, lines (購入件数), orders (注文件数),
customers, plus each series' SKUs. Drop it on the Upload tab; all series load in a couple of
seconds and merge by month like any upload, keeping your notes.

- **Never put products.json (or any .xlsx / .csv) in this folder.** This repo goes to GitHub
  Pages, which is public. `.gitignore` blocks those types as a safety net. Load the file from
  the share or from `kago-analysis\seasonal\out\`.
- **Scope bar** (商品一覧 and 季節カレンダー): 会計区分 chips — 商品売上高 and manual
  `.xlsx` uploads are on by default — and a toggle for ended series (no SKU in the current
  中区分 master). The choice is remembered in this browser.
- **SKU drill-down** (detail page): each top spike lists the SKUs that made it, with their
  share of that month; the SKU card lists every SKU with last-12-月度 and all-time sales.
- **SKU filter** (detail page): tick SKUs in the SKU card (or press のみ) and the whole page —
  verdict, seasonal index, trend, spikes, monthly table — is recalculated on just those SKUs.
  Customer counts are only shown for the whole series or a single SKU, because one person
  can buy several SKUs.
- **購入者の内訳** (detail page): buyers each 月度 split into 店舗新規 / 商品初回 (first purchase
  of this series by an existing member) / 継続 (bought within 180 days) / 復帰 (after more
  than 180 days), with the share of newcomers who bought again within 6 月度. A summary
  compares the last 12 月度 with the year before and flags a shrinking buyer base or
  newcomers who stop coming back. Each top spike shows which buyer type grew against the
  12 月度 before it and names the pattern: members reached (magazine / DM type), new shop
  customers (acquisition), usual buyers buying more, or more spend per buyer.
- **月度**: all months are fiscal months (21st of the previous month to the 20th).

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
  product). Toggle to **月別 (By Month)** to group notes by calendar month, ignoring year — any
  month where 2+ different products have notes is highlighted with a product-count badge, since
  that's a signal worth noticing (a recurring, company-wide campaign) that the flat list view
  wouldn't otherwise surface.
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

## Printing / sharing a single product

Each product's detail page has a 🖨 print button. It uses the browser's native print
dialog — "Save as PDF" there gives you a clean, single-product handout without the
navigation, filters, or edit controls, useful for sharing one product's analysis with
a teammate before the team-sharing/backend phase exists.

## Accessibility note on the calendar heat map

The seasonal-index color scale (red = below average, green = above average) is never
the only signal — every colored cell also carries a ▲ (above average) or ▼ (below
average) symbol, so the calendar still reads correctly under red-green color
blindness, not just for typical color vision.

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
    ├── stats.js   # seasonality model, permutation test, shrinkage, spikes (language-agnostic)
    └── app.js     # view routing + rendering
```

## Notes on the analysis method

Adopted 2026-10-31, replacing the VBA macro's ratio-to-year-average + η² method, which
labelled 83–95% of series shorter than four years "季節性主導型" from noise alone.
Settings live in `SalesStats.CONFIG` (`js/stats.js`).

- **Model.** `log(sales) = 年の効果 + 月度の効果 + 誤差`, fitted per series on months with
  sales > 0. Year effects absorb level and trend, so partial years and growth don't distort
  the month pattern. Months with sales ≤ 0 are left out (counted on the detail page).
- **Test.** F for the 月度 effect after year effects; p from a within-year permutation test
  (月度 labels shuffled inside each year, 199 times, seeded per series so it is stable).
  Seasonal if p < 0.05. Strength = **ω²**, a bias-corrected η² (0 for pure noise).
- **データ不足.** No verdict, ω² or p unless ≥ 24 months with sales and every 月度 seen at
  least twice. Those series are tagged データ不足 / 参考 everywhere.
- **Short series borrow strength.** Each 月度 effect is shrunk toward the shop-wide pattern
  (all 商品売上高 + manual series combined): `w = τ² / (τ² + se²)`, τ² estimated from series
  with ≥ 60 months. The detail page shows the own-data weight and a 90% band per 月度.
- **店舗全体比.** Index ÷ shop-wide index: whether a product peaks more than the shop already
  does (the shop runs about ×1.7 in 11月度 and ×2.1 in 12月度).
- **Spikes.** Ranked by robust z (median / MAD) of the model residual, i.e. how far a month
  is from what was expected for that year and 月度; % shown = vs. expected. "Spiky" = at
  least 0.5 spikes (z > 3.5) per year.
- **判定.** 季節性あり / 季節性＋スパイク / スパイク主導 / 季節性なし（安定） / データ不足.
- **Year-on-year** compares only the 月度 present in both years; partial years are labelled.
- **Spike factor diagnosis** (客単価上昇 / 既存顧客の再購買 / 新規顧客の増加) is unchanged: a
  heuristic starting point, not a final answer.

Full rationale and the evaluation on 236 series: `docs/seasonal-stats-proposal.md` in the
kago-analysis repo.
