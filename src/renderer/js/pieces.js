// Pieces as the editor shows them: the engine's segments, split again at every S press and at the
// edges of your edits, so a piece you toggled stays a piece of its own. A split alone changes nothing in the render:
// touching kept pieces are rendered in one go, without a join.
import { segmentIndexAt } from './util.js';

const EPS = 1e-3;

/** segments: engine output (sorted, contiguous). splits: seconds. edits: [{start, end}]. -> [{start, end, keep, ...}] */
export function buildPieces(segments, splits = [], edits = []) {
  if (!segments?.length) return [];
  const end = segments[segments.length - 1].end;
  const points = [0, end];
  for (const s of segments) points.push(s.start);
  for (const t of splits) points.push(t);
  for (const e of edits) points.push(e.start, e.end);
  points.sort((a, b) => a - b);
  const cuts = [];
  for (const p of points) {
    if (p < -EPS || p > end + EPS) continue;
    if (!cuts.length || p - cuts[cuts.length - 1] > EPS) cuts.push(Math.min(end, Math.max(0, p)));
  }
  const pieces = [];
  let si = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const mid = (a + b) / 2;
    while (si < segments.length - 1 && segments[si].end <= mid) si++;
    const s = segments[si];
    pieces.push({ start: a, end: b, keep: s.keep, manual: s.manual, reason: s.reason, text: s.text });
  }
  return pieces;
}

/** The piece containing t, or null. */
export function pieceAt(pieces, t) {
  const i = segmentIndexAt(pieces, t);
  return i < 0 ? null : pieces[i];
}

/** True when t is (almost) on an existing piece edge, where a split would add nothing. */
export function onEdge(pieces, t, tolerance = 0.02) {
  const p = pieceAt(pieces, t);
  return Boolean(p && (t - p.start < tolerance || p.end - t < tolerance));
}
