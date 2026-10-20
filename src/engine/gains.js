'use strict';
// "Louder" moments. Gain edits are applied in order like cut edits:
//   { start, end, op: 'add', db: 3 }   adds 3 dB on that range (presses stack)
//   { start, end, op: 'reset' }        removes any boost on that range
// The result is a list of non-overlapping intervals { start, end, db } with db > 0, capped at MAX_DB.
const MAX_DB = 12;

function resolveGains(gainEdits, duration) {
  let parts = [{ start: 0, end: duration, db: 0 }];
  for (const g of gainEdits || []) {
    const a = Math.max(0, Math.min(duration, g.start));
    const b = Math.max(0, Math.min(duration, g.end));
    if (b - a < 1e-6) continue;
    const next = [];
    for (const p of parts) {
      if (p.end <= a || p.start >= b) { next.push(p); continue; }
      if (p.start < a) next.push({ ...p, end: a });
      const db = g.op === 'reset' ? 0 : Math.min(MAX_DB, p.db + (Number(g.db) || 0));
      next.push({ start: Math.max(p.start, a), end: Math.min(p.end, b), db });
      if (p.end > b) next.push({ ...p, start: b });
    }
    parts = next;
  }
  const out = [];
  for (const p of parts) {
    if (!(p.db > 0) || p.end <= p.start) continue;
    const prev = out[out.length - 1];
    if (prev && prev.db === p.db && Math.abs(prev.end - p.start) < 1e-9) prev.end = p.end;
    else out.push({ ...p });
  }
  return out;
}

module.exports = { resolveGains, MAX_DB };
