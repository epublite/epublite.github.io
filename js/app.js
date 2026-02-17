import EPUBReader from './reader.js';
import { saveBook, listBooks, getBook, saveSetting, getSetting, saveHighlight, listHighlights, deleteHighlight, deleteBook as deleteBookFromStorage, uid, savePosition, getPosition } from './storage.js';

const fileInput = document.getElementById('fileInput');
const tocList = document.getElementById('tocList');
const viewer = document.getElementById('content');
const progressBar = document.getElementById('progressBar');
const progressLabel = document.getElementById('progressLabel');
const libraryList = document.getElementById('libraryList');
const emptyState = document.getElementById('emptyState');
const notesList = document.getElementById('notesList');
const viewModeSelect = document.getElementById('viewMode');
const bookTitle = document.getElementById('bookTitle');
const backBtn = document.getElementById('backBtn');
const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const uploadBox = document.querySelector('.upload-box');

let currentBook = null;
let reader = null;
let currentBookId = null;
let fontSize = 18;
let viewMode = 'section';
let pendingHighlight = { text: '', range: null, chapterIdx: 0 };

async function init(){
  // restore theme
  const theme = await getSetting('theme');
  if (theme === 'dark') document.documentElement.setAttribute('data-theme','dark');
  const savedFont = await getSetting('fontSize');
  if (savedFont) { fontSize = savedFont; document.querySelector('#content').style.fontSize = fontSize + 'px'; }
  const savedView = await getSetting('viewMode');
  if (savedView) { viewMode = savedView; if (viewModeSelect) viewModeSelect.value = viewMode; }
  await refreshLibrary();
}

// Delegate clicks on library items to ensure reliable behavior
libraryList.addEventListener('click', (e) => {
  // ignore clicks on delete buttons
  if (e.target.closest && e.target.closest('.library-item-delete')) return;
  const item = e.target.closest('.library-item');
  if (!item) return;
  const id = item.dataset.id;
  console.log('Library click on id:', id);
  if (!id) {
    console.warn('Clicked library item has no data-id');
    return;
  }
  try {
    openStoredBook(id);
  } catch (err) {
    console.error('openStoredBook threw', err);
    alert('Failed to open book: ' + (err && err.message));
  }
});

fileInput.addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  const id = f.name + '::' + Date.now();
  await saveBook({id, name:f.name, created:Date.now(), fileData:buf});
  await refreshLibrary();
  openBookFromBuffer(id, buf, f.name);
});

async function refreshLibrary(){
  libraryList.innerHTML = '';
  const books = await listBooks();
  if (books.length === 0) {
    // emptyState.style.display = 'block';
    document.querySelector('.library-section').style.display = 'none';
  } else {
    emptyState.style.display = 'none';
    document.querySelector('.library-section').style.display = 'block';
    document.querySelector('.content').style.display = 'none';
    
    books.forEach(b=>{
      const el = document.createElement('div');
      el.className = 'library-item';
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'library-item-delete';
      deleteBtn.innerHTML = '✕';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${b.name}"?`)) {
          deleteBook(b.id);
        }
      });
      
      el.innerHTML = `<div class="library-item-icon">📖</div><p class="library-item-title">${b.name}</p>`;
      el.dataset.id = b.id;
      el.appendChild(deleteBtn);
      libraryList.appendChild(el);
    });
  }
}

async function deleteBook(id) {
  // Delete all highlights for this book
  const highs = await listHighlights(id);
  for (const h of highs) {
    await deleteHighlight(h.id);
  }
  
  // Delete the book itself from storage
  await deleteBookFromStorage(id);
  await refreshLibrary();
  location.reload();
}

async function openStoredBook(id){
  console.log('openStoredBook called for id:', id);
  const b = await getBook(id);
  if (!b) { console.warn('Book not found in DB for id', id); alert('Book not found'); return; }
  try{
    openBookFromBuffer(id, b.fileData, b.name);
  }catch(err){
    console.error('openBookFromBuffer threw synchronously', err);
    alert('Failed to open book: ' + (err && err.message));
  }
}

async function openBookFromBuffer(id, arrayBuffer, name){
  console.log('openBookFromBuffer start', id);
  currentBookId = id;
  reader = new EPUBReader({onRender: updateProgress});
  try{
    await reader.loadArrayBuffer(arrayBuffer);
    console.log('loadArrayBuffer completed for', id);
  }catch(err){ console.error('Failed to open EPUB', err); alert('Failed to open EPUB: '+err.message); return; }
  // show TOC (build mapping so TOC matches spine)
  buildTOCMapping();
  renderTOC();
  // load saved position
  const pos = await getPosition(id);
  const chapter = pos?.chapter || 0;
  if (viewMode === 'scrolled') await reader.renderAll(viewer);
  else await reader.renderTo(viewer, chapter);
  updateProgress(chapter);
  bindSelection();
  await refreshNotes();
  // update book title (truncate to 10 chars) and switch to step 2
  const displayName = (name || 'Book').length > 50 ? (name || 'Book').substring(0, 50) + '...' : (name || 'Book');
  bookTitle.textContent = displayName;
  bookTitle.title = name || 'Book';
  console.log('Switching to reader view for', id);
  step1.classList.remove('active');
  step2.classList.add('active');
  // focus viewer for keyboard scroll
  const v = document.getElementById('viewer'); if (v) v.focus();
}

function buildTOCMapping(){
  if (!reader) return;
  const chmap = reader.chapters.map((c,i)=>({href: c.href.split('#')[0], index: i}));
  reader.nav = (reader.nav || []).map(n => {
    const href = (n.href||'').split('#')[0];
    let idx = chmap.find(c => c.href === href)?.index;
    if (idx === undefined){
      idx = chmap.find(c => href.endsWith(c.href) || c.href.endsWith(href))?.index;
    }
    return {...n, chapterIndex: (idx !== undefined ? idx : 0)};
  });
}

function renderTOC(){
  tocList.innerHTML = '';
  const nav = reader.nav && reader.nav.length ? reader.nav : reader.chapters.map((c,i)=>({title: 'Chapter ' + (i+1), href: c.href, chapterIndex: i}));
  nav.forEach((n, idx)=>{
    const chapterIdx = (typeof n.chapterIndex === 'number') ? n.chapterIndex : idx;
    const a = document.createElement('div');
    a.className = 'toc-item';
    a.textContent = n.title || ('Chapter ' + (idx+1));
    a.dataset.chapter = chapterIdx;
    a.dataset.href = n.href || '';
    a.onclick = async ()=>{
      if (viewMode === 'scrolled'){
        const block = viewer.querySelector(`.chapter-block[data-chapter="${chapterIdx}"]`);
        if (block) block.scrollIntoView({behavior:'smooth'});
      } else {
        await reader.renderTo(viewer, chapterIdx);
      }
      await reader.savePosition(currentBookId);
      updateProgress(chapterIdx);
      setActiveTOC(chapterIdx);
      // if TOC links to a fragment, attempt to scroll to it
      const href = a.dataset.href || '';
      if (href.includes('#')){
        const frag = href.split('#')[1];
        if (frag){
          const el = viewer.querySelector('#' + CSS.escape(frag));
          if (el) el.scrollIntoView({behavior:'smooth'});
        }
      }
    };
    tocList.appendChild(a);
  });
}

function setActiveTOC(chapterIdx){
  const items = tocList.querySelectorAll('.toc-item');
  items.forEach(it=>{
    if (Number(it.dataset.chapter) === chapterIdx) it.classList.add('active'); else it.classList.remove('active');
  });
}

function updateProgress(chapterIndex){
  const total = reader.chapters.length || 1;
  const p = Math.round((chapterIndex / total) * 100);
  if (progressBar) progressBar.style.width = p + '%';
  if (progressLabel) progressLabel.textContent = p + '%';
  try{ setActiveTOC(chapterIndex); }catch(e){}
}
 

document.getElementById('increaseFont').addEventListener('click', ()=>{
  fontSize = Math.min(40, fontSize + 2); document.querySelector('#content').style.fontSize = fontSize + 'px'; saveSetting('fontSize', fontSize);
});
document.getElementById('decreaseFont').addEventListener('click', ()=>{
  fontSize = Math.max(10, fontSize - 2); document.querySelector('#content').style.fontSize = fontSize + 'px'; saveSetting('fontSize', fontSize);
});

document.getElementById('alignment').addEventListener('change', e=>{
  document.querySelector('#content').style.textAlign = e.target.value;
  saveSetting('alignment', e.target.value);
});

document.getElementById('themeToggle').addEventListener('click', async ()=>{
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  if (t === 'dark') document.documentElement.setAttribute('data-theme','dark'); else document.documentElement.removeAttribute('data-theme');
  await saveSetting('theme', t === 'dark' ? 'dark' : 'light');
});

document.getElementById('searchBtn').addEventListener('click', ()=>{
  const q = document.getElementById('searchInput').value.trim();
  if (!q || !reader) return;
  const results = reader.search(q);
  if (results.length){
    const first = results[0];
    if (viewMode === 'scrolled'){
      reader.renderAll(viewer).then(()=>{
        const block = viewer.querySelector(`.chapter-block[data-chapter="${first.chapter}"]`);
        if (block) block.scrollIntoView({behavior:'smooth'});
        setTimeout(()=>highlightInViewer(q),200);
      });
    } else {
      reader.renderTo(viewer, first.chapter).then(()=>{
        setTimeout(()=>highlightInViewer(q),100);
      });
    }
  } else alert('No results');
});

function highlightInViewer(q){
  // simple highlight in current viewer by wrapping matches with <mark>
  const regex = new RegExp(q, 'gi');
  const walker = document.createTreeWalker(viewer, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while(walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n=>{
    if (!n.nodeValue.match(regex)) return;
    const span = document.createElement('span');
    const frag = document.createDocumentFragment();
    let html = n.nodeValue.replace(regex, match => `<<hl>>${match}<<\/hl>>`);
    // convert markers to nodes
    const parts = html.split('<<hl>>');
    parts.forEach(p=>{
      const idx = p.indexOf('<\/hl>');
      if (idx === -1){ frag.appendChild(document.createTextNode(p)); }
      else {
        const before = p.slice(0, idx);
        const after = p.slice(idx + 6);
        const mark = document.createElement('mark'); mark.textContent = before; frag.appendChild(mark); frag.appendChild(document.createTextNode(after));
      }
    });
    n.parentNode.replaceChild(frag, n);
  });
}

function bindSelection(){
  viewer.onmouseup = async ()=>{
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (text.length < 3) return;
    
    // determine chapter for scrolled vs section mode
    let chapterIdx = reader.currentIndex || 0;
    try{
      const common = sel.getRangeAt(0).commonAncestorContainer;
      const parent = (common.nodeType === 1) ? common : common.parentElement;
      const block = parent && parent.closest ? parent.closest('.chapter-block') : null;
      if (block && block.dataset && block.dataset.chapter) chapterIdx = Number(block.dataset.chapter);
    }catch(e){}
    
    // Store highlight info in pendingHighlight and show modal
    pendingHighlight = { text, range: sel.getRangeAt(0), chapterIdx };
    document.getElementById('highlightText').textContent = text;
    document.getElementById('noteInput').value = '';
    document.getElementById('noteModal').classList.add('active');
    sel.removeAllRanges();
  };
}

// Modal handlers for highlight notes
document.getElementById('modalClose').addEventListener('click', ()=>{
  document.getElementById('noteModal').classList.remove('active');
  pendingHighlight = { text: '', range: null, chapterIdx: 0 };
});

document.getElementById('modalCancel').addEventListener('click', ()=>{
  document.getElementById('noteModal').classList.remove('active');
  pendingHighlight = { text: '', range: null, chapterIdx: 0 };
});

document.getElementById('modalSave').addEventListener('click', async ()=>{
  const note = document.getElementById('noteInput').value.trim();
  const color = '#ffeb3b';
  
  if (!pendingHighlight.range) return;
  
  try {
    const span = document.createElement('span');
    const id = uid();
    span.style.background = color;
    span.dataset.hid = id;
    pendingHighlight.range.surroundContents(span);
    
    await saveHighlight({
      id,
      bookId: currentBookId,
      chapter: pendingHighlight.chapterIdx,
      text: pendingHighlight.text,
      note: note || '',
      color,
      created: Date.now()
    });
    
    await refreshNotes();
    document.getElementById('noteModal').classList.remove('active');
    pendingHighlight = { text: '', range: null, chapterIdx: 0 };
  } catch(e) {
    console.warn('Highlight save failed', e);
  }
});

// Close modal on backdrop click
document.getElementById('noteModal').addEventListener('click', (e)=>{
  if (e.target.id === 'noteModal') {
    document.getElementById('noteModal').classList.remove('active');
    pendingHighlight = { text: '', range: null, chapterIdx: 0 };
  }
});

async function refreshNotes(){
  if (!notesList) return; // notes pane removed; nothing to do
  notesList.innerHTML = '';
  if (!currentBookId) return;
  const highs = await listHighlights(currentBookId);
  highs.forEach(h=>{
    const d = document.createElement('div'); d.className = 'note';
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '✕';
    deleteBtn.className = 'note-delete-btn';
    deleteBtn.onclick = async (e)=>{ e.stopPropagation(); await deleteHighlight(h.id); await refreshNotes(); };
    d.innerHTML = `<div class="note-header"><strong>${h.text}</strong></div><div class="muted">${h.note||''}</div>`;
    d.insertBefore(deleteBtn, d.firstChild);
    notesList.appendChild(d);
  });
}

if (viewModeSelect) viewModeSelect.addEventListener('change', async (e) =>{
  viewMode = e.target.value;
  await saveSetting('viewMode', viewMode);
  if (!reader) return;
  if (viewMode === 'scrolled') await reader.renderAll(viewer);
  else {
    const pos = await getPosition(currentBookId);
    const chapter = pos?.chapter || 0;
    await reader.renderTo(viewer, chapter);
  }
});

window.addEventListener('beforeunload', async ()=>{
  if (reader && currentBookId) await reader.savePosition(currentBookId);
});

// Back button: return to library
backBtn.addEventListener('click', async ()=>{
  console.log('Back button clicked');
  try{
    if (reader && currentBookId) {
      // avoid long hangs: race savePosition against a short timeout
      try{
        await Promise.race([
          reader.savePosition(currentBookId),
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
        console.log('savePosition completed or timed out');
      }catch(e){ console.warn('Error in savePosition race', e); }
      // revoke any object URLs created by reader
      if (reader._resourceURLs) { reader._resourceURLs.forEach(u=>URL.revokeObjectURL(u)); reader._resourceURLs = []; }
    }
  }catch(e){ console.warn('Error handling save/cleanup on back', e); }

  // Ensure only the library step is active
  try{
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    if (step1) {
      step1.classList.add('active');
      step1.scrollTop = 0;
    }
    if (step2) {
      step2.classList.remove('active');
    }
  }catch(e){ console.warn('Error toggling steps', e); }

  console.log('Back navigation completed: step1 active:', !!step1 && step1.classList.contains('active'));

  // clear viewer content and reset state
  try { viewer.innerHTML = ''; } catch(e){}
  reader = null;
  currentBookId = null;
  // restore focus to library
  const firstItem = libraryList.querySelector('.library-item'); if (firstItem) firstItem.focus();
});

// Drag & drop on upload box
uploadBox.addEventListener('dragover', (e)=>{ e.preventDefault(); uploadBox.style.borderColor = 'var(--accent)'; });
uploadBox.addEventListener('dragleave', ()=>{ uploadBox.style.borderColor = 'var(--border)'; });
uploadBox.addEventListener('drop', async (e)=>{ 
  e.preventDefault(); 
  uploadBox.style.borderColor = 'var(--border)';
  const f = e.dataTransfer.files[0];
  if (!f || !f.name.endsWith('.epub')) return;
  const buf = await f.arrayBuffer();
  const id = f.name + '::' + Date.now();
  await saveBook({id, name:f.name, created:Date.now(), fileData:buf});
  await refreshLibrary();
  openBookFromBuffer(id, buf, f.name);
});

// Click upload box to open file input
uploadBox.addEventListener('click', ()=>fileInput.click());

init();
