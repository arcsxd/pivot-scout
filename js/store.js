// Armazenamento local no celular (IndexedDB): pontos e sessão.
const DB_NAME = 'pivot-scout';
const DB_VERSION = 1;
let dbPromise;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('points')) db.createObjectStore('points', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function run(storeName, mode, fn) {
  dbPromise ||= openDB();
  return dbPromise.then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        let out;
        if (req) req.onsuccess = () => (out = req.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const kvGet = (k) => run('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => run('kv', 'readwrite', (s) => s.put(v, k));
export const kvDel = (k) => run('kv', 'readwrite', (s) => s.delete(k));

export const putPoint = (p) => run('points', 'readwrite', (s) => s.put(p));
export const getPoints = () => run('points', 'readonly', (s) => s.getAll());
export const deletePoint = (id) => run('points', 'readwrite', (s) => s.delete(id));
