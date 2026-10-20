// The Review list: every cut (silence, filler word, your cut) and every louder moment, in time order.
// Click a row to jump there (1 s before): Space then plays that cut, preview does not skip it. The row's button
// brings a cut back or removes a boost.
import { fmtTime, escapeHtml } from './util.js';

const LABEL = {
  filler: (it) => `“${escapeHtml(it.text || 'filler')}”`,
  silence: () => 'Pause',
  edit: () => 'Your cut',
  louder: (it) => `Louder +${Math.round(it.db * 10) / 10} dB`,
};

export class ReviewList {
  constructor(root, { onPick, onAction }) {
    this.root = root;
    this.filter = 'all';
    this.items = [];
    this.current = -1;
    this.onPick = onPick;
    this.onAction = onAction;
    this.list = root.querySelector('.review-list');
    root.querySelector('.tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-filter]');
      if (!b) return;
      this.filter = b.dataset.filter;
      this.render();
    });
    this.list.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      const item = this.items[Number(row.dataset.i)];
      if (e.target.closest('[data-act]')) this.onAction(item);
      else this.onPick(item);
    });
  }

  update(segments, gains) {
    this.items = [
      ...segments.filter((s) => !s.keep).map((s) => ({
        kind: s.manual ? 'edit' : s.reason === 'filler' ? 'filler' : 'silence', start: s.start, end: s.end, text: s.text,
      })),
      ...gains.map((g) => ({ kind: 'louder', start: g.start, end: g.end, db: g.db })),
    ].sort((a, b) => a.start - b.start);
    const count = (k) => this.items.filter((i) => i.kind === k).length;
    for (const b of this.root.querySelectorAll('.tabs button')) {
      const k = b.dataset.filter;
      b.querySelector('b').textContent = k === 'all' ? this.items.length : count(k);
      b.classList.toggle('is-on', k === this.filter);
    }
    this.current = -1;
    this.render();
  }

  render() {
    for (const b of this.root.querySelectorAll('.tabs button')) b.classList.toggle('is-on', b.dataset.filter === this.filter);
    const rows = [];
    this.items.forEach((it, i) => {
      if (this.filter !== 'all' && it.kind !== this.filter) return;
      rows.push(`<li class="ri ri-${it.kind}" data-i="${i}">
        <i class="ri-dot"></i>
        <span class="ri-time">${fmtTime(it.start, 1)}</span>
        <span class="ri-label">${LABEL[it.kind](it)}</span>
        <span class="ri-len">${(it.end - it.start).toFixed(1)} s</span>
        <button class="ri-act" data-act title="${it.kind === 'louder' ? 'Remove this boost' : 'Bring this part back (keep it)'}">${it.kind === 'louder' ? 'Remove' : 'Keep'}</button>
      </li>`);
    });
    this.list.innerHTML = rows.length ? rows.join('') : '<li class="ri-empty">Nothing to review here</li>';
  }

  /** Highlights the row under the playhead. */
  setTime(t) {
    const i = this.items.findIndex((it) => t >= it.start && t < it.end);
    if (i === this.current) return;
    this.list.querySelector('.ri.is-current')?.classList.remove('is-current');
    this.current = i;
    const row = i >= 0 ? this.list.querySelector(`[data-i="${i}"]`) : null;
    if (row) {
      row.classList.add('is-current');
      row.scrollIntoView({ block: 'nearest' });
    }
  }
}
