// i18n.js — translation dictionary + language switching.
// Loaded before app.js. Exposes: t(key), setLang(lang), getLang(),
// applyStaticTranslations(). Persists the chosen language in localStorage
// (this is a standalone static site, not a Claude artifact, so localStorage
// is the right tool here). Dispatches a 'langchange' event on <body> so
// app.js can re-render dynamically-built content (tables, charts, lists)
// that isn't covered by static data-i18n attributes.

const I18N_DICT = {
  ja: {
    'app.title': 'Total Health Design Sales Ledger',
    'app.subtitle': '商品別 季節性・トレンド分析',
    'app.docTitle': '商品売上分析 | THD Sales Ledger',

    'nav.upload': 'アップロード',
    'nav.products': '商品一覧',
    'nav.calendar': '季節カレンダー',
    'nav.notes': 'メモ',

    'upload.heading': 'ファイルを追加',
    'upload.hint': '商品ごとの売上エクスポート（.xlsx）をドラッグ＆ドロップ、または選択してください。下記のテンプレート形式に対応しています。',
    'upload.dzTitle': 'ここにファイルをドロップ',
    'upload.dzSub': 'または クリックして選択（複数可）',
    'upload.templateHeading': '対応フォーマット（列見出しは固定です）',
    'upload.templateDesc': '以下7つの列見出しを含むシートを読み取ります。列の順番は自由ですが、<strong>見出しの文字列は完全一致</strong>している必要があります。シート名がそのまま商品名として登録されます。',
    'upload.thYm': '月別推移', 'upload.thSales': '売上金額', 'upload.thQty': '購入個数', 'upload.thOrders': '購入件数',
    'upload.thTotalCust': '総顧客数', 'upload.thNewCust': '新規顧客数', 'upload.thExistCust': '既存顧客数',
    'upload.note1': '年月列（月別推移）は「YY_MM」形式です（例：17_07 = 2017年7月）',
    'upload.note2': '見出し行はシートの先頭5行以内にある必要があります',
    'upload.note3': 'シート名がそのまま商品名になります（シート名が既定の「Sheet1」のままの場合はファイル名を使用）',
    'upload.newProduct': (n) => `新規登録：${n}ヶ月分を保存しました`,
    'upload.noChange': (n) => `変更なし（すでに最新です・${n}ヶ月分は一致）`,
    'upload.addedMonths': (n) => `新規 ${n}ヶ月`,
    'upload.updatedMonths': (n) => `更新 ${n}ヶ月`,
    'upload.appliedSuffix': (parts) => `${parts} を反映しました`,

    'products.heading': '商品一覧',
    'products.hint': '保存済みの商品データ。行をクリックで詳細な季節性分析を表示します。',
    'products.searchLabel': '商品名で検索',
    'products.searchPlaceholder': '商品名...',
    'products.emptyTitle': 'まだデータがありません',
    'products.emptySub': '「アップロード」タブからファイルを追加してください。',
    'products.noResultsTitle': '条件に一致する商品がありません',
    'products.noResultsSub': '検索語を変えてみてください。',
    'products.thName': '商品名', 'products.thSpan': 'データ期間', 'products.thMonths': 'ヶ月数',
    'products.thClass': '判定', 'products.thEta2': '季節の影響', 'products.thLast': '最終データ月',
    'products.count': (shown, total) => `${shown} / ${total} 商品を表示中`,
    'products.dateRange': (first, last) => `${first} 〜 ${last}`,
    'products.staleTag': '更新推奨',
    'products.staleTitle': (n) => `最新データが${n}ヶ月前で止まっています`,

    'detail.back': '← 商品一覧へ',
    'detail.deleteBtn': 'この商品データを削除',
    'detail.printBtn': '🖨 印刷 / PDF保存',
    'detail.deleteConfirm': (name) => `「${name}」のデータを削除しますか？この操作は取り消せません。`,
    'detail.sub': (first, last, file) => `${first} 〜 ${last} ・ 元ファイル: ${file}`,
    'detail.judgement': '判定',
    'detail.eta2Label': 'η²（月要因の説明力）',
    'detail.fValueLabel': 'F値（自由度）',
    'detail.spanLabel': 'データ期間',
    'detail.monthsUnit': (n) => `${n}ヶ月分`,
    'detail.seasonalHeading': '月別季節指数（その年平均を100%とした場合）',
    'detail.trendHeading': '売上推移',
    'detail.trendAll': '全期間',
    'detail.trendYear': '年別',
    'detail.trendHigh': '最高',
    'detail.trendLow': '最低',
    'detail.yoyHeading': '年別平均売上・前年比',
    'detail.thYear': '年', 'detail.thAvgSales': '月平均売上', 'detail.thYoy': '対前年比',
    'detail.spikesHeading': 'スパイク上位',
    'detail.spikesSub': '（対年平均比が高い順）',
    'detail.dipsHeading': '下位月',
    'detail.dipsSub': '（対年平均比が低い順）',
    'detail.addNote': '+ メモを追加',
    'detail.editNote': 'メモを編集',
    'detail.save': '保存',
    'detail.saving': '保存中...',
    'detail.cancel': 'キャンセル',
    'detail.notePlaceholder': 'このスパイクに心当たりがあれば記録してください（例：キャンペーン名、実施理由など）',
    'detail.rawHeading': '月別実績',
    'detail.thRawYm': '年月', 'detail.thRawSales': '売上金額', 'detail.thRawQty': '購入個数', 'detail.thRawOrders': '購入件数',
    'detail.thRawTotalCust': '総顧客数', 'detail.thRawNewCust': '新規顧客数', 'detail.thRawExistCust': '既存顧客数',
    'detail.yearOption': (y) => `${y}年`,

    'calendar.heading': '季節カレンダー',
    'calendar.hint': '全商品の月別季節指数を並べた一覧。η²が高い（季節性主導型）ほど濃く色付けしています（▲=平均超・▼=平均未満）。列見出しクリックで並び替え、▾アイコンで絞り込み（Excelのフィルターと同じ要領です）。',
    'calendar.emptyTitle': '比較できる商品がありません',
    'calendar.emptySub': '2つ以上の商品データをアップロードすると一覧表示されます。',
    'calendar.noResultsTitle': '条件に一致する商品がありません',
    'calendar.noResultsSub': 'フィルター条件を変えてみてください。',
    'calendar.thName': '商品名', 'calendar.thClass': '判定', 'calendar.thEta2': '季節の影響',
    'calendar.count': (shown, total) => `${shown} / ${total} 商品を表示中`,
    'calendar.filterAll': 'すべて選択',
    'calendar.filterNone': 'すべて解除',
    'calendar.filterSearchPlaceholder': '検索...',
    'calendar.filterTitle': '絞り込み',

    'notes.heading': 'メモ一覧',
    'notes.hint': '全商品に記録したメモの一覧です。スパイク上位圏外になったメモもここで確認できます。',
    'notes.searchLabel': 'メモ・商品名で検索',
    'notes.searchPlaceholder': '検索...',
    'notes.emptyTitle': 'まだメモがありません',
    'notes.emptySub': '商品詳細ページのスパイク上位からメモを追加できます。',
    'notes.noResultsTitle': '条件に一致するメモがありません',
    'notes.noResultsSub': '検索語を変えてみてください。',
    'notes.thProduct': '商品名', 'notes.thYm': '年月', 'notes.thNote': 'メモ', 'notes.thRatio': '対年平均比',
    'notes.count': (shown, total) => `${shown} / ${total} 件のメモを表示中`,

    'notesView.list': '一覧',
    'notesView.calendar': '月別',
    'notesCal.hint': '同じ月に複数の商品でメモがある場合はハイライトされます（会社全体の施策の可能性）。',
    'notesCal.noEntries': 'メモなし',
    'notesCal.productCount': (n) => `${n}商品でメモあり`,

    'classification.seasonal.label': '季節性主導型',
    'classification.seasonal.text': '月の要因（季節性）で売上の変動の大部分を説明できます。毎年同じ時期に繰り返す傾向が強いタイプです。',
    'classification.mixed.label': '混合型（季節性＋単発要因）',
    'classification.mixed.text': '月の要因である程度は説明できますが、単発のキャンペーン等の影響も無視できません。両方を要因として管理する必要があります。',
    'classification.campaign.label': 'キャンペーン/イベント主導型',
    'classification.campaign.text': '月による説明力は小さく、特定の施策・キャンペーンなど単発要因が売上変動の主因である可能性が高いタイプです。',

    'factor.aov_increase': '客単価上昇（まとめ買い等）',
    'factor.repeat_purchase': '既存顧客の再購買',
    'factor.new_customer_growth': '新規顧客の増加',
    'factor.customer_increase': '顧客数の増加',
    'factor.unclear': '要因不明瞭',

    'month.1': '1月', 'month.2': '2月', 'month.3': '3月', 'month.4': '4月',
    'month.5': '5月', 'month.6': '6月', 'month.7': '7月', 'month.8': '8月',
    'month.9': '9月', 'month.10': '10月', 'month.11': '11月', 'month.12': '12月',

    'footer.note': 'データはこのブラウザ内（IndexedDB）に保存されます。他の端末やブラウザとは同期されません。',
    'error.banner': (detail) => `アプリでエラーが発生しました。index.html / css / js のファイルが全て最新版か（新旧混在していないか）確認してください: ${detail}`,
  },

  en: {
    'app.title': 'Total Health Design Sales Ledger',
    'app.subtitle': 'Seasonal & Trend Analysis by Product',
    'app.docTitle': 'Product Sales Analysis | THD Sales Ledger',

    'nav.upload': 'Upload',
    'nav.products': 'Products',
    'nav.calendar': 'Seasonal Calendar',
    'nav.notes': 'Notes',

    'upload.heading': 'Add Files',
    'upload.hint': 'Drag and drop, or select, a per-product sales export (.xlsx). The format below is supported.',
    'upload.dzTitle': 'Drop files here',
    'upload.dzSub': 'or click to select (multiple allowed)',
    'upload.templateHeading': 'Supported format (fixed column headers)',
    'upload.templateDesc': 'The sheet must contain these 7 column headers. Column order is flexible, but <strong>header text must match exactly</strong>. The sheet name is registered as the product name.',
    'upload.thYm': 'Month', 'upload.thSales': 'Sales Amount', 'upload.thQty': 'Qty Sold', 'upload.thOrders': 'Order Count',
    'upload.thTotalCust': 'Total Customers', 'upload.thNewCust': 'New Customers', 'upload.thExistCust': 'Existing Customers',
    'upload.note1': 'The month column uses "YY_MM" format (e.g. 17_07 = July 2017)',
    'upload.note2': 'The header row must be within the first 5 rows of the sheet',
    'upload.note3': 'The sheet name becomes the product name (if the sheet is still named the default "Sheet1", the file name is used instead)',
    'upload.newProduct': (n) => `New: saved ${n} months of data`,
    'upload.noChange': (n) => `No changes (already up to date — ${n} months matched)`,
    'upload.addedMonths': (n) => `${n} new month${n === 1 ? '' : 's'}`,
    'upload.updatedMonths': (n) => `${n} updated month${n === 1 ? '' : 's'}`,
    'upload.appliedSuffix': (parts) => `Applied: ${parts}`,

    'products.heading': 'Products',
    'products.hint': 'Saved product data. Click a row to view its detailed seasonal analysis.',
    'products.searchLabel': 'Search by product name',
    'products.searchPlaceholder': 'Product name...',
    'products.emptyTitle': 'No data yet',
    'products.emptySub': 'Add files from the "Upload" tab.',
    'products.noResultsTitle': 'No products match',
    'products.noResultsSub': 'Try a different search term.',
    'products.thName': 'Product', 'products.thSpan': 'Data Range', 'products.thMonths': 'Months',
    'products.thClass': 'Type', 'products.thEta2': 'Seasonality', 'products.thLast': 'Latest Data',
    'products.count': (shown, total) => `Showing ${shown} / ${total} products`,
    'products.dateRange': (first, last) => `${first} – ${last}`,
    'products.staleTag': 'Needs update',
    'products.staleTitle': (n) => `Latest data is ${n} month${n === 1 ? '' : 's'} old`,

    'detail.back': '← Back to Products',
    'detail.deleteBtn': 'Delete this product',
    'detail.printBtn': '🖨 Print / Save as PDF',
    'detail.deleteConfirm': (name) => `Delete all data for "${name}"? This cannot be undone.`,
    'detail.sub': (first, last, file) => `${first} – ${last} · Source file: ${file}`,
    'detail.judgement': 'Type',
    'detail.eta2Label': 'η² (explanatory power of month)',
    'detail.fValueLabel': 'F value (df)',
    'detail.spanLabel': 'Data range',
    'detail.monthsUnit': (n) => `${n} months of data`,
    'detail.seasonalHeading': 'Monthly Seasonal Index (that year\u2019s average = 100%)',
    'detail.trendHeading': 'Sales Trend',
    'detail.trendAll': 'All Time',
    'detail.trendYear': 'By Year',
    'detail.trendHigh': 'High',
    'detail.trendLow': 'Low',
    'detail.yoyHeading': 'Yearly Average Sales / YoY Change',
    'detail.thYear': 'Year', 'detail.thAvgSales': 'Avg Monthly Sales', 'detail.thYoy': 'YoY',
    'detail.spikesHeading': 'Top Spikes',
    'detail.spikesSub': '(highest vs. year average)',
    'detail.dipsHeading': 'Lowest Months',
    'detail.dipsSub': '(lowest vs. year average)',
    'detail.addNote': '+ Add note',
    'detail.editNote': 'Edit note',
    'detail.save': 'Save',
    'detail.saving': 'Saving...',
    'detail.cancel': 'Cancel',
    'detail.notePlaceholder': 'If you know why this spike happened, record it here (e.g. campaign name, reason)',
    'detail.rawHeading': 'Monthly Data',
    'detail.thRawYm': 'Month', 'detail.thRawSales': 'Sales', 'detail.thRawQty': 'Qty', 'detail.thRawOrders': 'Orders',
    'detail.thRawTotalCust': 'Total Cust.', 'detail.thRawNewCust': 'New Cust.', 'detail.thRawExistCust': 'Existing Cust.',
    'detail.yearOption': (y) => String(y),

    'calendar.heading': 'Seasonal Calendar',
    'calendar.hint': 'All products\u2019 monthly seasonal index side by side. Darker shading = higher η² (more seasonally driven); ▲ = above average, ▼ = below average. Click a column header to sort, or the ▾ icon to filter (works like an Excel filter).',
    'calendar.emptyTitle': 'No products to compare',
    'calendar.emptySub': 'Upload 2 or more products to see this list.',
    'calendar.noResultsTitle': 'No products match',
    'calendar.noResultsSub': 'Try changing the filter conditions.',
    'calendar.thName': 'Product', 'calendar.thClass': 'Type', 'calendar.thEta2': 'Seasonality',
    'calendar.count': (shown, total) => `Showing ${shown} / ${total} products`,
    'calendar.filterAll': 'Select all',
    'calendar.filterNone': 'Clear all',
    'calendar.filterSearchPlaceholder': 'Search...',
    'calendar.filterTitle': 'Filter',

    'notes.heading': 'Notes',
    'notes.hint': 'Every note recorded across all products, including ones for spikes that have since dropped out of the top-10 ranking on their product page.',
    'notes.searchLabel': 'Search notes or product name',
    'notes.searchPlaceholder': 'Search...',
    'notes.emptyTitle': 'No notes yet',
    'notes.emptySub': 'Add notes from the Top Spikes section on a product\u2019s detail page.',
    'notes.noResultsTitle': 'No notes match',
    'notes.noResultsSub': 'Try a different search term.',
    'notes.thProduct': 'Product', 'notes.thYm': 'Month', 'notes.thNote': 'Note', 'notes.thRatio': 'vs. Year Avg',
    'notes.count': (shown, total) => `Showing ${shown} / ${total} notes`,

    'notesView.list': 'List',
    'notesView.calendar': 'By Month',
    'notesCal.hint': 'Months where 2+ products have notes are highlighted \u2014 these may indicate a company-wide campaign.',
    'notesCal.noEntries': 'No notes',
    'notesCal.productCount': (n) => `${n} products noted`,

    'classification.seasonal.label': 'Seasonal-driven',
    'classification.seasonal.text': 'Month explains most of the variation in sales — this product reliably peaks at the same time each year.',
    'classification.mixed.label': 'Mixed (seasonal + one-off factors)',
    'classification.mixed.text': 'Month explains some of the variation, but one-off campaigns or events also play a real role. Worth managing both.',
    'classification.campaign.label': 'Campaign/event-driven',
    'classification.campaign.text': 'Month explains little of the variation — specific promotions or one-off events are likely the main driver of sales swings.',

    'factor.aov_increase': 'Higher order value (bulk buying, etc.)',
    'factor.repeat_purchase': 'Repeat purchases from existing customers',
    'factor.new_customer_growth': 'Growth in new customers',
    'factor.customer_increase': 'Increase in customer count',
    'factor.unclear': 'Unclear cause',

    'month.1': 'Jan', 'month.2': 'Feb', 'month.3': 'Mar', 'month.4': 'Apr',
    'month.5': 'May', 'month.6': 'Jun', 'month.7': 'Jul', 'month.8': 'Aug',
    'month.9': 'Sep', 'month.10': 'Oct', 'month.11': 'Nov', 'month.12': 'Dec',

    'footer.note': 'Data is stored locally in this browser (IndexedDB). It does not sync across devices or browsers.',
    'error.banner': (detail) => `An error occurred. Check that index.html / css / js are all the current version (not a mix of old and new): ${detail}`,
  },
};

const I18N = (() => {
  const STORAGE_KEY = 'thd-sales-ledger-lang';
  let lang = (() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'ja'; } catch (e) { return 'ja'; }
  })();

  function t(key, ...args) {
    const entry = (I18N_DICT[lang] && I18N_DICT[lang][key]) ?? I18N_DICT.ja[key];
    if (entry == null) return key;
    return typeof entry === 'function' ? entry(...args) : entry;
  }

  function getLang() { return lang; }

  function applyStaticTranslations() {
    document.documentElement.lang = lang;
    document.title = t('app.docTitle');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
    document.querySelectorAll('.lang-btn').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.lang === lang));
  }

  function setLang(newLang) {
    if (newLang !== 'ja' && newLang !== 'en') return;
    lang = newLang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
    applyStaticTranslations();
    document.dispatchEvent(new Event('langchange'));
  }

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });
  applyStaticTranslations();

  return { t, getLang, setLang, applyStaticTranslations };
})();
