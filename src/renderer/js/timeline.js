// The timeline canvas: ruler, the piece bar (one bar per piece: click it to cut or keep that piece),
// waveform (40 ms loudness windows), cut pieces (silence red, filler words violet, your cuts amber), louder ranges
// (cyan, waveform drawn louder), your splits (S), the cut preview will play (dashed outline), the words lane (the
// word being spoken lights up), playhead and an overview strip of the whole recording.
// While playing, the view follows: the playhead walks to the middle and stays there, the recording slides under it.
// Paused, the view stays put: click moves the playhead, drag or the wheel slides the view, Ctrl + wheel zooms.
import { clamp, fmtTime, segmentIndexAt, wordIndexAfter } from './util.js';
import { pieceAt } from './pieces.js';

const SEG = 0.04;           // analysis window (s)
const DB_FLOOR = -80;       // bottom of the waveform scale
const RULER_H = 24;
const BAR_H = 15;           // the piece bar under the ruler
const WORDS_H = 40;         // one row of words, or two staggered rows when they are tight
const OVERVIEW_H = 12;
const DRAG_PX = 4;          // movement that turns a click into a slide of the view
const FOLLOW_HOLD_MS = 1500;// after sliding the view by hand while playing, following waits this long
const GLIDE_S = 0.18;       // how fast the view eases the playhead back to the middle
const FONT = '13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const FONT_NOW = '600 13px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const FONT_2 = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const FONT_2_NOW = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const FONT_SMALL = '11px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const MONO = '11px "Cascadia Mono", Consolas, monospace';
const STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const BAR = {               // piece bar colours: kept, and cut by reason
  keep: 'oklch(0.72 0.15 155 / 0.78)', keepHover: 'oklch(0.82 0.16 155)',
  silence: 'oklch(0.62 0.17 25 / 0.85)', silenceHover: 'oklch(0.72 0.18 25)',
  filler: 'oklch(0.66 0.15 300 / 0.9)', fillerHover: 'oklch(0.76 0.16 300)',
  yours: 'oklch(0.74 0.15 70 / 0.9)', yoursHover: 'oklch(0.84 0.16 70)',
};

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const amp = (db) => (db <= DB_FLOOR ? 0 : Math.min(1, (db - DB_FLOOR) / -DB_FLOOR));
const barKind = (p) => (p.keep ? 'keep' : p.manual ? 'yours' : p.reason === 'filler' ? 'filler' : 'silence');

export class Timeline {
  /** handlers: onSeek(t), onToggleAt(t), onTogglePiece(piece), onView(view) */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;
    this.duration = 1;
    this.levels = null;
    this.shift = 0;
    this.segments = [];
    this.pieces = [];           // segments split again at your splits and edit edges (what the bar shows)
    this.splits = [];
    this.gains = [];
    this.words = null;
    this.pass = null;           // the cut preview will play instead of jumping over ({start, end})
    this.time = 0;
    this.view = { start: 0, end: 1 };
    this.follow = { off: null, at: 0, t: 0, holdUntil: 0 };
    this.hoverX = null;
    this.hoverZone = null;
    this.drag = null;
    this.raf = 0;
    this.W = 0;
    this.H = 0;
    this.dpr = 1;
    this.c = {
      bg: css('--bg-sunk'), lane: css('--bg'), line: css('--line-soft'), line2: css('--line'),
      text: css('--text'), text2: css('--text-2'), text3: css('--text-3'),
      keep: css('--accent'), cut: css('--cut'), cutSoft: css('--cut-soft'), cutWave: css('--cut-wave'),
      filler: css('--filler'), fillerSoft: css('--filler-soft'), edit: css('--edit'), gain: css('--gain'),
    };
    this.hatch = this.makeHatch('oklch(0.66 0.17 25 / 0.28)');
    this.fillerHatch = this.makeHatch('oklch(0.72 0.15 300 / 0.32)');
    this.widths = new Map();

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => { this.drag = null; this.canvas.style.cursor = ''; });
    canvas.addEventListener('pointerleave', () => { if (!this.drag) { this.hoverX = null; this.hoverZone = null; this.request(); } });
    canvas.addEventListener('dblclick', (e) => this.onDouble(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
  }

  // ---------- data in
  setData({ duration, levels, shift = 0 }) {
    this.duration = Math.max(0.1, duration);
    this.levels = levels;
    this.shift = shift;
    this.pass = null;
    this.time = 0;
    this.follow = { off: null, at: 0, t: 0, holdUntil: 0 };
    this.view = { start: 0, end: this.duration };
    this.request();
  }

  setSegments(segments) { this.segments = segments || []; this.request(); }
  setPieces(pieces, splits) { this.pieces = pieces || []; this.splits = splits || []; this.request(); }
  setGains(gains) { this.gains = gains || []; this.request(); }
  setWords(words) { this.words = words && words.length ? words : null; this.widths.clear(); this.request(); }
  setPass(range) { this.pass = range; this.request(); }

  /** The playhead moved. Playing: the view follows it. Paused: the view only moves if the playhead left it. */
  setTime(t, playing = false) {
    const moved = Math.abs(t - this.time) > 1e-4;
    this.time = t;
    if (playing) this.followTo(t);
    else {
      this.follow.off = null;
      if (moved) this.keepInView(t);
    }
    this.request();
  }

  // ---------- view
  /** user = false for the view's own following (it then keeps its follow state). */
  setView(start, end, user = true) {
    const minSpan = 0.4;
    const span = clamp(end - start, Math.min(minSpan, this.duration), this.duration);
    const s = clamp(start, 0, Math.max(0, this.duration - span));
    this.view = { start: s, end: s + span };
    if (user) this.follow.off = null;
    this.request();
    this.h.onView?.(this.view);
  }

  zoom(factor, at = (this.view.start + this.view.end) / 2) {
    const span = this.view.end - this.view.start;
    const next = span * factor;
    const ratio = (at - this.view.start) / span;
    this.setView(at - ratio * next, at - ratio * next + next);
  }

  fit() { this.setView(0, this.duration); }

  /** Brings t into view (centred) without changing the zoom. */
  reveal(t) {
    const span = this.view.end - this.view.start;
    if (t < this.view.start + span * 0.05 || t > this.view.end - span * 0.05) this.setView(t - span / 2, t + span / 2);
  }

  /** Paused: a playhead just past an edge (frame steps) nudges the view; one far away is centred. */
  keepInView(t) {
    const { start, end } = this.view;
    const span = end - start;
    if (t >= start && t <= end) return;
    const over = t > end ? t - end : start - t;
    if (over > span * 0.25) { this.setView(t - span / 2, t + span / 2); return; }
    const s = t > end ? t - span * 0.9 : t - span * 0.1;
    this.setView(s, s + span);
  }

  /** Sliding the view by hand: while playing, following waits a moment so the slide sticks. */
  holdFollow() {
    this.follow.holdUntil = performance.now() + FOLLOW_HOLD_MS;
    this.follow.off = null;
  }

  /**
   * Playing: the playhead walks to the middle of the view and then stays there while the recording slides under
   * it. Right of the middle (a jump forward, a skipped cut), the view eases it back; out of view, the view goes there.
   * The view never scrolls past the start or the end, so there the playhead moves on its own.
   */
  followTo(t) {
    const f = this.follow;
    const now = performance.now();
    const elapsed = f.at ? (now - f.at) / 1000 : 0;
    const dt = Math.min(0.1, elapsed);
    f.at = now;
    const jumped = t < f.t - 1e-3 || t - f.t > Math.max(0.5, elapsed * 7);   // a seek or a skipped cut, not playing
    f.t = t;
    if (now < f.holdUntil) return;
    const span = this.view.end - this.view.start;
    if (span >= this.duration - 1e-6) return;                    // the whole recording is in view
    const vs = this.view.start;
    const mid = vs + span / 2;
    if (t < vs || t > vs + span) { f.off = 0; this.setView(t - span / 2, t + span / 2, false); return; }
    if (f.off === null || jumped) f.off = t - mid;
    if (f.off < 0) {                                              // left of the middle: walk to it, the view waits
      f.off = t - mid;
      if (f.off < 0) return;
      f.off = 0;
    } else if (f.off > 0) {                                       // right of the middle: glide back to it
      f.off *= Math.exp(-dt / GLIDE_S);
      if (f.off < span * 1e-4) f.off = 0;
    }
    const s = t - span / 2 - f.off;
    this.setView(s, s + span, false);
  }

  // ---------- geometry
  x(t) { return ((t - this.view.start) / (this.view.end - this.view.start)) * this.W; }
  t(x) { return this.view.start + (x / this.W) * (this.view.end - this.view.start); }

  get rows() {
    const bar = { y: RULER_H + 3, h: BAR_H };
    const overview = { y: this.H - OVERVIEW_H - 5, h: OVERVIEW_H };
    const words = { y: overview.y - 8 - WORDS_H, h: WORDS_H };
    const waveY = bar.y + bar.h + 5;
    const wave = { y: waveY, h: Math.max(24, words.y - 6 - waveY) };
    return { bar, wave, words, overview };
  }

  zoneAt(y) {
    const r = this.rows;
    if (y >= r.overview.y - 3) return 'overview';
    if (y < RULER_H) return 'ruler';
    if (y < r.bar.y + r.bar.h + 3) return 'bar';
    if (y >= r.words.y - 3) return 'words';
    return 'wave';
  }

  segmentAt(t) {
    const i = segmentIndexAt(this.segments, t);
    return i < 0 ? null : this.segments[i];
  }

  keptAt(t) { return this.segmentAt(t)?.keep ?? true; }

  gainAt(t) {
    for (const g of this.gains) if (t >= g.start && t < g.end) return g.db;
    return 0;
  }

  wordAt(t) {
    if (!this.words) return null;
    const i = wordIndexAfter(this.words, t);
    const w = this.words[i];
    return w && w.s <= t + 0.05 ? w : null;
  }

  /** The piece the pointer is over in the bar, or null. */
  get hoverPiece() {
    if (this.hoverZone !== 'bar' || this.hoverX === null) return null;
    return pieceAt(this.pieces, this.t(this.hoverX));
  }

  // ---------- drawing
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.round(r.width));
    this.H = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.draw();
  }

  request() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  makeHatch(color) {
    const p = document.createElement('canvas');
    p.width = 8;
    p.height = 8;
    const g = p.getContext('2d');
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-2, 10); g.lineTo(10, -2);
    g.moveTo(6, 10); g.lineTo(10, 6);
    g.moveTo(-2, 2); g.lineTo(2, -2);
    g.stroke();
    return this.ctx.createPattern(p, 'repeat');
  }

  draw() {
    const { ctx, W, H } = this;
    if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.c.bg;
    ctx.fillRect(0, 0, W, H);
    const rows = this.rows;
    ctx.fillStyle = this.c.lane;
    ctx.fillRect(0, rows.wave.y - 1, W, rows.words.y + rows.words.h - rows.wave.y + 2);
    this.drawPieces(rows);
    this.drawWave(rows);
    this.drawGains(rows);
    this.drawWords(rows);
    this.drawPass(rows);
    this.drawSplits(rows);
    this.drawRuler();
    this.drawBar(rows);
    this.drawOverview(rows);
    this.drawPlayhead(rows);
    this.drawHover(rows);
  }

  drawPieces({ wave, words }) {
    const { ctx } = this;
    const top = wave.y - 1;
    const bottom = words.y + words.h + 1;
    let i = Math.max(0, segmentIndexAt(this.segments, this.view.start));
    for (; i < this.segments.length && this.segments[i].start < this.view.end; i++) {
      const s = this.segments[i];
      const x0 = Math.max(0, this.x(s.start));
      const x1 = Math.min(this.W, this.x(s.end));
      if (x1 <= x0) continue;
      if (!s.keep) {
        const filler = s.reason === 'filler' && !s.manual;
        ctx.fillStyle = filler ? this.c.fillerSoft : this.c.cutSoft;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
        ctx.fillStyle = filler ? this.fillerHatch : this.hatch;
        ctx.fillRect(x0, top, x1 - x0, bottom - top);
        if (x1 - x0 > 1) {
          ctx.fillStyle = filler ? 'oklch(0.72 0.15 300 / 0.6)' : 'oklch(0.66 0.17 25 / 0.5)';
          ctx.fillRect(x0, top, 1, bottom - top);
          ctx.fillRect(x1 - 1, top, 1, bottom - top);
        }
        if (filler && s.text) {                              // the filler word, on top of its cut
          ctx.font = FONT_SMALL;
          const label = s.text;
          const tw = this.textWidth(label, FONT_SMALL);
          if (x1 - x0 >= Math.min(tw + 8, 34)) {
            ctx.fillStyle = 'oklch(0.3 0.08 300 / 0.92)';
            this.roundRect(x0 + 2, top + 3, Math.min(tw + 8, x1 - x0 - 4), 16, 5);
            ctx.fill();
            ctx.save();
            ctx.beginPath();
            ctx.rect(x0 + 2, top + 3, x1 - x0 - 4, 16);
            ctx.clip();
            ctx.fillStyle = this.c.filler;
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x0 + 6, top + 11.5);
            ctx.restore();
          }
        }
      }
    }
  }

  /** One bar per piece: green kept, red pause, violet filler word, amber your cut. Click a bar to flip it. */
  drawBar({ bar }) {
    const { ctx } = this;
    const hover = this.hoverPiece;
    let i = Math.max(0, segmentIndexAt(this.pieces, this.view.start));
    for (; i < this.pieces.length && this.pieces[i].start < this.view.end; i++) {
      const p = this.pieces[i];
      const x0 = this.x(p.start);
      const x1 = this.x(p.end);
      const w = x1 - x0;
      const gap = w > 5 ? 1 : 0;
      const on = hover && hover.start === p.start;
      const kind = barKind(p);
      ctx.fillStyle = on ? BAR[`${kind}Hover`] : BAR[kind];
      this.roundRect(x0 + gap, bar.y, Math.max(1, w - 2 * gap), bar.h, 3);
      ctx.fill();
      if (on) {
        ctx.strokeStyle = 'oklch(0.98 0 0 / 0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (w > 64) {                                    // what a click does, on pieces wide enough to say it
        const label = p.keep ? '× cut' : '↺ keep';
        ctx.font = FONT_SMALL;
        const tw = this.textWidth(label, FONT_SMALL);
        if (on || w > tw + 40) {
          ctx.fillStyle = on ? 'oklch(0.16 0.02 245)' : 'oklch(0.16 0.02 245 / 0.55)';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, clamp(x0 + w / 2 - tw / 2, x0 + 4, x1 - tw - 4), bar.y + bar.h / 2 + 0.5);
        }
      }
    }
  }

  /** Your splits (S): a thin line through the lanes and a notch in the bar. */
  drawSplits({ bar, words }) {
    const { ctx } = this;
    for (const s of this.splits) {
      if (s < this.view.start || s > this.view.end) continue;
      const x = Math.round(this.x(s));
      ctx.fillStyle = 'oklch(0.95 0.01 245 / 0.32)';
      ctx.fillRect(x, bar.y + bar.h + 2, 1, words.y + words.h - bar.y - bar.h - 1);
      ctx.fillStyle = 'oklch(0.95 0.01 245 / 0.95)';
      ctx.beginPath();
      ctx.moveTo(x - 3.5, bar.y - 3);
      ctx.lineTo(x + 4.5, bar.y - 3);
      ctx.lineTo(x + 0.5, bar.y + 2);
      ctx.closePath();
      ctx.fill();
    }
  }

  drawWave({ wave }) {
    const { ctx, levels: lv } = this;
    const cy = wave.y + wave.h / 2;
    const half = wave.h / 2 - 3;
    ctx.fillStyle = this.c.line;
    ctx.fillRect(0, Math.round(cy), this.W, 1);
    if (!lv || !lv.length) return;
    const span = this.view.end - this.view.start;
    const pxPerWin = (this.W * SEG) / span;
    const keep = new Path2D();
    const cut = new Path2D();
    let si = Math.max(0, segmentIndexAt(this.segments, this.view.start));
    const kept = (t) => {
      const segs = this.segments;
      if (!segs.length) return true;
      while (si < segs.length - 1 && t >= segs[si].end) si++;
      while (si > 0 && t < segs[si].start) si--;
      return segs[si].keep;
    };
    const boosted = this.gains.length > 0;
    if (pxPerWin >= 3) {
      const i0 = Math.max(0, Math.floor((this.view.start - this.shift) / SEG));
      const i1 = Math.min(lv.length - 1, Math.ceil((this.view.end - this.shift) / SEG));
      for (let i = i0; i <= i1; i++) {
        const t0 = this.shift + i * SEG;
        const db = lv[i] + (boosted ? this.gainAt(t0 + SEG / 2) : 0);
        const h = Math.max(1, amp(db) * half);
        (kept(t0 + SEG / 2) ? keep : cut).rect(this.x(t0) + 0.5, cy - h, Math.max(1, pxPerWin - 1.2), 2 * h);
      }
    } else {
      const last = lv.length - 1;
      for (let px = 0; px < this.W; px++) {
        const ta = this.t(px);
        const tb = this.t(px + 1);
        let i0 = Math.floor((ta - this.shift) / SEG);
        let i1 = Math.floor((tb - this.shift) / SEG);
        if (i1 < 0 || i0 > last) continue;
        i0 = Math.max(0, i0);
        i1 = Math.min(last, Math.max(i0, i1));
        let m = -Infinity;
        for (let i = i0; i <= i1; i++) if (lv[i] > m) m = lv[i];
        if (boosted) m += this.gainAt((ta + tb) / 2);
        const h = Math.max(0.5, amp(m) * half);
        (kept((ta + tb) / 2) ? keep : cut).rect(px, cy - h, 1, 2 * h);
      }
    }
    ctx.fillStyle = this.c.keep;
    ctx.fill(keep);
    ctx.fillStyle = this.c.cutWave;
    ctx.fill(cut);
  }

  drawGains({ wave }) {
    const { ctx } = this;
    const y = wave.y + wave.h - 5;
    for (const g of this.gains) {
      if (g.end < this.view.start || g.start > this.view.end) continue;
      const x0 = Math.max(0, this.x(g.start));
      const x1 = Math.min(this.W, this.x(g.end));
      ctx.fillStyle = this.c.gain;
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), 4);
      const label = `+${Math.round(g.db * 10) / 10} dB`;
      ctx.font = MONO;
      const tw = this.textWidth(label, MONO) + 10;
      if (x1 - x0 >= tw + 4) {
        ctx.fillStyle = 'oklch(0.28 0.06 215 / 0.95)';
        this.roundRect(x0 + 2, y - 18, tw, 15, 5);
        ctx.fill();
        ctx.fillStyle = this.c.gain;
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x0 + 7, y - 10);
      }
    }
  }

  /** The cut preview will play (you put the playhead in it): a dashed outline. */
  drawPass({ wave, words }) {
    if (!this.pass) return;
    const x0 = this.x(this.pass.start);
    const x1 = this.x(this.pass.end);
    if (x1 < 0 || x0 > this.W) return;
    const { ctx } = this;
    const top = wave.y - 1;
    const bottom = words.y + words.h + 1;
    ctx.save();
    ctx.strokeStyle = 'oklch(0.95 0.01 245 / 0.7)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(Math.round(x0) + 0.75, top + 0.75, Math.max(1, Math.round(x1 - x0) - 1.5), bottom - top - 1.5);
    ctx.restore();
  }

  /**
   * Words under the waveform; the one being spoken lights up, cut ones are struck through. When one row has no room
   * for most of them, they alternate between two rows, so each word may use the space up to the word after next.
   */
  drawWords({ words }) {
    const { ctx } = this;
    ctx.textBaseline = 'middle';
    if (!this.words) {
      ctx.fillStyle = this.c.text3;
      ctx.font = FONT_SMALL;
      ctx.fillText(this.wordsHint || 'Words appear here once the transcript is ready', 12, words.y + words.h / 2);
      return;
    }
    const ws = this.words;
    const i0 = wordIndexAfter(ws, this.view.start);
    let i1 = i0;
    while (i1 < ws.length && ws[i1].s < this.view.end) i1++;
    let tight = 0;
    for (let i = i0; i < i1; i++) {
      const next = i + 1 < ws.length ? this.x(ws[i + 1].s) : this.W;
      if (this.textWidth(ws[i].w, FONT) > Math.max(this.x(ws[i].e), next) - this.x(ws[i].s) - 6) tight++;
    }
    const rowsN = i1 > i0 && tight / (i1 - i0) > 0.15 ? 2 : 1;
    const rowH = rowsN === 2 ? (words.h - 6) / 2 : words.h - 10;
    const now = this.wordAt(this.time);
    for (let i = i0; i < i1; i++) {
      const w = ws[i];
      const row = rowsN === 2 ? i % 2 : 0;
      const y = rowsN === 2 ? words.y + 2 + row * (rowH + 2) : words.y + 5;
      const mid = y + rowH / 2;
      const x0 = this.x(w.s);
      const x1 = Math.max(this.x(w.e), x0 + 2);
      const next = i + rowsN < ws.length ? this.x(ws[i + rowsN].s) : this.W;   // next word in the same row
      const seg = this.segmentAt((w.s + w.e) / 2);
      const isCut = seg ? !seg.keep : false;
      const isFiller = isCut && seg.reason === 'filler' && !seg.manual;
      const isNow = w === now && this.time < w.e;
      ctx.fillStyle = isNow ? 'oklch(0.86 0.09 205 / 0.32)'
        : isFiller ? 'oklch(0.72 0.15 300 / 0.16)' : isCut ? 'oklch(1 0 0 / 0.02)' : 'oklch(1 0 0 / 0.06)';
      this.roundRect(x0, y, x1 - x0, rowH, 5);
      ctx.fill();
      if (isNow) {
        ctx.strokeStyle = 'oklch(0.86 0.09 205 / 0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const font = rowsN === 2 ? (isNow ? FONT_2_NOW : FONT_2) : (isNow ? FONT_NOW : FONT);
      const room = Math.min(Math.max(x1, next) - x0, 400) - 6;
      if (room < 12) continue;
      let text = w.w;
      let width = this.textWidth(text, font);
      if (width > room) {
        const keep = Math.floor((text.length * room) / width) - 1;
        if (keep < 3) continue;                 // a "t…" fragment says nothing; zoom in to read it
        text = `${text.slice(0, keep)}…`;
        width = this.textWidth(text, font);
      }
      ctx.font = font;
      ctx.fillStyle = isNow ? 'oklch(0.98 0.01 205)' : isFiller ? this.c.filler : isCut ? this.c.text3 : this.c.text;
      ctx.fillText(text, x0 + 4, mid + 0.5);
      if (isCut) {
        ctx.fillStyle = isFiller ? this.c.filler : this.c.cut;
        ctx.fillRect(x0 + 3, Math.round(mid), width + 2, 1);
      }
    }
  }

  textWidth(text, font) {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      const prev = this.ctx.font;
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.ctx.font = prev;
      this.widths.set(key, w);
    }
    return w;
  }

  drawRuler() {
    const { ctx, W } = this;
    ctx.fillStyle = this.c.bg;
    ctx.fillRect(0, 0, W, RULER_H);
    const span = this.view.end - this.view.start;
    const step = STEPS.find((s) => (s / span) * W >= 90) || 3600;
    const minor = step / (step === 15 ? 3 : 5);
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    const first = Math.floor(this.view.start / minor);
    for (let k = first; k * minor <= this.view.end + minor; k++) {
      const t = k * minor;
      const x = Math.round(this.x(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.fillStyle = major ? this.c.text3 : this.c.line2;
      ctx.fillRect(x - 0.5, RULER_H - (major ? 9 : 5), 1, major ? 9 : 5);
      if (major && t >= 0) {
        ctx.fillStyle = this.c.text3;
        ctx.fillText(fmtTime(t, decimals), x + 4, 10);
      }
    }
    ctx.fillStyle = this.c.line;
    ctx.fillRect(0, RULER_H - 1, W, 1);
  }

  drawOverview({ overview: o }) {
    const { ctx, W } = this;
    const X = (t) => (t / this.duration) * W;
    ctx.fillStyle = this.c.lane;
    this.roundRect(0, o.y, W, o.h, 4);
    ctx.fill();
    ctx.save();
    this.roundRect(0, o.y, W, o.h, 4);
    ctx.clip();
    for (const s of this.segments) {
      const x0 = X(s.start);
      const w = Math.max(0.5, X(s.end) - x0);
      ctx.fillStyle = s.keep ? 'oklch(0.74 0.15 155 / 0.55)'
        : s.reason === 'filler' && !s.manual ? 'oklch(0.72 0.15 300 / 0.7)' : 'oklch(0.66 0.17 25 / 0.35)';
      ctx.fillRect(x0, o.y, w, o.h);
      if (s.manual) { ctx.fillStyle = this.c.edit; ctx.fillRect(x0, o.y, w, 2); }
    }
    for (const g of this.gains) { ctx.fillStyle = this.c.gain; ctx.fillRect(X(g.start), o.y + o.h - 2, Math.max(1, X(g.end) - X(g.start)), 2); }
    ctx.restore();
    const v0 = X(this.view.start);
    const v1 = Math.max(v0 + 3, X(this.view.end));
    ctx.fillStyle = 'oklch(1 0 0 / 0.1)';
    ctx.fillRect(v0, o.y - 2, v1 - v0, o.h + 4);
    ctx.strokeStyle = this.c.text2;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(v0) + 0.5, o.y - 1.5, Math.round(v1 - v0) - 1, o.h + 3);
    ctx.fillStyle = this.c.text;
    ctx.fillRect(Math.round(X(this.time)), o.y - 2, 1, o.h + 4);
  }

  drawPlayhead({ words }) {
    const { ctx } = this;
    const x = Math.round(this.x(this.time));
    if (x < -6 || x > this.W + 6) return;
    ctx.fillStyle = this.c.text;
    ctx.fillRect(x, RULER_H - 6, 1, words.y + words.h - RULER_H + 7);
    ctx.beginPath();
    ctx.moveTo(x - 5.5, RULER_H - 11);
    ctx.lineTo(x + 6.5, RULER_H - 11);
    ctx.lineTo(x + 0.5, RULER_H - 4);
    ctx.closePath();
    ctx.fill();
  }

  drawHover({ words }) {
    if (this.hoverX === null || this.drag) return;
    const { ctx } = this;
    const x = Math.round(this.hoverX);
    const piece = this.hoverPiece;
    if (!piece) {
      ctx.fillStyle = 'oklch(1 0 0 / 0.22)';
      ctx.fillRect(x, RULER_H, 1, words.y + words.h - RULER_H);
    }
    const label = piece
      ? `Click: ${piece.keep ? 'cut' : 'keep'} ${fmtTime(piece.start, 2)} to ${fmtTime(piece.end, 2)} (${(piece.end - piece.start).toFixed(2)} s)`
      : fmtTime(this.t(this.hoverX), 2);
    ctx.font = MONO;
    const tw = ctx.measureText(label).width + 10;
    const lx = clamp(x + 6, 2, this.W - tw - 2);
    ctx.fillStyle = 'oklch(0.26 0.024 245 / 0.95)';
    this.roundRect(lx, 4, tw, 15, 4);
    ctx.fill();
    ctx.fillStyle = piece ? this.c.text : this.c.text2;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + 5, 12);
  }

  roundRect(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, Math.abs(w) / 2, h / 2)));
  }

  // ---------- interaction: click a bar = cut / keep that piece, click elsewhere = move the playhead,
  // drag / wheel = slide the view, Ctrl + wheel = zoom
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  centerOverview(x) {
    const t = clamp((x / this.W) * this.duration, 0, this.duration);
    const span = this.view.end - this.view.start;
    this.holdFollow();
    this.setView(t - span / 2, t + span / 2);
  }

  onDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    const zone = this.zoneAt(y);
    this.canvas.setPointerCapture(e.pointerId);
    if (zone === 'overview') { this.drag = { type: 'overview' }; this.centerOverview(x); return; }
    this.drag = { type: 'press', x0: x, t0: clamp(this.t(x), 0, this.duration), start0: this.view.start, zone };
  }

  onMove(e) {
    const { x, y } = this.local(e);
    const d = this.drag;
    if (!d) {
      this.hoverX = x;
      this.hoverZone = this.zoneAt(y);
      this.canvas.style.cursor = this.hoverZone === 'overview' || this.hoverZone === 'bar' ? 'pointer' : '';
      this.request();
      return;
    }
    if (d.type === 'overview') { this.centerOverview(x); return; }
    if (d.type === 'press' && Math.abs(x - d.x0) > DRAG_PX) {
      d.type = 'slide';
      this.canvas.style.cursor = 'grabbing';
    }
    if (d.type === 'slide') {
      const span = this.view.end - this.view.start;
      const s = d.start0 - ((x - d.x0) / this.W) * span;
      this.holdFollow();
      this.setView(s, s + span);
    }
  }

  onUp() {
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = this.hoverZone === 'bar' ? 'pointer' : '';
    if (!d || d.type !== 'press') return;
    if (d.zone === 'bar') {
      const p = pieceAt(this.pieces, d.t0);
      if (p) this.h.onTogglePiece?.(p);
      return;
    }
    let t = d.t0;
    if (d.zone === 'words') { const w = this.wordAt(t); if (w) t = w.s; }
    this.h.onSeek?.(t);
  }

  onDouble(e) {
    const { x, y } = this.local(e);
    const zone = this.zoneAt(y);
    if (zone === 'overview' || zone === 'bar') return;            // the bar toggles on a single click
    this.h.onToggleAt?.(clamp(this.t(x), 0, this.duration));
  }

  onWheel(e) {
    e.preventDefault();
    const { x } = this.local(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoom(Math.exp(e.deltaY * 0.0015), this.t(x));
      return;
    }
    const span = this.view.end - this.view.start;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const dt = (delta / 100) * span * 0.12;
    this.holdFollow();
    this.setView(this.view.start + dt, this.view.end + dt);
  }
}
