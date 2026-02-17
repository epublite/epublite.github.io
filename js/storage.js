// Simple IndexedDB wrapper for storing books, settings, positions, highlights
const DB_NAME = 'iloveepub-db';
const DB_VERSION = 1;

function openDB(){
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('highlights')) db.createObjectStore('highlights', { keyPath: 'id' });
    };
    r.onsuccess = e => resolve(e.target.result);
    r.onerror = e => reject(e.target.error);
  });
}

async function tx(storeName, mode, op){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const s = t.objectStore(storeName);
    const req = op(s);
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export async function saveBook(book){
  // book: {id, name, mimeType, fileData:ArrayBuffer, created}
  return tx('books','readwrite', s => s.put(book));
}

export async function getBook(id){
  return tx('books','readonly', s => s.get(id));
}

export async function listBooks(){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const t = db.transaction('books','readonly');
    const s = t.objectStore('books');
    const items = [];
    s.openCursor().onsuccess = e => {
      const c = e.target.result;
      if (!c) { resolve(items); return; }
      items.push(c.value);
      c.continue();
    };
    t.onerror = e => reject(e.target.error);
  })
}

export async function deleteBook(id){
  return tx('books','readwrite', s => s.delete(id));
}

export async function saveSetting(key, value){
  return tx('settings','readwrite', s => s.put({key, value}));
}

export async function getSetting(key){
  return tx('settings','readonly', s => s.get(key)).then(r=>r?.value);
}

export async function savePosition(bookId, position){
  return tx('positions','readwrite', s => s.put({bookId, position}));
}

export async function getPosition(bookId){
  return tx('positions','readonly', s => s.get(bookId)).then(r=>r?.position);
}

export async function saveHighlight(highlight){
  // highlight: {id, bookId, cfi, text, note, color, created}
  return tx('highlights','readwrite', s => s.put(highlight));
}

export async function listHighlights(bookId){
  const db = await openDB();
  return new Promise((resolve,reject)=>{
    const t = db.transaction('highlights','readonly');
    const s = t.objectStore('highlights');
    const items = [];
    s.openCursor().onsuccess = e => {
      const c = e.target.result;
      if (!c) { resolve(items.filter(h=>h.bookId===bookId)); return; }
      items.push(c.value);
      c.continue();
    };
    t.onerror = e => reject(e.target.error);
  })
}

export async function deleteHighlight(id){
  return tx('highlights','readwrite', s => s.delete(id));
}

// Small helper id generator
export function uid(){
  return 'id-' + Math.random().toString(36).slice(2,10);
}
