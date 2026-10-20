'use strict';
// The cut rules. Pure functions, no I/O.
//
// Silence cuts: 40 ms loudness windows, an automatic level, short pauses bridged, padding around speech, very
// short pieces dropped. Keep the arithmetic exactly as it is (exact `===` joins, the merge that re-reads the piece
// it just pushed): cut positions are pinned value for value, and a tidier rewrite would move them by a frame here
// and there. Manual edits are applied afterwards as time ranges, so they survive setting changes.

const SEGMENT = 0.04;                              // analysis window, seconds
const CHUNK_SECONDS = 45 * 60;                     // audio is analysed in 45 min chunks
const CHUNK_WINDOWS = Math.round(CHUNK_SECONDS / SEGMENT);

const DEFAULT_SETTINGS = Object.freeze({
  autoLevel: true,           // find the silence level automatically
  levelDb: -45,              // the level when autoLevel is off
  keepPausesUpTo: 0.5,       // silences this short or shorter stay in
  padBefore: 0.01,           // seconds kept before speech
  padAfter: 0.15,            // seconds kept after speech
  minPiece: 0.75,            // kept pieces shorter than this, after padding, are dropped
  keepAnalysisShift: true,   // keep the analysis audio's start shift (cuts a few ms early); off = exact padding
});

/** Automatic level: mean of the DISTINCT whole-dB window levels above -72.5 (count starts at 1), floored, minus 2. */
function autoLevel(db, nFull) {
  const levels = new Set();
  for (let w = 0; w < nFull; w++) {
    const v = parseInt(db[w], 10);
    if (!Number.isNaN(v)) levels.add(v);
  }
  let acc = 0;
  let count = 1;
  for (const v of levels) {
    if (v > -72.5) { acc += v; count += 1; }
  }
  return Math.floor(acc / count) - 2;
}

/** Windows at or above the level are speech; touching windows join (exact === on start + duration). */
function speechRuns(db, level, duration) {
  const runs = [];
  for (let w = 0; w < db.length; w++) {
    if (!(db[w] >= level)) continue;
    const k = Math.floor(w / CHUNK_WINDOWS);
    const t0 = ((w - k * CHUNK_WINDOWS) * SEGMENT) + (CHUNK_SECONDS * k);
    const last = runs[runs.length - 1];
    if (last && last.start + last.duration === t0) last.duration += SEGMENT;
    else runs.push({ start: t0, duration: SEGMENT });
  }
  if (!runs.length) runs.push({ start: 0, duration });
  return runs;
}

/** Silences of `maxPause` or shorter are bridged (kept), then touching pieces join. */
function bridgeShortPauses(runs, maxPause) {
  if (!runs.length) return runs;
  const all = [];
  if (runs[0].start !== 0) all.push({ start: 0, duration: runs[0].start, keep: false });
  runs.forEach((r, i) => {
    all.push({ start: r.start, duration: r.duration, keep: true });
    if (i + 1 < runs.length) {
      const end = r.start + r.duration;
      all.push({ start: end, duration: runs[i + 1].start - end, keep: false });
    }
  });
  const kept = [];
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!p.keep) {
      if (p.duration <= maxPause && i + 1 < all.length) {
        kept.push({ start: p.start, duration: p.duration + all[i + 1].duration });
        i++;
      }
    } else {
      kept.push({ start: p.start, duration: p.duration });
    }
  }
  const joined = [];
  for (let i = 0; i < kept.length; i++) {
    joined.push({ start: kept[i].start, duration: kept[i].duration });
    while (i + 1 < kept.length && kept[i].start + kept[i].duration === kept[i + 1].start) {
      joined[joined.length - 1].duration += kept[i + 1].duration;
      i++;
    }
  }
  return joined;
}

/** Padding before and after each piece; a start clamps at 0 but the duration still grows by both paddings. */
function addPadding(pieces, before, after) {
  return pieces.map((p) => ({
    start: p.start - before <= 0 ? 0 : p.start - before,
    duration: p.duration + (before + after),
  }));
}

/**
 * Overlapping pieces merge, then pieces shorter than `minPiece` are dropped.
 * The first loop pass re-reads the piece it just pushed (same object); keep it that way:
 * (s + d) - s is not always d in floating point, and the pinned cut positions depend on it.
 */
function mergeAndDropShort(pieces, minPiece) {
  const out = [];
  let mergedAny = false;
  for (let i = 0; i < pieces.length; i++) {
    out.push(pieces[i]);
    const last = out[out.length - 1];
    if (!(last.duration > 0)) throw new Error('zero-length piece');
    while (i < pieces.length && last.start + last.duration > pieces[i].start) {
      last.duration = pieces[i].start + pieces[i].duration - last.start;
      i++;
      mergedAny = true;
    }
    if (mergedAny) i--;
  }
  return out.filter((p) => p.duration >= minPiece);
}

const piece = (start, duration, operation) => ({ start, duration, operation });

/** The full timeline: keep and remove pieces back to back from 0. */
function buildTimeline(keeps, duration) {
  if (!keeps.length) return keeps;
  const out = [];
  if (keeps[0].start !== 0) out.push(piece(0, keeps[0].start, 'remove'));
  keeps.forEach((k, i) => {
    out.push(piece(k.start, k.duration, 'keep'));
    if (i + 1 < keeps.length) {
      const end = k.start + k.duration;
      out.push(piece(end, keeps[i + 1].start - end, 'remove'));
    }
  });
  let total = 0;
  for (const p of out) total += p.duration;
  if (total < duration) out.push(piece(total, duration - total, 'remove'));
  return out;
}

/** Level actually used: the auto value, or the fixed one rounded to 3 decimals. */
function levelFor(analysis, settings) {
  if (settings.autoLevel) return autoLevelOf(analysis);
  return parseFloat(Number(settings.levelDb).toFixed(3));
}

function autoLevelOf(analysis) {
  if (analysis.autoLevel === undefined) analysis.autoLevel = autoLevel(analysis.db, analysis.nFull);
  return analysis.autoLevel;
}

/** The automatic timeline (silences cut), value for value. */
function silenceTimeline(analysis, settings, duration) {
  const level = levelFor(analysis, settings);
  const runs = speechRuns(analysis.db, level, duration);
  const bridged = bridgeShortPauses(runs, settings.keepPausesUpTo);
  const padded = addPadding(bridged, settings.padBefore, settings.padAfter);
  const keeps = mergeAndDropShort(padded, settings.minPiece);
  return { level, timeline: buildTimeline(keeps, duration) };
}

/**
 * Timeline -> contiguous segments covering [0, duration]; optional time shift (corrected timing).
 * Segment: { start, end, keep, manual, reason: null | 'silence' | 'filler', text? }
 */
function toSegments(timeline, duration, shift = 0) {
  const segs = [];
  for (const p of timeline) {
    const keep = p.operation !== 'remove';
    let a = Math.min(duration, Math.max(0, p.start + shift));
    const b = Math.min(duration, Math.max(0, p.start + p.duration + shift));
    if (segs.length) a = segs[segs.length - 1].end;     // contiguous by construction
    if (b > a) segs.push({ start: a, end: b, keep });
  }
  if (!segs.length) return [{ start: 0, end: duration, keep: true, manual: false, reason: null }];
  segs[0].start = 0;
  const last = segs[segs.length - 1];
  if (last.end < duration) segs.push({ start: last.end, end: duration, keep: false });
  return mergeSegments(segs.map((s) => ({ ...s, manual: false, reason: s.keep ? null : 'silence' })));
}

function sameKind(a, b) {
  return a.keep === b.keep && a.manual === b.manual && a.reason === b.reason && a.text === b.text;
}

function mergeSegments(segs) {
  const out = [];
  for (const s of segs) {
    if (!(s.end > s.start)) continue;
    const prev = out[out.length - 1];
    if (prev && sameKind(prev, s) && Math.abs(prev.end - s.start) < 1e-9) prev.end = s.end;
    else out.push({ ...s });
  }
  return out;
}

/** Overlays ranges on the segments: everything inside [start, end) takes `make(range)`'s fields. */
function overlay(segments, ranges, duration, make) {
  let segs = segments;
  for (const r of ranges || []) {
    const a = Math.max(0, Math.min(duration, r.start));
    const b = Math.max(0, Math.min(duration, r.end));
    if (b - a < 1e-6) continue;
    const fields = make(r);
    const next = [];
    for (const s of segs) {
      if (s.end <= a || s.start >= b) { next.push(s); continue; }
      if (s.start < a) next.push({ ...s, end: a });
      next.push({ start: Math.max(s.start, a), end: Math.min(s.end, b), ...fields });
      if (s.end > b) next.push({ ...s, start: b });
    }
    segs = next;
  }
  return mergeSegments(segs);
}

/** Filler words found in the transcript become auto cuts (reason 'filler'); edits applied later can restore them. */
function applyFillers(segments, fillers, duration) {
  return overlay(segments, fillers, duration, (f) => ({ keep: false, manual: false, reason: 'filler', text: f.text }));
}

/** Manual edits ({start, end, op: 'keep'|'cut'}) applied in order over the auto segments; later edits win. */
function applyEdits(segments, edits, duration) {
  return overlay(segments, edits, duration, (e) => ({ keep: e.op === 'keep', manual: true, reason: null, text: undefined }));
}

/** Video frames a kept segment yields: start <= t < end (what a per-piece `-ss start -t duration` cut keeps). */
function frameRanges(segments, fps, nbFrames = null) {
  const ranges = [];
  for (const s of segments) {
    if (!s.keep || s.end - s.start < 0.001) continue;
    const f0 = Math.max(0, Math.ceil(s.start * fps - 1e-6));
    let f1 = Math.ceil(s.end * fps - 1e-6);
    if (nbFrames) f1 = Math.min(f1, nbFrames);
    if (f1 <= f0) continue;
    const prev = ranges[ranges.length - 1];
    if (prev && f0 <= prev[1]) prev[1] = Math.max(prev[1], f1);
    else ranges.push([f0, f1]);
  }
  return ranges;
}

/** Everything the editor needs after an edit: silences -> filler words -> your edits, in that order. */
function computeCuts(analysis, info, settings, edits, fillers = []) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const duration = info.duration;
  const { level, timeline } = silenceTimeline(analysis, s, duration);
  const shift = s.keepAnalysisShift ? 0 : (analysis.shiftSeconds || 0);
  const auto = applyFillers(toSegments(timeline, duration, shift), fillers, duration);
  const segments = applyEdits(auto, edits, duration);
  const kept = segments.reduce((t, x) => t + (x.keep ? x.end - x.start : 0), 0);
  let outputSeconds = kept;
  if (info.video) {
    const frames = frameRanges(segments, info.video.fps, info.video.nbFrames).reduce((t, [a, b]) => t + b - a, 0);
    outputSeconds = frames / info.video.fps;
  }
  const cutsOf = (reason) => segments.filter((x) => !x.keep && !x.manual && x.reason === reason).length;
  return {
    level,
    autoLevel: autoLevelOf(analysis),
    segments,
    stats: {
      sourceSeconds: duration,
      outputSeconds,
      removedSeconds: duration - kept,
      cuts: segments.filter((x) => !x.keep).length,
      silenceCuts: cutsOf('silence'),
      fillerCuts: cutsOf('filler'),
      fillersFound: fillers.length,
      manualEdits: (edits || []).length,
    },
  };
}

module.exports = {
  SEGMENT, CHUNK_SECONDS, DEFAULT_SETTINGS,
  autoLevel, speechRuns, bridgeShortPauses, addPadding, mergeAndDropShort, buildTimeline, silenceTimeline,
  toSegments, mergeSegments, applyEdits, applyFillers, frameRanges, computeCuts, levelFor,
};
