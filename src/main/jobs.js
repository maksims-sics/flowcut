'use strict';
// Long-running work (analysis, transcription, render, preview copy) with progress, status text and Cancel.
// Every change is pushed to the window as a `job` event: {type: start|progress|done|error|cancelled, id, kind, ...}.

class Jobs {
  constructor(send) {
    this.send = send;
    this.running = new Map();
    this.seq = 0;
  }

  /** fn({signal, progress(fraction), status(text)}) -> result. Returns the job id at once. */
  start(kind, label, fn) {
    const id = `job${++this.seq}`;
    const ac = new AbortController();
    const job = { id, kind, label, progress: 0, message: '', lastSent: 0 };
    this.running.set(id, { ...job, ac });
    const push = (force) => {
      const now = Date.now();
      if (!force && now - job.lastSent < 80) return;   // at most ~12 updates a second
      job.lastSent = now;
      this.send({ type: 'progress', id, kind, label, progress: job.progress, message: job.message });
    };
    this.send({ type: 'start', id, kind, label });
    setImmediate(async () => {
      try {
        const result = await fn({
          signal: ac.signal,
          progress: (p) => { job.progress = Math.max(0, Math.min(1, p)); push(false); },
          status: (text) => { job.message = text; push(true); },
        });
        this.send({ type: 'done', id, kind, label, result });
      } catch (err) {
        const cancelled = err?.name === 'CancelledError' || ac.signal.aborted;
        this.send({ type: cancelled ? 'cancelled' : 'error', id, kind, label, error: cancelled ? null : String(err?.message || err) });
      } finally {
        this.running.delete(id);
      }
    });
    return id;
  }

  cancel(id) { this.running.get(id)?.ac.abort(); }
  cancelAll() { for (const j of this.running.values()) j.ac.abort(); }
  isBusy(kind) { return [...this.running.values()].some((j) => j.kind === kind); }
}

module.exports = { Jobs };
