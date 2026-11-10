/*
 * Narra core: pure text helpers with no DOM or speech dependencies.
 * Loaded by index.html as a classic script (window.NarraCore) and by the
 * Node tests through module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NarraCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Chrome's speech engine can stop mid-utterance on long strings, so no
  // single spoken chunk is allowed to grow past this many characters.
  const MAX_CHUNK = 240;

  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd',
    'co', 'corp', 'dept', 'univ', 'fig', 'no', 'vol', 'approx', 'e.g', 'i.e',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'mt', 'ft', 'ave', 'blvd', 'rd', 'gen', 'gov', 'sen', 'rep', 'lt', 'col', 'capt'
  ]);

  /** Collapse whitespace inside paragraphs and keep blank-line paragraph breaks. */
  function normalizeText(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/-\n(?=[a-z])/g, '')        // re-join words hyphenated across lines
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Split normalized text into paragraphs (blank-line separated). Single newlines become spaces. */
  function splitParagraphs(text) {
    return normalizeText(text)
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim())
      .filter(Boolean);
  }

  function regexSentences(para) {
    const out = [];
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g;
    let m;
    let carry = '';
    while ((m = re.exec(para)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      const piece = carry + m[0];
      const trimmed = piece.trim();
      const lastWord = (trimmed.match(/([A-Za-z.]+)\.$/) || [])[1];
      const isAbbrev = lastWord && ABBREVIATIONS.has(lastWord.toLowerCase().replace(/\.$/, ''));
      const isInitial = /\b[A-Z]\.$/.test(trimmed);
      const isDecimal = /\d\.$/.test(trimmed) && /^\d/.test(para.slice(re.lastIndex));
      if ((isAbbrev || isInitial || isDecimal) && re.lastIndex < para.length) {
        carry = piece;
        continue;
      }
      out.push(trimmed);
      carry = '';
    }
    if (carry.trim()) out.push(carry.trim());
    return out.filter(Boolean);
  }

  let segmenter = null;
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    }
  } catch (e) { segmenter = null; }

  function rawSentences(para) {
    if (segmenter) {
      const parts = [];
      for (const s of segmenter.segment(para)) {
        const t = s.segment.trim();
        if (!t) continue;
        // Intl.Segmenter splits after abbreviations like "Dr." too; merge those back.
        const prev = parts[parts.length - 1];
        const prevWord = prev && (prev.match(/([A-Za-z.]+)\.$/) || [])[1];
        if (prev && prevWord && (ABBREVIATIONS.has(prevWord.toLowerCase().replace(/\.$/, '')) || /^[A-Z]$/.test(prevWord))) {
          parts[parts.length - 1] = prev + ' ' + t;
        } else {
          parts.push(t);
        }
      }
      return parts;
    }
    return regexSentences(para);
  }

  /** Break a sentence that is too long to speak in one go at a natural pause. */
  function chunkLong(sentence, max) {
    max = max || MAX_CHUNK;
    const out = [];
    let rest = sentence;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = -1;
      const prefs = [/[;:]\s/g, /,\s/g, /\s[—–-]\s/g, /\s/g];
      for (const re of prefs) {
        let m;
        let last = -1;
        while ((m = re.exec(window)) !== null) {
          if (m.index > max * 0.4) last = m.index + m[0].length;
        }
        if (last > 0) { cut = last; break; }
      }
      if (cut <= 0) cut = max;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  /**
   * Turn text into a reading document:
   * { paragraphs: [[sentenceIndex,...]], sentences: [{ text, para }] , words }
   */
  function buildDocument(text) {
    const paragraphs = [];
    const sentences = [];
    splitParagraphs(text).forEach((para, pi) => {
      const ids = [];
      rawSentences(para).forEach((s) => {
        chunkLong(s).forEach((chunk) => {
          ids.push(sentences.length);
          sentences.push({ text: chunk, para: pi });
        });
      });
      if (ids.length) paragraphs.push(ids);
    });
    return { paragraphs, sentences, words: countWords(text) };
  }

  function countWords(text) {
    const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return m ? m.length : 0;
  }

  /** Word bounds around a character index, for live word highlighting. */
  function wordAt(text, charIndex, charLength) {
    if (charIndex == null || charIndex < 0 || charIndex >= text.length) return null;
    if (charLength && charLength > 0) {
      return { start: charIndex, end: Math.min(text.length, charIndex + charLength) };
    }
    const isWord = (c) => /[\p{L}\p{N}'’-]/u.test(c);
    let start = charIndex;
    while (start < text.length && !isWord(text[start])) start++;
    if (start >= text.length) return null;
    let end = start;
    while (end < text.length && isWord(text[end])) end++;
    return { start, end };
  }

  /** Roughly 165 spoken words a minute at 1x. */
  function minutesFor(words, rate) {
    const wpm = 165 * (rate || 1);
    return words / wpm;
  }

  function formatDuration(minutes) {
    if (!isFinite(minutes) || minutes <= 0) return '0 min';
    if (minutes < 1) return '<1 min';
    if (minutes < 60) return Math.round(minutes) + ' min';
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }

  /** A readable title from the first line of the text. */
  function guessTitle(text, fallback) {
    const first = normalizeText(text).split('\n').find((l) => l.trim().length > 2) || '';
    const t = first.trim().replace(/\s+/g, ' ');
    if (!t) return fallback || 'Untitled';
    return t.length > 70 ? t.slice(0, 67).replace(/\s+\S*$/, '') + '…' : t;
  }

  /**
   * Extract readable text from an HTML document. Needs a Document (browser
   * DOMParser result, or jsdom in tests).
   */
  function htmlDocToText(doc) {
    const drop = 'script,style,noscript,template,svg,canvas,iframe,nav,footer,header,aside,form,button,figure figcaption,[aria-hidden="true"],[hidden]';
    doc.querySelectorAll(drop).forEach((el) => el.remove());
    const candidates = ['article', 'main', '[role="main"]', '#content', '.content', '.post', '.entry-content'];
    let rootEl = null;
    for (const sel of candidates) {
      const el = doc.querySelector(sel);
      if (el && el.textContent.trim().length > 200) { rootEl = el; break; }
    }
    rootEl = rootEl || doc.body || doc.documentElement;
    const blocks = [];
    const blockSel = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,dd,dt';
    const nodes = rootEl.querySelectorAll(blockSel);
    if (nodes.length) {
      nodes.forEach((el) => {
        // skip blocks nested inside another selected block (e.g. p inside li)
        if (el.parentElement && el.parentElement.closest(blockSel) && rootEl.contains(el.parentElement.closest(blockSel))) return;
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (t) blocks.push(/^H[1-6]$/.test(el.tagName) && !/[.!?:]$/.test(t) ? t + '.' : t);
      });
    }
    if (!blocks.length) blocks.push(rootEl.textContent.replace(/\s+/g, ' ').trim());
    const titleEl = doc.querySelector('title');
    const h1 = doc.querySelector('h1');
    return {
      title: (h1 && h1.textContent.trim()) || (titleEl && titleEl.textContent.trim()) || '',
      text: blocks.join('\n\n')
    };
  }

  /** Plain-text cleanup for Markdown: drop syntax that sounds bad read aloud. */
  function markdownToText(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+(.*)$/gm, (m, t) => (/[.!?:]$/.test(t) ? t : t + '.'))
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)([^*_\n]*?\S)\2(?=[^\w*]|$)/g, '$1$3')
      .replace(/^\s*[-*_]{3,}\s*$/gm, '');
  }

  /** Join pdf.js text items into lines and paragraphs. items: [{str, transform:[..,x,y], hasEOL}] */
  function pdfItemsToText(items) {
    let out = '';
    let lastY = null;
    let lastGap = 0;
    for (const it of items) {
      const y = it.transform ? it.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) {
        const gap = Math.abs(y - lastY);
        // a jump much larger than normal line spacing means a new paragraph
        out += lastGap && gap > lastGap * 1.6 ? '\n\n' : '\n';
        lastGap = lastGap ? Math.min(lastGap, gap) : gap;
      } else if (out && !/\s$/.test(out) && it.str && !/^\s/.test(it.str)) {
        out += ' ';
      }
      out += it.str || '';
      if (it.hasEOL) { out += '\n'; }
      if (y !== null) lastY = y;
    }
    return out;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return {
    MAX_CHUNK,
    normalizeText,
    splitParagraphs,
    chunkLong,
    buildDocument,
    countWords,
    wordAt,
    minutesFor,
    formatDuration,
    guessTitle,
    htmlDocToText,
    markdownToText,
    pdfItemsToText,
    uid,
    _regexSentences: regexSentences
  };
});
