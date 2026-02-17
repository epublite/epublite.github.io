import { savePosition } from './storage.js';

// Basic EPUB parser using JSZip. Handles common EPUB structure (container.xml -> content.opf -> spine).
export class EPUBReader {
  constructor(options={}){
    this.zip = null;
    this.manifest = {};
    this.spine = [];
    this.nav = [];
    this.chapters = []; // {href, id, content}
    this.basePath = '';
    this.options = options;
  }

  async loadArrayBuffer(arrayBuffer){
    if (!window.JSZip) throw new Error('JSZip is required. See index.html comments.');
    this.zip = await JSZip.loadAsync(arrayBuffer);
    await this._parseContainer();
    return this;
  }

  async _parseContainer(){
    const containerPath = 'META-INF/container.xml';
    const file = this.zip.file(containerPath);
    if (!file) throw new Error('Invalid EPUB: container.xml not found');
    const xml = await file.async('text');
    const doc = new DOMParser().parseFromString(xml,'application/xml');
    const rootfile = doc.querySelector('rootfile');
    const fullPath = rootfile.getAttribute('full-path');
    this.basePath = fullPath.replace(/[^\/]+\.opf$/i,'');
    await this._parseOPF(fullPath);
  }

  async _parseOPF(opfPath){
    const file = this.zip.file(opfPath);
    if (!file) throw new Error('OPF not found: ' + opfPath);
    const xml = await file.async('text');
    const doc = new DOMParser().parseFromString(xml,'application/xml');
    // parse manifest
    const manifestNodes = doc.querySelectorAll('manifest > item');
    manifestNodes.forEach(n => this.manifest[n.getAttribute('id')] = {href:n.getAttribute('href'), media:n.getAttribute('media-type')});
    // parse spine
    const spineNodes = doc.querySelectorAll('spine > itemref');
    this.spine = Array.from(spineNodes).map(n => ({idref:n.getAttribute('idref')}));
    // build chapters list
    this.chapters = this.spine.map(s => {
      const item = this.manifest[s.idref];
      return item ? {href: this._resolvePath(item.href), id: s.idref, content: null} : null;
    }).filter(Boolean);

    // try to parse nav (toc) from nav.xhtml or ncx
    const navItem = Object.values(this.manifest).find(i=>/nav\.x?html$/i.test(i.href));
    if(navItem){
      await this._parseNav(this._resolvePath(navItem.href));
    } else {
      // try ncx
      const ncxItem = Object.values(this.manifest).find(i=>/\.ncx$/i.test(i.href));
      if(ncxItem) await this._parseNCX(this._resolvePath(ncxItem.href));
    }
  }

  _resolvePath(href){
    if (/^https?:|^\//i.test(href)) return href;
    return (this.basePath || '') + href;
  }

  async _parseNav(path){
    const file = this.zip.file(path);
    if (!file) return;
    const xml = await file.async('text');
    const doc = new DOMParser().parseFromString(xml,'application/xhtml+xml');
    const items = [];
    doc.querySelectorAll('nav').forEach(nav => {
      nav.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        items.push({title: a.textContent.trim(), href: this._resolvePath(href)});
      });
    });
    if (items.length) this.nav = items;
  }

  async _parseNCX(path){
    const file = this.zip.file(path);
    if (!file) return;
    const xml = await file.async('text');
    const doc = new DOMParser().parseFromString(xml,'application/xml');
    const navPoints = doc.querySelectorAll('navPoint');
    this.nav = Array.from(navPoints).map(np => {
      const label = np.querySelector('text')?.textContent || 'Chapter';
      const src = np.querySelector('content')?.getAttribute('src') || '';
      return {title: label.trim(), href: this._resolvePath(src)};
    });
  }

  async loadChapter(index){
    if (index < 0 || index >= this.chapters.length) return null;
    const ch = this.chapters[index];
    if (ch.content) return ch.content;
    const file = this.zip.file(ch.href);
    if (!file) return null;
    const text = await file.async('text');
    ch.content = this._sanitizeHTML(text);
    ch.textContent = this._extractText(ch.content);
    return ch.content;
  }

  _getChapterBase(href){
    // returns directory path for resolving relative resources
    const parts = href.split('/');
    parts.pop();
    let base = parts.join('/');
    if (base && !base.endsWith('/')) base += '/';
    return base;
  }

  _resolveResourcePath(chapterHref, resourceHref){
    if (!resourceHref) return resourceHref;
    if (/^https?:\/\//i.test(resourceHref)) return resourceHref;
    // strip fragment
    resourceHref = resourceHref.split('#')[0];
    // if absolute within epub root
    if (resourceHref.startsWith('/')) return resourceHref.replace(/^\//, '');
    // otherwise relative to chapter
    const base = this._getChapterBase(chapterHref);
    const stack = (base + resourceHref).split('/');
    const parts = [];
    for (const seg of stack){
      if (seg === '..') parts.pop();
      else if (seg === '.' || seg === '') continue;
      else parts.push(seg);
    }
    return parts.join('/');
  }

  _sanitizeHTML(html){
    // remove <script> and event attributes
    const doc = new DOMParser().parseFromString(html,'application/xhtml+xml');
    doc.querySelectorAll('script').forEach(s=>s.remove());
    // remove inline event handlers
    doc.querySelectorAll('*').forEach(el=>{
      [...el.attributes].forEach(attr=>{
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      })
    });
    return new XMLSerializer().serializeToString(doc);
  }

  _extractText(html){
    const doc = new DOMParser().parseFromString(html,'text/html');
    return doc.body.textContent || '';
  }

  async renderTo(container, chapterIndex){
    const content = await this.loadChapter(chapterIndex);
    if (!content) return;
    // set innerHTML safely by parsing and importing nodes
    const doc = new DOMParser().parseFromString(content,'text/html');
    container.innerHTML = '';
    // revoke previous resource URLs
    if (this._resourceURLs){ this._resourceURLs.forEach(url=>URL.revokeObjectURL(url)); }
    this._resourceURLs = [];
    // import children
    Array.from(doc.body.children).forEach(c=>container.appendChild(c));

    // resolve images and linked resources
    const chapterHref = this.chapters[chapterIndex].href;
    // images
    const imgs = container.querySelectorAll('img');
    for (const img of imgs){
      const src = img.getAttribute('src') || img.getAttribute('data-src');
      if (!src) continue;
      const path = this._resolveResourcePath(chapterHref, src);
      const file = this.zip.file(path);
      if (file){
        try{
          const blob = await file.async('blob');
          const url = URL.createObjectURL(blob);
          img.src = url;
          this._resourceURLs.push(url);
        }catch(e){ console.warn('Failed to load image', path, e); }
      }
    }
    // linked stylesheets inside chapter
    const links = container.querySelectorAll('link[rel="stylesheet"]');
    for (const l of links){
      const href = l.getAttribute('href');
      const path = this._resolveResourcePath(chapterHref, href);
      const file = this.zip.file(path);
      if (file){
        try{
          const css = await file.async('text');
          const style = document.createElement('style');
          style.textContent = css;
          l.parentNode.replaceChild(style, l);
        }catch(e){ console.warn('Failed to load css', path, e); }
      }
    }
    // update reading progress
    this.currentIndex = chapterIndex;
    if (this.options.onRender) this.options.onRender(chapterIndex);
  }

  async renderAll(container){
    // Render all chapters concatenated (scrolled mode)
    container.innerHTML = '';
    if (this._resourceURLs){ this._resourceURLs.forEach(url=>URL.revokeObjectURL(url)); }
    this._resourceURLs = [];
    for (let i=0;i<this.chapters.length;i++){
      const content = await this.loadChapter(i);
      if (!content) continue;
      const doc = new DOMParser().parseFromString(content,'text/html');
      const wrapper = document.createElement('div');
      wrapper.className = 'chapter-block';
      wrapper.dataset.chapter = i;
      Array.from(doc.body.children).forEach(c=>wrapper.appendChild(c));
      container.appendChild(wrapper);
      // resolve resources for this chapter
      const chapterHref = this.chapters[i].href;
      const imgs = wrapper.querySelectorAll('img');
      for (const img of imgs){
        const src = img.getAttribute('src') || img.getAttribute('data-src');
        if (!src) continue;
        const path = this._resolveResourcePath(chapterHref, src);
        const file = this.zip.file(path);
        if (file){
          try{ const blob = await file.async('blob'); const url = URL.createObjectURL(blob); img.src = url; this._resourceURLs.push(url);}catch(e){ }
        }
      }
    }
    // final
    if (this.options.onRender) this.options.onRender(0);
  }

  search(query){
    if (!query) return [];
    const q = query.toLowerCase();
    const results = [];
    this.chapters.forEach((ch, idx)=>{
      if (!ch.textContent) return;
      const text = ch.textContent.toLowerCase();
      let pos = text.indexOf(q), count=0;
      while(pos !== -1){
        results.push({chapter: idx, index: pos});
        pos = text.indexOf(q,pos+q.length);
        if (++count>200) break; // safety
      }
    });
    return results;
  }

  async savePosition(bookId){
    if (!bookId) return;
    const pos = {chapter: this.currentIndex || 0};
    await savePosition(bookId,pos);
  }
}

export default EPUBReader;
