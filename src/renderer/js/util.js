// Small helpers shared by the page modules.
export const $ = (selector, root = document) => root.querySelector(selector);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 75.25 -> "01:15.25", 3725.5 -> "1:02:05.50" */
export function fmtTime(t, decimals = 2) {
  if (!Number.isFinite(t)) t = 0;
  const neg = t < 0;
  const scale = 10 ** decimals;
  let units = Math.round(Math.abs(t) * scale);
  const frac = units % scale;
  units = (units - frac) / scale;
  const h = Math.floor(units / 3600);
  const m = Math.floor((units % 3600) / 60);
  const s = units % 60;
  const ss = String(s).padStart(2, '0') + (decimals ? `.${String(frac).padStart(decimals, '0')}` : '');
  const mm = String(m).padStart(2, '0');
  return `${neg ? '-' : ''}${h ? `${h}:${mm}` : mm}:${ss}`;
}

/** Seconds as words: "46.3 s", "18 min 46 s", "1 h 2 min" */
export function fmtLength(t) {
  if (!Number.isFinite(t)) return '';
  if (t < 60) return `${t.toFixed(1)} s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m} min ${Math.round(t - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function debounce(fn, ms) {
  let timer = 0;
  const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
}

/** Index of the segment containing t (segments are sorted and contiguous), or -1. */
export function segmentIndexAt(segments, t) {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid];
    if (t < s.start) hi = mid - 1;
    else if (t >= s.end) lo = mid + 1;
    else return mid;
  }
  return segments.length && t >= segments[segments.length - 1].end ? segments.length - 1 : -1;
}

/** First index whose word ends after t. */
export function wordIndexAfter(words, t) {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].e <= t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function basename(p) { return String(p).split(/[\\/]/).pop(); }
export function dirname(p) { const parts = String(p).split(/[\\/]/); parts.pop(); return parts.join('\\'); }
export function stem(p) { return basename(p).replace(/\.[^.]+$/, ''); }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function timeAgo(iso) {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 90) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  const d = Math.round(sec / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
