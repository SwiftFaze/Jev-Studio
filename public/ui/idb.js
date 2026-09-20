// Saved Steam analyses keep the batch of reviews they were saved with here, in the browser's own database (IndexedDB).
// A batch is about 4 KB a review, so 500 of them are over two million characters: far too much for local storage, which
// holds about five million for the whole app, and nothing for a database. Local storage keeps the small record.

const DB_NAME = 'jev-studio';
const STORE = 'steam-saved-batches';

let opened = null;

/** The database, opened once. Rejects where the browser has none (or will not let this page use it). */
function open() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('This browser has no database to keep the reviews in.'));
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opened = null; // try again next time
      reject(request.error ?? new Error('The browser would not open its database.'));
    };
  });
  return opened;
}

/** Run one operation on the store and resolve with its result once the transaction has really finished. */
function run(mode, operation) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = operation(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('The browser stopped saving the reviews.'));
      }),
  );
}

/** Keep a saved analysis's batch under its id, replacing any there. */
export const putBatch = (id, batch) => run('readwrite', (store) => store.put(batch, id));

/** The batch kept under this id, or null if there is none. */
export const getBatch = (id) => run('readonly', (store) => store.get(id)).then((batch) => batch ?? null);

/** Forget the batch kept under this id. */
export const deleteBatch = (id) => run('readwrite', (store) => store.delete(id));
