// Playback. Each source plays from a "deck" of stacked <video> elements: the one on screen plays, the others wait,
// paused, already on the first frames after the next cuts. Preview jumps over a cut by switching elements, which is
// instant; a seek there would decode from the keyframe before the target (screen recorders put one every few seconds,
// so the picture froze for up to a second at every cut, and more often the faster it played). The original has three
// elements: two waiting give each one the time of two kept pieces to get ready, so the short pieces between filler
// words work too. The fast copies keep a keyframe every second, so two elements are enough there.
// Sources: the original (or, for a file the window cannot play, its review copy) and the fast copies (same size,
// 15 frames a second for 4x and 10 for 6x: one new frame per refresh of a 60 Hz screen), on screen only while playing
// fast: the window shows about 100 frames a second, so the original cannot keep up there. Stop or slow down and the
// original is back on that frame.
// Also: "preview the result" (cuts are jumped over while playing, except a cut you put the playhead in yourself)
// and louder moments (the sound runs through a Web Audio gain that follows the louder ranges).
import { clamp, segmentIndexAt } from './util.js';

const FAST_LIMIT = 75;          // frames a second the window keeps up with comfortably (fps x speed above: fast copy)
const SCREEN_HZ = 60;           // a fast copy fits a speed when its frames a second x the speed make this
const ORIG_ELEMENTS = 3;        // per deck: one on screen, the rest waiting after the next cuts
const FAST_ELEMENTS = 2;
const HOLD_MAX_MS = 2000;       // a waiting element that is not ready by then: the one on screen seeks instead
const PARK_PAUSED_MS = 300;     // paused: the waiting elements get ready this long after the playhead last moved
const EPS = 1e-3;

export class Player {
  constructor(main, fastHost, { onTime, onState, onError, onPass, onPassChange } = {}) {
    this.main = main;
    this.fastHost = fastHost;   // the page's element for the fast copies; the others are made when copies arrive
    this.all = [];
    this.on = { onTime, onState, onError, onPass, onPassChange };
    this.orig = this.makeDeck('orig', 0, main, ORIG_ELEMENTS);
    this.decks = [this.orig];   // the original first, then one deck per fast copy
    this.v = main;              // the element in charge (time, play state); the others wait, paused
    this.cues = new Map();      // waiting element -> { t, ready }: parked at t, the first moment after a cut
    this.holding = null;        // { cut, timer }: at a cut, waiting for the element parked after it
    this.parkTimer = 0;
    this.segments = [];
    this.gains = [];
    this.skipCuts = true;
    this.pass = null;           // { start, end }: cut the user put the playhead in; preview plays it, then goes on
    this.inPass = false;
    this.fps = 30;
    this.rateValue = 1;
    this.raf = 0;
    this.audio = null;          // { ctx, gain } once the first play sets it up
    this.lastGainDb = 0;
    this.showToken = 0;
    main.addEventListener('loadedmetadata', () => this.on.onTime?.(main.currentTime));
    main.addEventListener('error', () => this.on.onError?.(main.error));
  }

  // ---------- decks and their elements
  /** A new hidden element right after `after` (ids: video2, video3 for the original, videoFast2... for the copies). */
  newElement(after, kind) {
    const el = document.createElement('video');
    el.preload = 'auto';
    el.className = 'is-off';
    el.id = `${kind}${this.all.filter((x) => x.id.replace(/\d+$/, '') === kind).length + 1}`;
    after.after(el);
    return el;
  }

  /** A deck of n elements: `first` (an element of the page) and n - 1 made after it. */
  makeDeck(name, fps, first, n) {
    const deck = { name, fps, els: [], url: '', last: first, ready: false };
    const kind = name === 'orig' ? 'video' : 'videoFast';
    let el = first;
    for (let k = 0; k < n; k++) {
      if (k) el = this.newElement(deck.els[k - 1], kind);
      this.attach(el, deck);
      deck.els.push(el);
    }
    // a fast copy is ready to take over once its first element has a picture
    first.addEventListener('loadeddata', () => { if (deck !== this.orig && deck.url) { deck.ready = true; this.route(); } });
    first.addEventListener('error', () => { if (deck === this.orig || !first.getAttribute('src')) return; deck.ready = false; this.route(); });
    return deck;
  }

  attach(el, deck) {
    this.all.push(el);
    el.dataset.deck = deck.name;
    el.preservesPitch = true;
    el.addEventListener('play', () => { if (el === this.v) { this.on.onState?.(true); this.loop(); } });
    el.addEventListener('pause', () => { if (el === this.v && !this.holding) this.on.onState?.(false); });
    el.addEventListener('ended', () => {
      if (el !== this.v) return;
      if (deck !== this.orig) this.switchTo(this.orig.last, false);
      else this.on.onState?.(false);
    });
    el.addEventListener('seeked', () => {
      if (el === this.v) { this.applyGain(); this.on.onTime?.(el.currentTime); }
      this.markParked(el);
    });
    el.addEventListener('canplay', () => this.markParked(el));
    if (this.audio) this.audio.ctx.createMediaElementSource(el).connect(this.audio.gain);
  }

  /** Puts a URL (or nothing) into every element of a deck. */
  setDeck(deck, url) {
    deck.url = url || '';
    deck.ready = false;
    for (const el of deck.els) {
      this.cues.delete(el);
      el.pause();
      if (url) el.src = url; else el.removeAttribute('src');
      el.load();
    }
  }

  deckOf(el) { return this.decks.find((d) => d.els.includes(el)) || this.orig; }
  get fastDecks() { return this.decks.slice(1); }

  load(url, fps) {
    this.toMain();
    this.fps = fps || 30;
    this.setFast(null);
    this.setPass(null);
    this.setDeck(this.orig, url);
  }

  /** Replaces the original with its review copy (a file the window cannot play), keeping position, speed and play state. */
  swap(url, fps) {
    const keep = { t: this.time, playing: this.playing };
    this.toMain();
    if (fps) this.fps = fps;
    this.setDeck(this.orig, url);
    this.main.addEventListener('loadedmetadata', () => {
      this.main.currentTime = keep.t;
      this.main.playbackRate = this.rateValue;
      if (keep.playing) this.play();
    }, { once: true });
  }

  /** The fast copies for 4x / 6x: [{ fps, url }] (null removes them). */
  setFast(copies) {
    if (this.showingFast) this.switchTo(this.orig.last, this.playing);
    const list = [...(copies || [])].sort((a, b) => b.fps - a.fps);
    list.forEach((c, k) => {
      let deck = this.decks[k + 1];
      if (!deck) {
        const prev = this.decks[k].els;
        const first = k === 0 ? this.fastHost : this.newElement(prev[prev.length - 1], 'videoFast');
        deck = this.makeDeck(`fast${k + 1}`, c.fps, first, FAST_ELEMENTS);
        this.decks.push(deck);
      }
      deck.fps = c.fps;
      this.setDeck(deck, c.url);
    });
    for (const d of this.decks.slice(list.length + 1)) if (d.url) this.setDeck(d, null);
  }

  get time() { return this.v.currentTime || 0; }
  get duration() { return Number.isFinite(this.main.duration) ? this.main.duration : 0; }
  get playing() { return Boolean(this.holding) || (!this.v.paused && !this.v.ended); }
  get rate() { return this.rateValue; }
  get showingFast() { return this.deckOf(this.v) !== this.orig; }
  get fastReady() { return this.fastDecks.some((d) => d.ready); }

  /** True when this speed is more than the window decodes from the original (a fast copy is wanted). */
  needsFast(rate = this.rateValue) { return this.fps * rate > FAST_LIMIT; }

  /** The deck for a speed: the original, or the ready fast copy whose frames a second x speed come closest to 60. */
  deckFor(rate = this.rateValue) {
    if (!this.needsFast(rate)) return this.orig;
    let best = null;
    for (const d of this.fastDecks) {
      if (d.ready && (!best || Math.abs(d.fps * rate - SCREEN_HZ) < Math.abs(best.fps * rate - SCREEN_HZ))) best = d;
    }
    return best || this.orig;
  }

  setRate(r) {
    this.rateValue = r;
    for (const el of this.all) if (el.getAttribute('src')) el.playbackRate = r;
    this.route();
  }

  setSegments(segments) { this.segments = segments || []; }
  setGains(gains) { this.gains = gains || []; this.applyGain(); }

  route() {
    if (!this.playing) return;
    const want = this.deckFor();
    if (want !== this.deckOf(this.v)) this.switchTo(want.last, true);
  }

  /** Hands over to `next` at the same moment. The element on screen stays visible until `next` has that frame. */
  switchTo(next, play) {
    this.unhold();
    const prev = this.v;
    if (next === prev) return;
    const t = prev.currentTime;
    this.v = next;
    this.deckOf(next).last = next;
    this.cues.clear();
    prev.pause();                             // its 'pause' event is ignored: prev is no longer in charge
    next.playbackRate = this.rateValue;
    next.currentTime = t;
    const token = ++this.showToken;
    const show = () => {
      if (token !== this.showToken) return;
      for (const el of this.all) el.classList.toggle('is-off', el !== next);
    };
    next.addEventListener('seeked', show, { once: true });
    setTimeout(show, 1500);                   // in case the seek event never comes
    if (play) next.play()?.catch(() => {});
  }

  toMain() {
    this.unhold();
    for (const el of this.all) if (el !== this.main) el.pause();
    this.v = this.main;
    this.orig.last = this.main;
    this.cues.clear();
    ++this.showToken;
    for (const el of this.all) el.classList.toggle('is-off', el !== this.main);
  }

  // ---------- jumping over cuts
  /** The next runs of cut pieces at or after t that preview jumps over, at most n: [{from, to}] (to = null: the end). */
  nextCuts(t, n) {
    const segs = this.segments;
    const out = [];
    let i = segmentIndexAt(segs, t);
    if (i < 0) return out;
    const pass = this.pass;
    const skipped = (s) => !s.keep && !(pass && s.start >= pass.start - EPS && s.end <= pass.end + EPS);
    while (out.length < n && i < segs.length) {
      while (i < segs.length && !skipped(segs[i])) i++;
      if (i >= segs.length) break;
      let j = i;
      while (j < segs.length && skipped(segs[j])) j++;
      out.push({ from: segs[i].start, to: j < segs.length ? segs[j].start : null });
      i = j;
    }
    return out;
  }

  /** The waiting element parked (or parking) at t, if any. */
  parkedAt(t) {
    for (const [el, c] of this.cues) if (Math.abs(c.t - t) < EPS) return el;
    return null;
  }

  /** Paused: get the waiting elements ready for the cuts after the playhead, once it stops moving (play is then instant). */
  parkSoon() {
    clearTimeout(this.parkTimer);
    this.parkTimer = setTimeout(() => {
      if (!this.playing && this.skipCuts && !this.v.seeking) this.plan(this.nextCuts(this.v.currentTime, ORIG_ELEMENTS));
    }, PARK_PAUSED_MS);
  }

  /** Keeps the waiting elements of the deck on screen parked after the next cuts (each one stays until it is used). */
  plan(cuts) {
    const deck = this.deckOf(this.v);
    if (!deck.url) return;
    const wanted = cuts.filter((c) => c.to !== null).map((c) => c.to).slice(0, deck.els.length - 1);
    for (const [el, c] of this.cues) {
      if (el === this.v || !deck.els.includes(el) || !wanted.some((w) => Math.abs(w - c.t) < EPS)) this.cues.delete(el);
    }
    for (const w of wanted) {
      if (this.parkedAt(w)) continue;
      const free = deck.els.find((el) => el !== this.v && !this.cues.has(el) && el.readyState >= 1 && !el.error);
      if (!free) return;
      this.cues.set(free, { t: w, ready: false });
      if (!free.paused) free.pause();
      free.playbackRate = this.rateValue;
      free.currentTime = w + EPS;
    }
  }

  markParked(el) {
    const c = this.cues.get(el);
    if (!c || el.seeking || el.readyState < 2) return;
    c.ready = true;
    if (this.holding && Math.abs(this.holding.cut.to - c.t) < EPS) { this.unhold(); this.handOver(el); }
  }

  /** At a cut: the element parked after it takes over (instant); still getting ready: wait for it on this frame. */
  jumpOver(cut) {
    if (cut.to === null) {                    // nothing kept after it: stop at the end
      this.pause();
      this.v.currentTime = this.segments[this.segments.length - 1].end;
      return;
    }
    const el = this.parkedAt(cut.to);
    if (el && this.cues.get(el).ready && !el.seeking) { this.handOver(el); return; }
    if (el) { this.hold(cut); return; }
    this.v.currentTime = cut.to + EPS;        // nothing parked there (just after a seek): the one on screen seeks
  }

  handOver(next) {
    const prev = this.v;
    this.cues.delete(next);
    this.v = next;
    this.deckOf(next).last = next;
    next.playbackRate = this.rateValue;
    next.play()?.catch(() => {});
    ++this.showToken;
    next.classList.remove('is-off');
    prev.classList.add('is-off');
    prev.pause();                             // ignored: prev is no longer in charge; it waits for a later cut
    this.applyGain();
  }

  hold(cut) {
    if (this.holding) return;
    this.holding = {
      cut,
      timer: setTimeout(() => {               // still not ready: the element on screen seeks, as without waiting
        if (!this.holding) return;
        this.unhold();
        this.v.currentTime = cut.to + EPS;
        this.v.play()?.catch(() => {});
      }, HOLD_MAX_MS),
    };
    this.v.pause();                           // its 'pause' event is ignored while holding: still "playing"
  }

  unhold() {
    if (!this.holding) return false;
    clearTimeout(this.holding.timer);
    this.holding = null;
    return true;
  }

  // ---------- sound
  ensureAudio() {
    if (this.audio) { this.audio.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      for (const el of this.all) ctx.createMediaElementSource(el).connect(gain);
      this.audio = { ctx, gain };
      ctx.resume();
    } catch {
      this.audio = null;                      // no gain preview, plain playback
    }
  }

  gainDbAt(t) {
    for (const g of this.gains) if (t >= g.start && t < g.end) return g.db;
    return 0;
  }

  applyGain() {
    if (!this.audio) return;
    const db = this.gainDbAt(this.v.currentTime);
    if (db === this.lastGainDb) return;
    this.lastGainDb = db;
    this.audio.gain.gain.setTargetAtTime(10 ** (db / 20), this.audio.ctx.currentTime, 0.015);
  }

  // ---------- transport
  play() {
    this.ensureAudio();
    if (this.holding) return;
    if (this.skipCuts) this.skipIfInCut();
    const want = this.deckFor();
    if (want !== this.deckOf(this.v)) this.switchTo(want.last, true);
    else this.v.play()?.catch(() => {});
  }

  pause() {
    const held = this.unhold();
    this.v.pause();
    if (held) this.on.onState?.(false);       // it was paused already, so no 'pause' event comes
    if (this.showingFast) {
      this.switchTo(this.orig.last, false);   // stopped: the original, on the same frame
      this.on.onState?.(false);               // the copy's own 'pause' event arrives after the hand-over: ignored
    }
    if (this.inPass) { this.inPass = false; this.on.onPass?.(false); }
    this.parkSoon();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  /**
   * Moves the playhead. A seek into a cut (a click, the cut keys, a review row) makes preview play that cut instead
   * of jumping over it: `pass` is that cut ({start, end}); left out, it is the cut at t, if any.
   */
  seek(t, pass) {
    const d = this.duration;
    const to = clamp(t, 0, d || Math.max(0, t));
    const held = this.unhold();
    this.v.currentTime = to;
    if (held) this.v.play()?.catch(() => {});
    this.setPass(pass === undefined ? this.cutRunAt(to) : pass);
    this.on.onTime?.(to);
    if (!this.playing) this.parkSoon();
  }

  step(frames) {
    this.pause();
    this.seek(this.time + frames / this.fps);
  }

  /** The run of touching cut pieces around t, or null when t is in a kept piece. */
  cutRunAt(t) {
    const segs = this.segments;
    const i = segmentIndexAt(segs, t);
    if (i < 0 || segs[i].keep) return null;
    let a = i;
    let b = i;
    while (a > 0 && !segs[a - 1].keep) a--;
    while (b < segs.length - 1 && !segs[b + 1].keep) b++;
    return { start: segs[a].start, end: segs[b].end };
  }

  setPass(range) {
    const same = range === this.pass || (range && this.pass && range.start === this.pass.start && range.end === this.pass.end);
    this.pass = range;
    if (!same) this.on.onPassChange?.(range);
  }

  /** Inside a cut piece (not the one you chose to hear): jump to the next kept piece (or stop at the end). */
  skipIfInCut() {
    const t = this.v.currentTime;
    const [cut] = this.nextCuts(t, 1);
    if (!cut || t < cut.from - EPS) return false;
    if (cut.to === null) {
      this.pause();
      this.v.currentTime = this.segments[this.segments.length - 1].end;
    } else {
      this.v.currentTime = cut.to + EPS;
    }
    return true;
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const v = this.v;
      if (v.paused || v.ended) return;
      const t = v.currentTime;
      if (this.pass && t >= this.pass.end) this.setPass(null);
      const inPass = Boolean(this.skipCuts && this.pass && t >= this.pass.start - EPS);
      if (inPass !== this.inPass) { this.inPass = inPass; this.on.onPass?.(inPass); }
      if (this.skipCuts && !v.seeking) {
        const cuts = this.nextCuts(t, ORIG_ELEMENTS);
        if (cuts.length && t >= cuts[0].from - EPS) this.jumpOver(cuts[0]);
        else this.plan(cuts);
      }
      this.applyGain();
      this.on.onTime?.(this.v.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
