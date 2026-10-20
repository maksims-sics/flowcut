// Playback. Two stacked <video> elements: the original (or, for a file the window cannot play, its review copy) and
// the fast copy (same size, 10 frames a second) that is on screen only while playing at 4x / 6x: the window decodes
// about 100 frames a second, so the original freezes there. Stop or slow down and the original is back on that frame.
// Also: "preview the result" (cuts are jumped over while playing, except a cut you put the playhead in yourself)
// and louder moments (the sound runs through a Web Audio gain that follows the louder ranges).
import { clamp, segmentIndexAt } from './util.js';

const FAST_LIMIT = 75;          // frames a second the window keeps up with comfortably (fps x speed above: fast copy)

export class Player {
  constructor(main, fast, { onTime, onState, onError, onPass, onPassChange } = {}) {
    this.main = main;
    this.fast = fast;
    this.v = main;              // the element in charge (time, play state); the other one waits, paused
    this.fastReady = false;
    this.on = { onTime, onState, onError, onPass, onPassChange };
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
    for (const el of [main, fast]) {
      el.preservesPitch = true;
      el.addEventListener('play', () => { if (el === this.v) { this.on.onState?.(true); this.loop(); } });
      el.addEventListener('pause', () => { if (el === this.v) this.on.onState?.(false); });
      el.addEventListener('ended', () => { if (el === this.v) this.on.onState?.(false); });
      el.addEventListener('seeked', () => { if (el === this.v) { this.applyGain(); this.on.onTime?.(el.currentTime); } });
    }
    main.addEventListener('loadedmetadata', () => this.on.onTime?.(main.currentTime));
    main.addEventListener('error', () => this.on.onError?.(main.error));
    fast.addEventListener('loadeddata', () => { this.fastReady = true; this.route(); });
    fast.addEventListener('ended', () => { if (this.v === fast) this.switchTo(this.main, false); });
    fast.addEventListener('error', () => { if (!fast.getAttribute('src')) return; this.fastReady = false; this.route(); });
  }

  load(url, fps) {
    this.toMain();
    this.fps = fps || 30;
    this.setFast(null);
    this.setPass(null);
    this.main.src = url;
    this.main.load();
  }

  /** Replaces the original with its review copy (a file the window cannot play), keeping position, speed and play state. */
  swap(url, fps) {
    const keep = { t: this.time, playing: this.playing };
    this.toMain();
    if (fps) this.fps = fps;
    this.main.src = url;
    this.main.load();
    this.main.addEventListener('loadedmetadata', () => {
      this.main.currentTime = keep.t;
      this.main.playbackRate = this.rateValue;
      if (keep.playing) this.play();
    }, { once: true });
  }

  /** The fast copy for 4x / 6x (null removes it). */
  setFast(url) {
    this.fastReady = false;
    if (this.v === this.fast) this.switchTo(this.main, this.playing);
    if (!url) { this.fast.removeAttribute('src'); this.fast.load(); return; }
    this.fast.src = url;
    this.fast.load();
  }

  get time() { return this.v.currentTime || 0; }
  get duration() { return Number.isFinite(this.main.duration) ? this.main.duration : 0; }
  get playing() { return !this.v.paused && !this.v.ended; }
  get rate() { return this.rateValue; }
  get showingFast() { return this.v === this.fast; }

  /** True when this speed is more than the window decodes from the original (the fast copy is wanted). */
  needsFast(rate = this.rateValue) { return this.fps * rate > FAST_LIMIT; }

  setRate(r) {
    this.rateValue = r;
    this.main.playbackRate = r;
    if (this.fast.getAttribute('src')) this.fast.playbackRate = r;
    this.route();
  }

  setSegments(segments) { this.segments = segments || []; }
  setGains(gains) { this.gains = gains || []; this.applyGain(); }

  // ---------- which element plays
  route() {
    if (!this.playing) return;
    const want = this.fastReady && this.needsFast() ? this.fast : this.main;
    if (want !== this.v) this.switchTo(want, true);
  }

  /** Hands over to `next` at the same moment. The element on screen stays visible until `next` has that frame. */
  switchTo(next, play) {
    const prev = this.v;
    if (next === prev) return;
    const t = prev.currentTime;
    this.v = next;
    prev.pause();                             // its 'pause' event is ignored: prev is no longer in charge
    next.playbackRate = this.rateValue;
    next.currentTime = t;
    const token = ++this.showToken;
    const show = () => {
      if (token !== this.showToken) return;
      next.classList.remove('is-off');
      prev.classList.add('is-off');
    };
    next.addEventListener('seeked', show, { once: true });
    setTimeout(show, 1500);                   // in case the seek event never comes
    if (play) next.play()?.catch(() => {});
  }

  toMain() {
    if (this.v !== this.main) { this.fast.pause(); this.v = this.main; }
    ++this.showToken;
    this.main.classList.remove('is-off');
    this.fast.classList.add('is-off');
  }

  // ---------- sound
  ensureAudio() {
    if (this.audio) { this.audio.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      for (const el of [this.main, this.fast]) ctx.createMediaElementSource(el).connect(gain);
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
    if (this.skipCuts) this.skipIfInCut();
    const want = this.fastReady && this.needsFast() ? this.fast : this.main;
    if (want !== this.v) this.switchTo(want, true);
    else this.v.play()?.catch(() => {});
  }

  pause() {
    this.v.pause();
    if (this.v !== this.main) {
      this.switchTo(this.main, false);        // stopped: the original, on the same frame
      this.on.onState?.(false);               // the copy's own 'pause' event arrives after the hand-over: ignored
    }
    if (this.inPass) { this.inPass = false; this.on.onPass?.(false); }
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  /**
   * Moves the playhead. A seek into a cut (a click, the cut keys, a review row) makes preview play that cut instead
   * of jumping over it: `pass` is that cut ({start, end}); left out, it is the cut at t, if any.
   */
  seek(t, pass) {
    const d = this.duration;
    const to = clamp(t, 0, d || Math.max(0, t));
    this.v.currentTime = to;
    this.setPass(pass === undefined ? this.cutRunAt(to) : pass);
    this.on.onTime?.(to);
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

  /** Inside a cut piece: jump to the next kept piece (or stop at the end). Returns true when it jumped. */
  skipIfInCut() {
    const segs = this.segments;
    const v = this.v;
    const t = v.currentTime;
    const i = segmentIndexAt(segs, t);
    if (i < 0 || segs[i].keep) return false;
    if (this.pass && t >= this.pass.start - 1e-3 && t < this.pass.end) return false;   // the cut you chose to hear
    let j = i;
    while (j < segs.length && !segs[j].keep) j++;
    if (j >= segs.length) {
      this.pause();
      this.v.currentTime = segs[segs.length - 1].end;
    } else {
      v.currentTime = segs[j].start + 0.001;
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
      const inPass = Boolean(this.skipCuts && this.pass && t >= this.pass.start - 1e-3);
      if (inPass !== this.inPass) { this.inPass = inPass; this.on.onPass?.(inPass); }
      if (this.skipCuts && !v.seeking) this.skipIfInCut();
      this.applyGain();
      this.on.onTime?.(this.v.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
