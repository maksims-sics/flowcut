// Notifications in the bottom-right corner, optionally with a progress bar and buttons.
import { escapeHtml } from './util.js';
import { icon } from './icons.js';

export class Toasts {
  constructor(root) { this.root = root; }

  /**
   * show({ title, body, kind: 'info'|'success'|'error', progress: bool, actions: [{label, primary, onClick}],
   *        timeout: ms, closable }) -> { update({title, body, progress}), close() }
   */
  show({ title, body = '', kind = 'info', progress = false, actions = [], timeout = 0, closable = true }) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `
      <div class="toast-head"><span class="t-title">${escapeHtml(title)}</span>
        ${closable ? `<button class="close" title="Close">${icon('close')}</button>` : ''}</div>
      <div class="toast-body"${body ? '' : ' hidden'}>${escapeHtml(body)}</div>
      ${progress ? '<div class="progress"><i></i></div>' : ''}
      <div class="toast-actions"${actions.length ? '' : ' hidden'}></div>`;
    const actionsEl = el.querySelector('.toast-actions');
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = `btn btn-xs${a.primary ? ' btn-primary' : ''}`;
      b.textContent = a.label;
      b.addEventListener('click', () => a.onClick?.(handle));
      actionsEl.append(b);
    }
    let timer = 0;
    const handle = {
      el,
      update({ title: t, body: b, progress: p, kind: k } = {}) {
        if (t !== undefined) el.querySelector('.t-title').textContent = t;
        if (b !== undefined) { const bodyEl = el.querySelector('.toast-body'); bodyEl.textContent = b; bodyEl.hidden = !b; }
        if (p !== undefined) { const bar = el.querySelector('.progress > i'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; }
        if (k) el.className = `toast ${k}`;
      },
      close() { clearTimeout(timer); el.remove(); },
    };
    el.querySelector('.close')?.addEventListener('click', () => handle.close());
    if (timeout) timer = setTimeout(() => handle.close(), timeout);
    this.root.append(el);
    return handle;
  }

  error(title, body) { return this.show({ title, body, kind: 'error', timeout: 12000 }); }
  success(title, body, actions = []) { return this.show({ title, body, kind: 'success', actions, timeout: actions.length ? 0 : 6000 }); }
}
