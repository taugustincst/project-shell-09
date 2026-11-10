const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const C = require('../core.js');

test('splits paragraphs and sentences, keeping abbreviations together', () => {
  const d = C.buildDocument('Dr. Smith went to Washington. He arrived at 3.5 p.m. sharp!\n\nSecond paragraph? Yes.');
  const texts = d.sentences.map((s) => s.text);
  assert.ok(texts[0].startsWith('Dr. Smith went to Washington.'), texts[0]);
  assert.strictEqual(d.paragraphs.length, 2);
  assert.deepStrictEqual(texts.slice(-2), ['Second paragraph?', 'Yes.']);
  assert.strictEqual(d.sentences[d.sentences.length - 1].para, 1);
});

test('regex fallback splitter handles initials and decimals', () => {
  const s = C._regexSentences('J. R. R. Tolkien wrote 2.5 books. Then he rested. The end');
  assert.deepStrictEqual(s, ['J. R. R. Tolkien wrote 2.5 books.', 'Then he rested.', 'The end']);
});

test('single newlines inside a paragraph become spaces', () => {
  const d = C.buildDocument('This line wraps\nonto the next line.\nAnd keeps go-\ning.');
  assert.strictEqual(d.paragraphs.length, 1);
  assert.strictEqual(d.sentences[0].text, 'This line wraps onto the next line.');
  assert.strictEqual(d.sentences[1].text, 'And keeps going.');
});

test('long sentences are chunked under the limit at natural breaks', () => {
  const long = Array.from({ length: 40 }, (_, i) => 'clause number ' + i).join(', ') + '.';
  const d = C.buildDocument(long);
  assert.ok(d.sentences.length > 1);
  for (const s of d.sentences) assert.ok(s.text.length <= C.MAX_CHUNK, s.text.length);
  assert.strictEqual(d.sentences.map((s) => s.text).join(' ').replace(/\s+/g, ' '), long);
});

test('counts words and estimates time', () => {
  assert.strictEqual(C.countWords("It's a well-known fact, 42 times."), 6);
  assert.strictEqual(C.formatDuration(C.minutesFor(165 * 90, 1)), '1 h 30 min');
  assert.strictEqual(C.formatDuration(C.minutesFor(165 * 10, 2)), '5 min');
  assert.strictEqual(C.formatDuration(0.3), '<1 min');
});

test('wordAt finds the spoken word', () => {
  const t = 'Hello, wonderful world.';
  assert.deepStrictEqual(C.wordAt(t, 7), { start: 7, end: 16 });
  assert.deepStrictEqual(C.wordAt(t, 5), { start: 7, end: 16 });
  assert.deepStrictEqual(C.wordAt(t, 0, 5), { start: 0, end: 5 });
  assert.strictEqual(C.wordAt(t, 99), null);
});

test('guessTitle trims to a readable length', () => {
  assert.strictEqual(C.guessTitle('\n\nShort title\nbody'), 'Short title');
  const t = C.guessTitle('word '.repeat(40));
  assert.ok(t.length <= 70 && t.endsWith('…'));
});

test('htmlDocToText keeps the article and drops page chrome', () => {
  const html = `<html><head><title>Site | Story</title><style>p{}</style></head><body>
    <nav>Home About</nav><header>Logo</header>
    <article><h1>The Big Story</h1><p>${'First paragraph of the story. '.repeat(8)}</p>
    <ul><li>Point one</li><li>Point <b>two</b></li></ul><script>alert(1)</script></article>
    <footer>Copyright</footer></body></html>`;
  const doc = new JSDOM(html).window.document;
  const r = C.htmlDocToText(doc);
  assert.strictEqual(r.title, 'The Big Story');
  assert.ok(r.text.startsWith('The Big Story.\n\nFirst paragraph'));
  assert.ok(r.text.includes('Point two'));
  assert.ok(!/Home About|Copyright|alert|Logo/.test(r.text));
});

test('markdownToText strips syntax but keeps words', () => {
  const t = C.markdownToText('# Heading\n\nSome **bold** and *italic* with a [link](http://x.y) and snake_case_name.\n\n- item\n\n```\ncode\n```');
  assert.ok(t.includes('Heading.'));
  assert.ok(t.includes('Some bold and italic with a link and snake_case_name.'));
  assert.ok(!t.includes('code'));
  assert.ok(t.includes('item') && !t.includes('- item'));
});

test('pdfItemsToText rebuilds lines and paragraphs', () => {
  const it = (str, y) => ({ str, transform: [1, 0, 0, 1, 0, y] });
  const t = C.pdfItemsToText([it('First line', 700), it('second line.', 688), it('New para', 650)]);
  assert.strictEqual(t, 'First line\nsecond line.\n\nNew para');
  const d = C.buildDocument(t);
  assert.strictEqual(d.paragraphs.length, 2);
});
