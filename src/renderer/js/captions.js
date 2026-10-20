// Words on the video, like subtitles: the phrase being spoken, the word being spoken lit, words that are cut struck
// through (filler words violet, other cuts red). Most useful at 4x and 6x, where the sound is too fast to follow.
// C turns it on and off. Lines break at a pause, at the end of a sentence or after a dozen words.
import { segmentIndexAt, wordIndexAfter, escapeHtml } from './util.js';

const GAP = 0.7;            // a pause this long (s) starts a new line
const MAX_WORDS = 12;
const HOLD = 1.0;           // a line stays this long (s) after its last word
const LEAD = 0.15;          // and shows this long before its first

export class Captions {
  constructor(el) {
    this.el = el;
    this.enabled = true;
    this.words = null;
    this.lines = [];
    this.segments = [];
    this.version = 0;           // bumps when the cuts change, so a shown line is drawn again
    this.key = '';
  }

  setEnabled(on) {
    this.enabled = on;
    this.key = '';
    if (!on) this.el.hidden = true;
  }

  setWords(words) {
    this.words = words?.length ? words : null;
    this.lines = this.words ? toLines(this.words) : [];
    this.key = '';
    if (!this.words) this.el.hidden = true;
  }

  setSegments(segments) {
    this.segments = segments || [];
    this.version++;
  }

  setTime(t) {
    if (!this.enabled || !this.words) return;
    const line = this.lineAt(t);
    if (!line) {
      if (!this.el.hidden) { this.el.hidden = true; this.key = ''; }
      return;
    }
    const ws = this.words;
    const cursor = wordIndexAfter(ws, t);                      // the word being spoken, or the next one
    const speaking = cursor < ws.length && ws[cursor].s <= t;
    const key = `${line.from}|${cursor}|${speaking}|${this.version}`;
    if (key === this.key) return;
    this.key = key;
    let html = '';
    for (let i = line.from; i <= line.to; i++) {
      const w = ws[i];
      const seg = this.segments[segmentIndexAt(this.segments, (w.s + w.e) / 2)];
      const cut = seg && !seg.keep;
      const cls = ['w'];
      if (i < cursor) cls.push('past');
      if (i === cursor && speaking) cls.push('now');
      if (cut) cls.push(seg.reason === 'filler' && !seg.manual ? 'cut filler' : 'cut');
      html += `<span class="${cls.join(' ')}">${escapeHtml(w.w)}</span> `;
    }
    this.el.innerHTML = html;
    this.el.hidden = false;
  }

  /**
   * The line on screen at t, or null: the line being spoken; in a pause, the next line a moment before it starts,
   * else the last line for a moment after it ends.
   */
  lineAt(t) {
    const L = this.lines;
    let lo = 0;
    let hi = L.length - 1;
    let found = -1;                               // the last line that has started
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const line = L[found];
    if (line && t <= line.end) return line;
    const next = L[found + 1];
    if (next && next.start - t <= LEAD) return next;
    return line && t <= line.end + HOLD ? line : null;
  }
}

const SENTENCE_END = /[.!?]["')\]]*$/;
const CLAUSE_END = /[,;:]["')\]]*$/;

/** Phrases end at a pause or a full stop; a long phrase is split into even lines, at a comma when one is near. */
function toLines(ws) {
  const lines = [];
  let from = 0;
  for (let i = 1; i <= ws.length; i++) {
    const end = i === ws.length || ws[i].s - ws[i - 1].e >= GAP || SENTENCE_END.test(ws[i - 1].w);
    if (!end) continue;
    splitPhrase(ws, from, i - 1, lines);
    from = i;
  }
  return lines;
}

function splitPhrase(ws, a, b, lines) {
  const n = b - a + 1;
  const parts = Math.ceil(n / MAX_WORDS);
  let from = a;
  for (let k = 1; k < parts; k++) {
    let cut = a + Math.round((n * k) / parts) - 1;              // last word of this line
    for (let d = 0; d <= 3; d++) {                              // a comma within 3 words reads better
      if (cut - d > from && CLAUSE_END.test(ws[cut - d].w)) { cut -= d; break; }
      if (cut + d < b && CLAUSE_END.test(ws[cut + d].w)) { cut += d; break; }
    }
    cut = Math.min(b - 1, Math.max(from, cut));
    lines.push({ from, to: cut, start: ws[from].s, end: ws[cut].e });
    from = cut + 1;
  }
  lines.push({ from, to: b, start: ws[from].s, end: ws[b].e });
}
