/* Narra app: library, importers, reader view and the speech player. */
(function () {
  'use strict';
  const C = window.NarraCore;
  const $ = (id) => document.getElementById(id);
  const synth = window.speechSynthesis;

  const LIB_KEY = 'narra.library.v1';
  const SET_KEY = 'narra.settings.v1';
  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

  // ---------------------------------------------------------------- storage
  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  const settings = Object.assign({
    rate: 1, pitch: 1, voiceURI: '', fontSize: 20, leading: 1.75, font: 'serif', theme: 'system', wordHl: true, follow: true
  }, load(SET_KEY, {}));
  let library = load(LIB_KEY, []);
  if (!Array.isArray(library)) library = [];

  let storageWarned = false;
  function saveLibrary() {
    if (!save(LIB_KEY, library) && !storageWarned) {
      storageWarned = true;
      toast('Your browser storage is full, so new items may not be kept after you close Narra. Delete a few to make room.');
    }
  }
  function saveSettings() { save(SET_KEY, settings); }

  // ---------------------------------------------------------------- state
  let current = null;        // library item
  let doc = null;            // { paragraphs, sentences, words }
  let wordsBefore = [];      // cumulative words before each sentence
  let idx = 0;               // current sentence
  let playing = false;
  let token = 0;             // bumps on every speak/stop so stale events are ignored
  let utterStartedAt = 0;
  let utterEnded = true;
  let lastUserScroll = 0;
  let voices = [];
  let reachedEnd = false;   // true after the last sentence finished

  // ---------------------------------------------------------------- toast
  let toastTimer = null;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms || 3800);
  }

  // ---------------------------------------------------------------- library UI
  function renderLibrary() {
    const q = $('search').value.trim().toLowerCase();
    const list = $('items');
    list.innerHTML = '';
    const items = library
      .slice()
      .sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt))
      .filter((it) => !q || it.title.toLowerCase().includes(q) || (it.text || '').toLowerCase().includes(q));
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty-lib';
      li.textContent = q ? 'Nothing in your library matches that.' : 'Things you add will be kept here, with your place saved.';
      list.appendChild(li);
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const btn = document.createElement('div');
      btn.className = 'item';
      btn.setAttribute('role', 'button');
      btn.tabIndex = 0;
      btn.dataset.id = it.id;
      if (current && current.id === it.id) btn.setAttribute('aria-current', 'true');
      const pct = it.total ? Math.min(100, Math.round(((it.pos || 0) / Math.max(1, it.total - 1)) * 100)) : 0;
      const mins = C.formatDuration(C.minutesFor(it.words || 0, 1));
      btn.innerHTML =
        '<span class="t"></span><span class="m"></span>' +
        '<button class="del" aria-label="Delete">✕</button>' +
        '<span class="bar"><i style="width:' + pct + '%"></i></span>';
      btn.querySelector('.t').textContent = it.title;
      btn.querySelector('.m').textContent = (it.source || 'Text') + ' · ' + mins + (pct ? ' · ' + pct + '% read' : '');
      btn.querySelector('.del').title = 'Delete “' + it.title + '”';
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  $('items').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.closest('.del')) {
      const it = library.find((x) => x.id === id);
      if (it && confirm('Delete “' + it.title + '” from your library?')) removeItem(id);
      return;
    }
    openItem(id);
    closeDrawer();
  });
  $('items').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('item')) {
      e.preventDefault();
      openItem(e.target.dataset.id);
      closeDrawer();
    }
  });
  $('search').addEventListener('input', renderLibrary);

  function addItem(title, text, source) {
    const clean = C.normalizeText(text);
    if (!clean || C.countWords(clean) === 0) {
      toast('There was no readable text in that.');
      return null;
    }
    const d = C.buildDocument(clean);
    const it = {
      id: C.uid(),
      title: (title && title.trim()) || C.guessTitle(clean),
      text: clean,
      source: source || 'Text',
      addedAt: Date.now(),
      openedAt: Date.now(),
      pos: 0,
      total: d.sentences.length,
      words: d.words
    };
    library.push(it);
    saveLibrary();
    openItem(it.id);
    return it;
  }

  function removeItem(id) {
    library = library.filter((x) => x.id !== id);
    saveLibrary();
    if (current && current.id === id) {
      stop();
      current = null;
      doc = null;
      showWelcome();
    }
    renderLibrary();
  }

  // ---------------------------------------------------------------- reader
  function showWelcome() {
    $('welcome').hidden = false;
    $('text').hidden = true;
    $('docTitle').textContent = 'Narra';
    $('playBtn').disabled = true;
    $('seek').max = 0;
    $('seek').value = 0;
    $('elapsed').textContent = '0%';
    $('remaining').textContent = '0 min left';
    document.title = 'Narra';
  }

  function openItem(id) {
    const it = library.find((x) => x.id === id);
    if (!it) return;
    stop();
    reachedEnd = false;
    current = it;
    it.openedAt = Date.now();
    doc = C.buildDocument(it.text);
    it.total = doc.sentences.length;
    wordsBefore = [];
    let acc = 0;
    for (const s of doc.sentences) { wordsBefore.push(acc); acc += C.countWords(s.text); }
    idx = Math.min(it.pos || 0, Math.max(0, doc.sentences.length - 1));
    saveLibrary();

    const art = $('text');
    art.innerHTML = '';
    const frag = document.createDocumentFragment();
    doc.paragraphs.forEach((ids) => {
      const p = document.createElement('p');
      ids.forEach((si, k) => {
        const span = document.createElement('span');
        span.className = 's';
        span.dataset.i = si;
        span.textContent = doc.sentences[si].text;
        p.appendChild(span);
        if (k < ids.length - 1) p.appendChild(document.createTextNode(' '));
      });
      frag.appendChild(p);
    });
    art.appendChild(frag);
    $('welcome').hidden = true;
    art.hidden = false;
    $('docTitle').textContent = it.title;
    document.title = it.title + ' · Narra';
    $('playBtn').disabled = false;
    $('seek').max = Math.max(0, doc.sentences.length - 1);
    setCurrent(idx, true);
    renderLibrary();
    updateMediaSession();
  }

  function sentenceEl(i) { return $('text').querySelector('.s[data-i="' + i + '"]'); }

  let litEl = null;
  function setCurrent(i, jumpScroll) {
    if (!doc) return;
    idx = Math.max(0, Math.min(i, doc.sentences.length - 1));
    if (litEl) { litEl.classList.remove('on'); clearWord(litEl); }
    litEl = sentenceEl(idx);
    if (litEl) {
      litEl.classList.add('on');
      if (settings.follow && (jumpScroll || Date.now() - lastUserScroll > 3000)) keepInView(litEl, jumpScroll);
    }
    if (current) {
      current.pos = idx;
      savePositionSoon();
    }
    updateProgress();
  }

  function keepInView(el, force) {
    const page = $('page');
    const r = el.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const top = pr.top + pr.height * 0.18;
    const bottom = pr.bottom - pr.height * 0.3;
    if (force || r.top < top || r.bottom > bottom) {
      page.scrollTo({ top: page.scrollTop + r.top - pr.top - pr.height * 0.3, behavior: force ? 'auto' : 'smooth' });
    }
  }

  let posTimer = null;
  function savePositionSoon() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => { saveLibrary(); renderLibraryProgress(); }, 800);
  }
  function renderLibraryProgress() {
    if (!current) return;
    const el = $('items').querySelector('.item[data-id="' + current.id + '"]');
    if (!el) return;
    const pct = Math.min(100, Math.round((idx / Math.max(1, doc.sentences.length - 1)) * 100));
    el.querySelector('.bar i').style.width = pct + '%';
  }

  function updateProgress() {
    if (!doc) return;
    const n = doc.sentences.length;
    $('seek').value = idx;
    const pct = n > 1 ? Math.round((idx / (n - 1)) * 100) : 0;
    $('elapsed').textContent = pct + '%';
    const left = doc.words - (wordsBefore[idx] || 0);
    $('remaining').textContent = C.formatDuration(C.minutesFor(left, settings.rate)) + ' left';
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function showWord(el, text, charIndex, charLength) {
    if (!settings.wordHl || !el) return;
    const w = C.wordAt(text, charIndex, charLength);
    if (!w) return;
    el.innerHTML = escapeHtml(text.slice(0, w.start)) + '<mark class="w">' + escapeHtml(text.slice(w.start, w.end)) + '</mark>' + escapeHtml(text.slice(w.end));
    el.dataset.hl = '1';
  }
  function clearWord(el) {
    if (el && el.dataset.hl) { el.textContent = doc ? doc.sentences[+el.dataset.i].text : el.textContent; delete el.dataset.hl; }
  }

  // ---------------------------------------------------------------- voices
  function voiceScore(v) {
    let s = 0;
    if (/natural|neural|enhanced|premium|online/i.test(v.name)) s += 4;
    if (/google|microsoft|siri|samantha|daniel|karen|moira/i.test(v.name)) s += 1;
    if (v.localService) s += 0.5;
    return s;
  }
  function langName(tag) {
    try { return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(tag) || tag; } catch (e) { return tag; }
  }

  function loadVoices() {
    if (!synth) return;
    const list = synth.getVoices();
    if (!list.length) return;
    voices = list;
    const sel = $('voiceSelect');
    sel.innerHTML = '';
    const userLang = (navigator.language || 'en-US').toLowerCase();
    const groups = new Map();
    for (const v of voices) {
      const key = (v.lang || 'other').replace('_', '-');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      const pa = a.toLowerCase() === userLang ? 0 : a.toLowerCase().split('-')[0] === userLang.split('-')[0] ? 1 : 2;
      const pb = b.toLowerCase() === userLang ? 0 : b.toLowerCase().split('-')[0] === userLang.split('-')[0] ? 1 : 2;
      return pa - pb || langName(a).localeCompare(langName(b));
    });
    for (const k of keys) {
      const og = document.createElement('optgroup');
      og.label = langName(k) + (k.includes('-') ? ' (' + k.split('-')[1].toUpperCase() + ')' : '');
      groups.get(k).sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name)).forEach((v) => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s*-\s*[A-Za-z ]+\([^)]*\)$/, '') + (voiceScore(v) >= 4 ? ' ★' : '');
        og.appendChild(o);
      });
      sel.appendChild(og);
    }
    let chosen = voices.find((v) => v.voiceURI === settings.voiceURI);
    if (!chosen) {
      const same = voices.filter((v) => (v.lang || '').toLowerCase().replace('_', '-') === userLang);
      const base = same.length ? same : voices.filter((v) => (v.lang || '').toLowerCase().startsWith(userLang.split('-')[0]));
      const pool = base.length ? base : voices;
      chosen = pool.slice().sort((a, b) => voiceScore(b) - voiceScore(a) || (b.default ? 1 : 0) - (a.default ? 1 : 0))[0];
    }
    if (chosen) { sel.value = chosen.voiceURI; settings.voiceURI = chosen.voiceURI; }
  }
  function currentVoice() { return voices.find((v) => v.voiceURI === settings.voiceURI) || null; }

  if (synth) {
    loadVoices();
    if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', loadVoices);
    else synth.onvoiceschanged = loadVoices;
    setTimeout(() => { if (!voices.length) loadVoices(); if (!voices.length) $('voiceSelect').innerHTML = '<option>System voice</option>'; }, 2500);
  } else {
    $('voiceSelect').innerHTML = '<option>No speech on this browser</option>';
  }

  $('voiceSelect').addEventListener('change', (e) => {
    settings.voiceURI = e.target.value;
    saveSettings();
    if (playing) speak(idx);
  });

  // ---------------------------------------------------------------- player
  function setPlayIcon() {
    $('playIcon').innerHTML = playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }

  function speak(i) {
    if (!synth || !doc) return;
    const my = ++token;
    synth.cancel();
    setCurrent(i);
    const s = doc.sentences[idx];
    const u = new SpeechSynthesisUtterance(s.text);
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = settings.rate;
    u.pitch = settings.pitch;
    const el = litEl;
    u.onboundary = (e) => {
      if (my !== token) return;
      if (e.name && e.name !== 'word') return;
      showWord(el, s.text, e.charIndex, e.charLength);
    };
    u.onend = () => { if (my === token) finished(my); };
    u.onerror = (e) => {
      if (my !== token) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') { toast('Tap play to start listening.'); pause(); return; }
      // skip a sentence the voice can't handle instead of stopping the whole read
      finished(my);
    };
    utterEnded = false;
    utterStartedAt = Date.now();
    synth.speak(u);
    if (synth.paused) synth.resume();
  }

  function finished(my) {
    if (my !== token || utterEnded) return;
    utterEnded = true;
    clearWord(litEl);
    if (!playing) return;
    if (idx < doc.sentences.length - 1) {
      speak(idx + 1);
    } else {
      playing = false;
      reachedEnd = true;
      setPlayIcon();
      toast('Finished “' + current.title + '”.');
    }
  }

  // Some engines (notably on Android) occasionally never fire onend; nudge them along.
  setInterval(() => {
    if (!playing || utterEnded || !synth) return;
    if (!synth.speaking && !synth.pending && Date.now() - utterStartedAt > 1500) finished(token);
  }, 1000);

  function play() {
    if (!doc || !synth) {
      if (!synth) toast('This browser can’t read aloud. Try Chrome, Edge or Safari.');
      return;
    }
    if (reachedEnd) {
      // finished last time; start over
      reachedEnd = false;
      idx = 0;
    }
    playing = true;
    setPlayIcon();
    speak(idx);
  }
  function pause() {
    playing = false;
    token++;
    utterEnded = true;
    if (synth) synth.cancel();
    clearWord(litEl);
    setPlayIcon();
  }
  function stop() { pause(); }
  function toggle() { playing ? pause() : play(); }

  function jump(i) {
    if (!doc) return;
    reachedEnd = false;
    i = Math.max(0, Math.min(i, doc.sentences.length - 1));
    if (playing) speak(i); else setCurrent(i, true);
  }
  function paraJump(dir) {
    if (!doc) return;
    const p = doc.sentences[idx].para;
    const firstOfPara = doc.paragraphs[p][0];
    if (dir < 0) {
      // first press goes to the start of this paragraph, the next to the previous one
      if (idx > firstOfPara) return jump(firstOfPara);
      if (p > 0) return jump(doc.paragraphs[p - 1][0]);
      return jump(0);
    }
    if (p < doc.paragraphs.length - 1) jump(doc.paragraphs[p + 1][0]);
  }

  $('playBtn').addEventListener('click', toggle);
  $('prevSent').addEventListener('click', () => jump(idx - 1));
  $('nextSent').addEventListener('click', () => jump(idx + 1));
  $('prevPara').addEventListener('click', () => paraJump(-1));
  $('nextPara').addEventListener('click', () => paraJump(1));
  $('seek').addEventListener('input', (e) => { if (!playing) setCurrent(+e.target.value, true); });
  $('seek').addEventListener('change', (e) => jump(+e.target.value));
  $('text').addEventListener('click', (e) => {
    const s = e.target.closest('.s');
    if (!s || window.getSelection().toString()) return;
    const i = +s.dataset.i;
    if (!playing) { playing = true; setPlayIcon(); }
    speak(i);
  });
  $('page').addEventListener('wheel', () => { lastUserScroll = Date.now(); }, { passive: true });
  $('page').addEventListener('touchmove', () => { lastUserScroll = Date.now(); }, { passive: true });

  // ---------------------------------------------------------------- speed / pitch
  function setRate(r) {
    settings.rate = Math.round(Math.max(0.5, Math.min(3, r)) * 20) / 20;
    $('rate').value = settings.rate;
    $('speedBtn').textContent = settings.rate.toFixed(2).replace(/0$/, '') + '×';
    [...$('presets').children].forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === settings.rate)));
    saveSettings();
    updateProgress();
  }
  SPEEDS.forEach((s) => {
    const b = document.createElement('button');
    b.dataset.v = s;
    b.textContent = s + '×';
    b.addEventListener('click', () => { setRate(s); if (playing) speak(idx); });
    $('presets').appendChild(b);
  });
  $('rate').addEventListener('input', (e) => setRate(+e.target.value));
  $('rate').addEventListener('change', () => { if (playing) speak(idx); });
  $('pitch').value = settings.pitch;
  $('pitch').addEventListener('change', (e) => { settings.pitch = +e.target.value; saveSettings(); if (playing) speak(idx); });

  function togglePop(pop, btn) {
    const open = pop.hidden;
    document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; });
    document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (open) {
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      if (pop.id === 'speedPop') {
        const r = btn.getBoundingClientRect();
        pop.style.left = Math.max(12, r.left) + 'px';
      }
    }
  }
  $('speedBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('speedPop'), $('speedBtn')); });
  $('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePop($('settingsPop'), $('settingsBtn')); });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.pop')) {
      document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; });
      document.querySelectorAll('[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }
  });

  // ---------------------------------------------------------------- display settings
  function applyDisplay() {
    const root = document.documentElement;
    root.style.setProperty('--read-size', settings.fontSize + 'px');
    root.style.setProperty('--read-leading', settings.leading);
    root.dataset.font = settings.font;
    if (settings.theme === 'system') delete root.dataset.theme; else root.dataset.theme = settings.theme;
    $('fontSize').value = settings.fontSize;
    $('leading').value = settings.leading;
    $('wordHl').checked = settings.wordHl;
    $('follow').checked = settings.follow;
    [...$('fontSeg').children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.font)));
    [...$('themeSeg').children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.theme)));
  }
  $('fontSize').addEventListener('input', (e) => { settings.fontSize = +e.target.value; applyDisplay(); saveSettings(); });
  $('leading').addEventListener('input', (e) => { settings.leading = +e.target.value; applyDisplay(); saveSettings(); });
  $('fontSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.font = b.dataset.v; applyDisplay(); saveSettings(); } });
  $('themeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { settings.theme = b.dataset.v; applyDisplay(); saveSettings(); } });
  $('wordHl').addEventListener('change', (e) => { settings.wordHl = e.target.checked; if (!settings.wordHl) clearWord(litEl); saveSettings(); });
  $('follow').addEventListener('change', (e) => { settings.follow = e.target.checked; saveSettings(); });

  // ---------------------------------------------------------------- importers
  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.crossOrigin = 'anonymous';
        s.onload = resolve;
        s.onerror = () => { delete scriptCache[src]; reject(new Error('Could not load a helper; check your connection.')); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  async function pdfToText(buffer) {
    await loadScript(PDFJS);
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await lib.getDocument({ data: buffer }).promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      pages.push(C.pdfItemsToText(content.items));
      if (p % 5 === 0) toast('Reading page ' + p + ' of ' + pdf.numPages + '…', 1500);
    }
    let title = '';
    try { const meta = await pdf.getMetadata(); title = (meta && meta.info && meta.info.Title) || ''; } catch (e) { /* no metadata */ }
    const text = pages.join('\n\n');
    if (C.countWords(text) < 5) throw new Error('That PDF looks like scanned images, which Narra can’t read yet.');
    return { title, text };
  }

  async function docxToText(buffer) {
    await loadScript(MAMMOTH);
    const res = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return { title: '', text: res.value };
  }

  function htmlToText(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    return C.htmlDocToText(d);
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim(); }

  async function importFile(file) {
    const name = file.name || 'Untitled';
    const ext = (name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'pdf' || file.type === 'application/pdf') {
        toast('Opening ' + name + '…', 1500);
        const r = await pdfToText(await file.arrayBuffer());
        addItem(r.title || baseName(name), r.text, 'PDF');
      } else if (ext === 'docx') {
        const r = await docxToText(await file.arrayBuffer());
        addItem(baseName(name), r.text, 'Word');
      } else if (ext === 'html' || ext === 'htm' || file.type === 'text/html') {
        const r = htmlToText(await file.text());
        addItem(r.title || baseName(name), r.text, 'Web page');
      } else if (ext === 'md' || ext === 'markdown') {
        addItem(baseName(name), C.markdownToText(await file.text()), 'Markdown');
      } else if (ext === 'txt' || (file.type || '').startsWith('text/')) {
        addItem(baseName(name), await file.text(), 'Text');
      } else if (ext === 'doc') {
        toast('Old .doc files aren’t supported. Save it as .docx or PDF and try again.');
      } else {
        toast('Narra can open PDF, Word (.docx), text, Markdown and HTML files.');
      }
    } catch (err) {
      toast(err.message || 'Couldn’t open that file.');
    }
  }

  async function importUrl(url) {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('The site answered with an error (' + res.status + ').');
    const type = res.headers.get('content-type') || '';
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (type.includes('pdf') || /\.pdf($|\?)/i.test(url)) {
      const r = await pdfToText(await res.arrayBuffer());
      return addItem(r.title || host, r.text, host);
    }
    const body = await res.text();
    if (type.includes('html') || /<html|<body|<p[\s>]/i.test(body)) {
      const r = htmlToText(body);
      return addItem(r.title || host, r.text, host);
    }
    return addItem(host, body, host);
  }

  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importFile(f);
    e.target.value = '';
  });

  function openPaste() { $('pasteTitle').value = ''; $('pasteText').value = ''; $('pasteDlg').showModal(); setTimeout(() => $('pasteText').focus(), 30); }
  function openFile() { $('fileInput').click(); }
  function openUrl() { $('urlErr').textContent = ''; $('urlInput').value = ''; $('urlDlg').showModal(); }
  $('addPaste').addEventListener('click', () => { closeDrawer(); openPaste(); });
  $('addFile').addEventListener('click', () => { closeDrawer(); openFile(); });
  $('addUrl').addEventListener('click', () => { closeDrawer(); openUrl(); });
  $('welcomePaste').addEventListener('click', openPaste);
  $('welcomeFile').addEventListener('click', openFile);
  $('welcomeSample').addEventListener('click', () => addItem('Welcome to Narra', SAMPLE, 'Sample'));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('pasteForm').addEventListener('submit', (e) => {
    const text = $('pasteText').value;
    if (!text.trim()) { e.preventDefault(); return; }
    addItem($('pasteTitle').value, text, 'Text');
  });
  $('urlForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let url = $('urlInput').value.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    $('urlErr').textContent = '';
    $('urlGo').disabled = true;
    $('urlGo').textContent = 'Fetching…';
    try {
      await importUrl(url);
      $('urlDlg').close();
    } catch (err) {
      $('urlErr').textContent = err instanceof TypeError
        ? 'That site doesn’t let other apps load its pages. Open it, copy the text, and use Paste instead.'
        : err.message;
    } finally {
      $('urlGo').disabled = false;
      $('urlGo').textContent = 'Fetch and listen';
    }
  });

  // drag and drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; $('dropzone').classList.add('on'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('dropzone').classList.remove('on'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importFile(f);
  });

  // paste anywhere (outside text fields) adds the clipboard text as a new item
  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]') || document.querySelector('dialog[open]')) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text && C.countWords(text) > 3) { e.preventDefault(); addItem('', text, 'Text'); toast('Added from your clipboard.'); }
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    if (e.key === ' ' || e.key === 'k') { if (doc) { e.preventDefault(); toggle(); } }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? paraJump(1) : jump(idx + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? paraJump(-1) : jump(idx - 1); }
    else if (e.key === ']' || e.key === '+' || e.key === '=') { setRate(settings.rate + 0.1); if (playing) speak(idx); }
    else if (e.key === '[' || e.key === '-') { setRate(settings.rate - 0.1); if (playing) speak(idx); }
    else if (e.key === 'Escape') { document.querySelectorAll('.pop').forEach((p) => { p.hidden = true; }); closeDrawer(); }
  });

  // ---------------------------------------------------------------- mobile drawer
  function closeDrawer() { $('library').classList.remove('open'); }
  $('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('library').classList.toggle('open'); });
  $('page').addEventListener('click', closeDrawer);

  // ---------------------------------------------------------------- media session
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !current) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: 'Narra' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', pause);
      navigator.mediaSession.setActionHandler('previoustrack', () => jump(idx - 1));
      navigator.mediaSession.setActionHandler('nexttrack', () => jump(idx + 1));
    } catch (e) { /* not supported */ }
  }

  // stop speech when the page is closed so it doesn't carry on in the background
  window.addEventListener('pagehide', () => { if (synth) synth.cancel(); });

  // ---------------------------------------------------------------- sample
  const SAMPLE = [
    'Welcome to Narra.',
    'Narra turns the things you mean to read into things you can listen to. Paste an article, open a PDF or a Word file, or give it a link, and it will read the text aloud while lighting up each sentence and word as it goes.',
    'Press the big play button to start, or tap any sentence to jump straight to it. The arrows next to the play button step back or forward one sentence, and the outer ones skip a whole paragraph. On a keyboard, the space bar plays and pauses, and the left and right arrow keys move between sentences.',
    'The speed button on the left lets you slow down for something dense or speed up to three times for something you only need to skim. Pick a different voice on the right. Voices marked with a star usually sound the most natural.',
    'Everything you add stays in your library, on this device only, and Narra remembers where you stopped. Come back tomorrow and you will pick up at the same sentence.',
    'That’s it. Find something you’ve been meaning to get to, and let Narra read it to you.'
  ].join('\n\n');

  // ---------------------------------------------------------------- startup
  applyDisplay();
  setRate(settings.rate);
  renderLibrary();
  showWelcome();
  setPlayIcon();

  // Share target / deep link: ?text=...&title=... or ?url=...
  (function handleIncoming() {
    const q = new URLSearchParams(location.search);
    const sharedText = q.get('text') || '';
    const sharedUrl = q.get('url') || (/^https?:\/\/\S+$/.test(sharedText.trim()) ? sharedText.trim() : '');
    const title = q.get('title') || '';
    if (sharedUrl) {
      importUrl(sharedUrl).catch(() => toast('Couldn’t load that link. Copy the page text and paste it instead.', 6000));
    } else if (sharedText) {
      addItem(title, sharedText, 'Shared');
    } else {
      const last = library.slice().sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0];
      if (last) openItem(last.id);
    }
    if (q.toString()) history.replaceState(null, '', location.pathname);
  })();

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline mode is optional */ });
  }

  // exposed for tests and debugging
  window.Narra = { addItem, openItem, play, pause, jump, paraJump, setRate, get state() { return { idx, playing, current, doc, settings }; } };
})();
