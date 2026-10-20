'use strict';
// Filler words from the Whisper transcript, marked as cuts for review.
//
// Pure sounds (um, uh, ah, hmm...) are always cut. Word fillers (so, like, you know, actually...) are cut only when
// they stand alone: a pause or punctuation before them, and a pause or comma after them (or they open a sentence).
// That keeps "it's so good" and cuts "So, today..." and "it's, you know, simple".
// Each cut edge moves into the quietest 40 ms window of the gap next to the filler, never into the next word.

const SOUNDS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'ah', 'ahh', 'er', 'erm', 'hmm', 'hm', 'mm', 'mhm', 'huh', 'eh']);
const DEFAULT_LIST = 'um, uh, ah, er, hmm, you know, i mean, so, like, actually, basically, essentially, kind of, sort of, okay so, yeah so';
const PAUSE = 0.15;          // a gap this long between words counts as a boundary
const SENTENCE_PAUSE = 0.6;  // a gap this long counts as a new sentence
const EDGE_REACH = 0.25;     // how far into the gap an edge may move (s)
const SEGMENT = 0.04;

/** Word matching: punctuation dropped, lower case. */
const normalise = (s) => String(s).toLowerCase().replace(/[.,/#!?$%^&*;:{}=\-_`'"~()…]/g, '').trim();

/** "um, you know, so" -> [['you','know'], ['um'], ['so']] (longest first) */
function parseList(text) {
  const seen = new Set();
  const phrases = [];
  for (const raw of String(text || '').split(',')) {
    const words = raw.trim().split(/\s+/).map(normalise).filter(Boolean);
    const key = words.join(' ');
    if (words.length && !seen.has(key)) { seen.add(key); phrases.push(words); }
  }
  return phrases.sort((a, b) => b.length - a.length);
}

/** Time of the quietest 40 ms window whose centre lies in [a, b]; null when the gap holds no window. */
function quietest(levels, a, b) {
  if (!levels || b - a < SEGMENT) return null;
  const { db, shift = 0 } = levels;
  const i0 = Math.max(0, Math.ceil((a - shift) / SEGMENT - 0.5));
  const i1 = Math.min(db.length - 1, Math.floor((b - shift) / SEGMENT - 0.5));
  if (i1 < i0) return null;
  let best = i0;
  for (let i = i0 + 1; i <= i1; i++) if (db[i] < db[best]) best = i;
  return shift + (best + 0.5) * SEGMENT;
}

/**
 * words: [{w, s, e}] from Whisper; phrases: parseList(...)
 * opts: { duration, levels: {db, shift} } -> [{ start, end, text, sound }]
 */
function findFillers(words, phrases, { duration = Infinity, levels = null } = {}) {
  const out = [];
  if (!words?.length || !phrases?.length) return out;
  const n = words.length;
  const norm = words.map((w) => normalise(w.w));
  const endsSentence = (i) => i < 0 || /[.?!…]["')\]]?$/.test(words[i].w);
  const endsClause = (i) => i >= 0 && /[,;:–—-]["')\]]?$/.test(words[i].w);
  const gapBefore = (i) => (i === 0 ? Infinity : words[i].s - words[i - 1].e);
  const gapAfter = (j) => (j >= n - 1 ? Infinity : words[j + 1].s - words[j].e);

  for (let i = 0; i < n;) {
    let hit = null;
    for (const ph of phrases) {
      if (i + ph.length > n) continue;
      let same = true;
      for (let k = 0; k < ph.length && same; k++) same = norm[i + k] === ph[k];
      if (!same) continue;
      const last = i + ph.length - 1;
      const sound = ph.every((p) => SOUNDS.has(p));
      const sentenceStart = i === 0 || endsSentence(i - 1) || gapBefore(i) >= SENTENCE_PAUSE;
      const before = sentenceStart || gapBefore(i) >= PAUSE || endsClause(i - 1);
      const after = last === n - 1 || gapAfter(last) >= PAUSE || endsClause(last) || endsSentence(last);
      if (sound || (before && (after || sentenceStart))) { hit = { last, sound }; break; }
    }
    if (!hit) { i++; continue; }
    const prevEnd = i > 0 ? words[i - 1].e : 0;
    const nextStart = hit.last < n - 1 ? words[hit.last + 1].s : Math.min(duration, words[hit.last].e + EDGE_REACH);
    const s = words[i].s;
    const e = words[hit.last].e;
    let start = quietest(levels, Math.max(prevEnd, s - EDGE_REACH), s);
    let end = quietest(levels, e, Math.min(nextStart, e + EDGE_REACH));
    if (start === null) start = Math.max(prevEnd, Math.min(s, (prevEnd + s) / 2 + 0.01));
    if (end === null) end = Math.min(nextStart, Math.max(e, (e + nextStart) / 2 - 0.01));
    if (end > start) {
      out.push({ start, end, text: words.slice(i, hit.last + 1).map((w) => w.w.replace(/[.,!?;:…]+$/, '')).join(' '), sound: hit.sound });
    }
    i = hit.last + 1;
  }
  return out;
}

module.exports = { findFillers, parseList, normalise, DEFAULT_LIST, SOUNDS };
