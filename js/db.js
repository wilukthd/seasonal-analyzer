// db.js — thin IndexedDB wrapper. One object store, keyed by product name.
// Each record: { name, firstUploadedAt, lastUpdatedAt, sourceFileName, rows: [{ymKey, year, month, sales, qty, orderCount, totalCustomers, newCustomers, existingCustomers}] }

const SalesDB = (() => {
  const DB_NAME = 'sales-ledger';
  const DB_VERSION = 1;
  const STORE = 'products';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'name' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function put(record) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function get(name) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(name);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  function rowsEqual(a, b) {
    return a.sales === b.sales && a.qty === b.qty && a.orderCount === b.orderCount
      && a.totalCustomers === b.totalCustomers && a.newCustomers === b.newCustomers
      && a.existingCustomers === b.existingCustomers;
  }

  // Upsert by year-month: re-uploading a product (whether the export is the
  // full history again or just recent months) merges cleanly instead of
  // wholesale replacing. Returns a summary of what changed.
  async function mergeAndPut(incoming) {
    const existing = await get(incoming.name);
    const now = new Date().toISOString();

    if (!existing) {
      const record = {
        name: incoming.name,
        firstUploadedAt: now,
        lastUpdatedAt: now,
        sourceFileName: incoming.sourceFileName,
        rows: incoming.rows,
      };
      await put(record);
      return { record, isNew: true, added: incoming.rows.length, updated: 0, unchanged: 0 };
    }

    const byKey = {};
    existing.rows.forEach((r) => { byKey[r.ymKey] = r; });

    let added = 0, updated = 0, unchanged = 0;
    incoming.rows.forEach((r) => {
      const prev = byKey[r.ymKey];
      if (!prev) added++;
      else if (!rowsEqual(prev, r)) updated++;
      else unchanged++;
      byKey[r.ymKey] = r; // incoming always wins on conflict
    });

    const mergedRows = Object.values(byKey).sort((a, b) => (a.year - b.year) || (a.month - b.month));
    const record = {
      name: existing.name,
      firstUploadedAt: existing.firstUploadedAt || now,
      lastUpdatedAt: now,
      sourceFileName: incoming.sourceFileName,
      rows: mergedRows,
    };
    await put(record);
    return { record, isNew: false, added, updated, unchanged };
  }

  async function remove(name) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { put, mergeAndPut, getAll, get, remove };
})();
