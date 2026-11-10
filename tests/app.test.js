// Runs the real page in jsdom with a fake speech engine to check the player end to end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function fakeSpeech(window) {
  const log = [];
  const synth = {
    speaking: false, pending: false, paused: false, _cur: null, _timers: [],
    getVoices: () => [
      { name: 'Robot', voiceURI: 'robot', lang: 'en-US', localService: true, default: true },
      { name: 'Ava (Natural)', voiceURI: 'ava', lang: 'en-US', localService: false, default: false },
      { name: 'Hans', voiceURI: 'hans', lang: 'de-DE', localService: true, default: false }
    ],
    addEventListener() {},
    speak(u) {
      log.push({ text: u.text, rate: u.rate, voice: u.voice && u.voiceURI !== undefined ? u.voice.voiceURI : u.voice && u.voice.voiceURI });
      this._cur = u; this.speaking = true;
      const words = [...u.text.matchAll(/\S+/g)];
      words.forEach((m, k) => this._timers.push(setTimeout(() => u.onboundary && u.onboundary({ name: 'word', charIndex: m.index, charLength: m[0].length }), 1 + k)));
      this._timers.push(setTimeout(() => { if (this._cur === u) { this.speaking = false; this._cur = null; u.onend && u.onend({}); } }, 5 + words.length));
    },
    cancel() {
      this._timers.forEach(clearTimeout); this._timers = [];
      const u = this._cur; this._cur = null; this.speaking = false;
      if (u && u.onerror) u.onerror({ error: 'interrupted' });
    },
    resume() {}, pause() {}
  };
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  return { synth, log };
}

function boot(storage) {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace('<script src="core.js"></script>', '')
    .replace('<script src="app.js"></script>', '');
  const dom = new JSDOM(html, { url: 'https://narra.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (storage) for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
  const speech = fakeSpeech(w);
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  w.Element.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  w.confirm = () => true;
  w.eval(fs.readFileSync(path.join(root, 'core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  opened.push(w);
  return { w, dom, ...speech };
}

const opened = [];
test.after(() => opened.forEach((w) => w.close()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('reads a document through to the end, highlighting as it goes', async () => {
  const { w, log } = boot();
  const d = w.document;
  assert.ok(d.getElementById('welcome').hidden === false);
  // prefers the natural-sounding US voice
  assert.strictEqual(d.getElementById('voiceSelect').value, 'ava');

  w.Narra.addItem('Test', 'One two three. Four five.\n\nSix seven eight.', 'Text');
  assert.strictEqual(d.getElementById('docTitle').textContent, 'Test');
  assert.strictEqual(d.querySelectorAll('#text .s').length, 3);
  assert.strictEqual(d.querySelectorAll('#text p').length, 2);

  let sawWord = false;
  const obs = new w.MutationObserver(() => { if (d.querySelector('mark.w')) sawWord = true; });
  obs.observe(d.getElementById('text'), { subtree: true, childList: true });

  d.getElementById('playBtn').click();
  assert.strictEqual(w.Narra.state.playing, true);
  await wait(120);
  assert.deepStrictEqual(log.map((l) => l.text), ['One two three.', 'Four five.', 'Six seven eight.']);
  assert.ok(sawWord, 'a word was highlighted');
  assert.strictEqual(w.Narra.state.playing, false);
  assert.strictEqual(w.Narra.state.idx, 2);
  assert.match(d.getElementById('toast').textContent, /Finished/);
  // play again starts over
  d.getElementById('playBtn').click();
  assert.strictEqual(log[log.length - 1].text, 'One two three.');
  w.Narra.pause();
});

test('pause, skip, speed and click-to-jump', async () => {
  const { w, log, synth } = boot();
  const d = w.document;
  w.Narra.addItem('Skip', 'A one. B two. C three.\n\nD four. E five.', 'Text');
  d.getElementById('playBtn').click();
  d.getElementById('playBtn').click(); // pause right away
  assert.strictEqual(w.Narra.state.playing, false);
  assert.strictEqual(synth.speaking, false);
  await wait(40);
  assert.strictEqual(log.length, 1, 'nothing else spoken after pause');

  d.getElementById('nextPara').click();
  assert.strictEqual(w.Narra.state.idx, 3);
  d.getElementById('prevSent').click();
  assert.strictEqual(w.Narra.state.idx, 2);
  d.getElementById('prevPara').click();
  assert.strictEqual(w.Narra.state.idx, 0);

  w.Narra.setRate(1.75);
  assert.strictEqual(d.getElementById('speedBtn').textContent, '1.75×');
  d.querySelector('#text .s[data-i="4"]').click();
  assert.strictEqual(w.Narra.state.playing, true);
  assert.strictEqual(log[log.length - 1].text, 'E five.');
  assert.strictEqual(log[log.length - 1].rate, 1.75);
  await wait(40);
  assert.strictEqual(w.Narra.state.playing, false);
});

test('library keeps items and reading position across reloads', async () => {
  const first = boot();
  first.w.Narra.addItem('Keep me', 'S1 here. S2 here. S3 here. S4 here.', 'Text');
  first.w.Narra.jump(2);
  await wait(900); // position is saved shortly after it changes
  const stored = {
    'narra.library.v1': first.w.localStorage.getItem('narra.library.v1'),
    'narra.settings.v1': first.w.localStorage.getItem('narra.settings.v1')
  };
  const second = boot(stored);
  const d = second.w.document;
  assert.strictEqual(d.getElementById('docTitle').textContent, 'Keep me');
  assert.strictEqual(second.w.Narra.state.idx, 2);
  assert.ok(d.querySelector('.s[data-i="2"]').classList.contains('on'));
  assert.strictEqual(d.querySelectorAll('#items .item').length, 1);
  assert.match(d.querySelector('#items .item .m').textContent, /67% read/);
  // delete it
  d.querySelector('#items .del').click();
  assert.strictEqual(d.querySelectorAll('#items .item').length, 0);
  assert.strictEqual(d.getElementById('welcome').hidden, false);
});

test('paste dialog and imported HTML file', async () => {
  const { w } = boot();
  const d = w.document;
  d.getElementById('welcomePaste').click();
  d.getElementById('pasteTitle').value = 'Pasted';
  d.getElementById('pasteText').value = 'Pasted text goes here. And here.';
  d.getElementById('pasteForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
  assert.strictEqual(d.getElementById('docTitle').textContent, 'Pasted');

  const file = new w.File(['<html><body><nav>menu</nav><p>Hello from a saved page.</p></body></html>'], 'saved_page.html', { type: 'text/html' });
  if (!file.text) file.text = async () => '<html><body><nav>menu</nav><p>Hello from a saved page.</p></body></html>';
  const input = d.getElementById('fileInput');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new w.Event('change'));
  await wait(30);
  assert.strictEqual(d.getElementById('docTitle').textContent, 'saved page');
  assert.strictEqual(d.querySelector('#text').textContent.trim(), 'Hello from a saved page.');
});

test('shared text from the Android share sheet opens as a new item', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://narra.test/?title=Shared%20note&text=Read%20this%20please.%20Thanks.', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  opened.push(w);
  fakeSpeech(w);
  w.HTMLElement.prototype.scrollTo = function () {};
  w.eval(fs.readFileSync(path.join(root, 'core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  assert.strictEqual(w.document.getElementById('docTitle').textContent, 'Shared note');
  assert.strictEqual(w.location.search, '');
});
