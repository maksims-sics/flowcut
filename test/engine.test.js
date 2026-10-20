'use strict';
// Engine unit tests on small generated data: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cuts = require('../src/engine/cuts');
const { sumExpr, freePath } = require('../src/engine/render');
const { findFillers, parseList } = require('../src/engine/fillers');
const { resolveGains } = require('../src/engine/gains');

/** words from "So, um, today we look at it. It's so good, you know, really." with 0.3 s per word, 0.05 s gaps */
function sentenceWords(text, pauseAfter = {}) {
  let t = 1;
  return text.split(' ').map((w, i) => {
    const word = { w, s: t, e: t + 0.3 };
    t += 0.35 + (pauseAfter[i] || 0);
    return word;
  });
}

test('filler sounds are always cut, word fillers only when they stand alone', () => {
  const words = sentenceWords("So, um, today we look at it. It's so good, you know, really.");
  const found = findFillers(words, parseList('um, so, you know'), { duration: 10 });
  assert.deepEqual(found.map((f) => f.text), ['So', 'um', 'you know']);
  assert.ok(found.every((f) => f.end > f.start));
  // "it's so good": the middle "so" stays (no pause or punctuation around it)
  assert.ok(!found.some((f) => Math.abs(f.start - words[8].s) < 0.2));
});

test('filler list parsing: longest phrase first, punctuation ignored, duplicates dropped', () => {
  assert.deepEqual(parseList('um, you know, Um, so um, "so"'), [['you', 'know'], ['so', 'um'], ['um'], ['so']]);
});

test('filler cut edges move into the quietest part of the gap', () => {
  const words = [{ w: 'Hello', s: 1, e: 1.4 }, { w: 'um', s: 1.8, e: 2.0 }, { w: 'there', s: 2.5, e: 2.9 }];
  const db = new Float64Array(100).fill(-20);
  db[40] = -70;    // 1.60-1.64 s quiet
  db[55] = -75;    // 2.20-2.24 s quiet
  const [f] = findFillers(words, parseList('um'), { duration: 4, levels: { db, shift: 0 } });
  assert.ok(Math.abs(f.start - 1.62) < 1e-9, `start ${f.start}`);
  assert.ok(Math.abs(f.end - 2.22) < 1e-9, `end ${f.end}`);
});

test('louder ranges stack per press, reset removes them, capped at +12 dB', () => {
  const g = resolveGains([
    { start: 1, end: 3, op: 'add', db: 3 },
    { start: 2, end: 4, op: 'add', db: 3 },
    { start: 2.5, end: 3.5, op: 'reset' },
  ], 10);
  assert.deepEqual(g.map((x) => [x.start, x.end, x.db]), [[1, 2, 3], [2, 2.5, 6], [3.5, 4, 3]]);
  const capped = resolveGains(Array.from({ length: 6 }, () => ({ start: 0, end: 1, op: 'add', db: 3 })), 5);
  assert.equal(capped[0].db, 12);
});

test('cuts carry their reason: silence, filler, your edit', () => {
  const db = new Float64Array(250).fill(-70);
  for (let w = 25; w < 200; w++) db[w] = -20;                 // speech 1-8 s
  const info = { duration: 10, video: { fps: 30, nbFrames: 300 } };
  const res = cuts.computeCuts({ db, nFull: 250, shiftSeconds: 0 }, info, { autoLevel: false, levelDb: -40 },
    [{ start: 6, end: 6.5, op: 'cut' }], [{ start: 3, end: 3.4, text: 'um' }]);
  const kinds = res.segments.filter((s) => !s.keep).map((s) => (s.manual ? 'edit' : s.reason));
  assert.deepEqual(kinds, ['silence', 'filler', 'edit', 'silence']);
  assert.equal(res.stats.fillerCuts, 1);
  assert.equal(res.stats.silenceCuts, 2);
  // restoring the filler with a keep edit
  const kept = cuts.computeCuts({ db, nFull: 250, shiftSeconds: 0 }, info, { autoLevel: false, levelDb: -40 },
    [{ start: 3, end: 3.4, op: 'keep' }], [{ start: 3, end: 3.4, text: 'um' }]);
  assert.equal(kept.stats.fillerCuts, 0);
  assert.equal(kept.stats.fillersFound, 1);
});

test('auto level: mean of distinct whole-dB levels above -72.5, count from 1, floor, minus 2', () => {
  const db = Float64Array.from([-60.5, -60.2, -30.7, -30.1, -Infinity, -75, -40]);
  // distinct parseInt: -60, -30, -75, -40 -> above -72.5: -60 -30 -40 = -130, count 4 -> floor(-32.5) - 2
  assert.equal(cuts.autoLevel(db, db.length), -35);
  // a partial last window (nFull excludes it) is ignored
  assert.equal(cuts.autoLevel(db, db.length - 1), Math.floor((-60 - 30) / 3) - 2);
});

test('speech runs join touching windows', () => {
  const db = Float64Array.from([-50, -30, -30, -50, -30]);
  const runs = cuts.speechRuns(db, -40, 0.2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].start, 0.04);
  assert.equal(runs[0].duration, 0.08);
  assert.equal(runs[1].start, 0.16);
  // nothing loud: the whole file is one run
  assert.deepEqual(cuts.speechRuns(Float64Array.from([-90, -90]), -40, 7), [{ start: 0, duration: 7 }]);
});

test('short pauses are bridged, long ones stay cut', () => {
  const runs = [{ start: 0, duration: 1 }, { start: 1.3, duration: 1 }];
  assert.deepEqual(cuts.bridgeShortPauses(runs, 0.5).map((p) => p.start), [0]);
  const two = cuts.bridgeShortPauses([{ start: 0, duration: 1 }, { start: 1.6, duration: 1 }], 0.5);
  assert.equal(two.length, 2);
});

test('padding clamps at 0 but still grows the duration; short pieces drop', () => {
  const padded = cuts.addPadding([{ start: 0.005, duration: 0.5 }], 0.01, 0.15);
  assert.equal(padded[0].start, 0);
  assert.ok(Math.abs(padded[0].duration - 0.66) < 1e-12);
  assert.equal(cuts.mergeAndDropShort(padded, 0.75).length, 0);
  const merged = cuts.mergeAndDropShort([{ start: 0, duration: 1 }, { start: 0.9, duration: 1 }], 0.75);
  assert.equal(merged.length, 1);
  assert.ok(Math.abs(merged[0].duration - 1.9) < 1e-12);
});

test('timeline covers the whole file, keep and remove back to back', () => {
  const tl = cuts.buildTimeline([{ start: 1, duration: 2 }, { start: 4, duration: 1 }], 10);
  assert.deepEqual(tl.map((p) => p.operation), ['remove', 'keep', 'remove', 'keep', 'remove']);
  assert.equal(tl.at(-1).start + tl.at(-1).duration, 10);
  assert.deepEqual(Object.keys(tl[0]), ['start', 'duration', 'operation']);
});

test('manual edits split and override auto segments, later edits win', () => {
  const auto = [
    { start: 0, end: 2, keep: true, manual: false },
    { start: 2, end: 3, keep: false, manual: false },
    { start: 3, end: 5, keep: true, manual: false },
  ];
  const a = cuts.applyEdits(auto, [{ start: 1, end: 1.5, op: 'cut' }], 5);
  assert.deepEqual(a.map((s) => [s.start, s.end, s.keep, s.manual]), [
    [0, 1, true, false], [1, 1.5, false, true], [1.5, 2, true, false], [2, 3, false, false], [3, 5, true, false]]);
  const b = cuts.applyEdits(auto, [{ start: 1, end: 4, op: 'cut' }, { start: 2, end: 3, op: 'keep' }], 5);
  assert.deepEqual(b.map((s) => [s.start, s.end, s.keep]), [[0, 1, true], [1, 2, false], [2, 3, true], [3, 4, false], [4, 5, true]]);
  assert.equal(cuts.applyEdits(auto, [{ start: 6, end: 9, op: 'cut' }], 5).length, 3);
});

test('frame ranges keep frames with start <= t < end', () => {
  const r = cuts.frameRanges([
    { start: 0, end: 1.01, keep: true },
    { start: 1.01, end: 2, keep: false },
    { start: 2, end: 3.0005, keep: true },
  ], 30, 90);
  assert.deepEqual(r, [[0, 31], [60, 90]]);
});

test('computeCuts wires it all and counts output frames', () => {
  const db = new Float64Array(250).fill(-70);           // 10 s of quiet
  for (let w = 50; w < 100; w++) db[w] = -20;            // speech 2-4 s
  for (let w = 150; w < 200; w++) db[w] = -20;           // speech 6-8 s
  const analysis = { db, nFull: db.length, shiftSeconds: 0 };
  const info = { duration: 10, video: { fps: 30, nbFrames: 300 } };
  const res = cuts.computeCuts(analysis, info, { autoLevel: false, levelDb: -40 }, []);
  const kept = res.segments.filter((s) => s.keep);
  assert.equal(kept.length, 2);
  assert.ok(Math.abs(kept[0].start - 1.99) < 1e-9 && Math.abs(kept[0].end - 4.15) < 1e-9);
  assert.equal(res.stats.cuts, 3);
  assert.equal(res.stats.manualEdits, 0);
  const edited = cuts.computeCuts(analysis, info, { autoLevel: false, levelDb: -40 }, [{ start: 2.5, end: 3, op: 'cut' }]);
  assert.equal(edited.segments.filter((s) => s.keep).length, 3);
  assert.ok(edited.stats.outputSeconds < res.stats.outputSeconds);
});

test('corrected timing shifts cuts by the analysis offset', () => {
  const db = new Float64Array(100).fill(-70);
  for (let w = 25; w < 50; w++) db[w] = -20;
  const info = { duration: 4, video: null };
  const base = { autoLevel: false, levelDb: -40, minPiece: 0 };
  const shifted = cuts.computeCuts({ db, nFull: 100, shiftSeconds: 0.022 }, info, { ...base, keepAnalysisShift: true }, []);
  const fixed = cuts.computeCuts({ db, nFull: 100, shiftSeconds: 0.022 }, info, { ...base, keepAnalysisShift: false }, []);
  const k1 = shifted.segments.find((s) => s.keep);
  const k2 = fixed.segments.find((s) => s.keep);
  assert.ok(Math.abs(k2.start - k1.start - 0.022) < 1e-9);
});

test('select expression nests groups so ffmpeg accepts any number of pieces', () => {
  const terms = Array.from({ length: 450 }, (_, i) => `between(n,${i * 3},${i * 3 + 1})`);
  const expr = sumExpr(terms);
  assert.equal((expr.match(/between/g) || []).length, 450);
  // no flat run of more than 20 terms at any nesting level
  for (const group of expr.split(/[()]/)) assert.ok(group.split('+').filter((x) => x.startsWith('between')).length <= 20);
});

test('free output path never overwrites', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowcut-test-'));
  const p = path.join(dir, 'a_flowcut.mp4');
  assert.equal(freePath(p), p);
  fs.writeFileSync(p, 'x');
  assert.equal(freePath(p), path.join(dir, 'a_flowcut (2).mp4'));
  fs.rmSync(dir, { recursive: true, force: true });
});
