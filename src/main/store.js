'use strict';
// Everything FlowCut keeps lives under %APPDATA%\FlowCut (Electron's userData):
//   settings.json            app settings (detection defaults, render choices, tool paths)
//   recent.json              recently opened recordings
//   projects/<id>/project.json   per recording: media facts, analysis facts, settings, manual edits
//   projects/<id>/levels.f64     40 ms loudness windows (Float64, little endian)
//   projects/<id>/transcript.json
//   projects/<id>/proxy.mp4      review copy of a file the window cannot play (same size)
//   projects/<id>/fast.mp4       fast copy for smooth 4x / 6x (same size, 10 frames a second)
// A project id is derived from path + size + modification time, so a changed file is analysed again.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RECENT_MAX = 12;

class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
  }

  readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  writeJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }

  // ---- app settings
  get settingsFile() { return path.join(this.root, 'settings.json'); }
  settings() { return this.readJson(this.settingsFile, null); }
  saveSettings(settings) { this.writeJson(this.settingsFile, settings); return settings; }

  // ---- recent files
  recent() {
    return this.readJson(path.join(this.root, 'recent.json'), []).filter((r) => fs.existsSync(r.path));
  }

  addRecent(entry) {
    const list = this.readJson(path.join(this.root, 'recent.json'), [])
      .filter((r) => r.path.toLowerCase() !== entry.path.toLowerCase());
    list.unshift({ ...entry, openedAt: new Date().toISOString() });
    this.writeJson(path.join(this.root, 'recent.json'), list.slice(0, RECENT_MAX));
  }

  // ---- projects
  projectId(info) {
    return crypto.createHash('sha1').update(`${info.path.toLowerCase()}|${info.size}|${info.mtimeMs}`).digest('hex').slice(0, 16);
  }

  projectDir(id) {
    const dir = path.join(this.root, 'projects', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  loadProject(id) { return this.readJson(path.join(this.projectDir(id), 'project.json'), null); }

  saveProject(id, project) {
    this.writeJson(path.join(this.projectDir(id), 'project.json'), { ...project, updatedAt: new Date().toISOString() });
  }

  levelsFile(id) { return path.join(this.projectDir(id), 'levels.f64'); }
  hasLevels(id) { return fs.existsSync(this.levelsFile(id)); }

  saveLevels(id, db) {
    fs.writeFileSync(this.levelsFile(id), Buffer.from(db.buffer, db.byteOffset, db.byteLength));
  }

  loadLevels(id) {
    const buf = fs.readFileSync(this.levelsFile(id));
    const copy = new ArrayBuffer(buf.length);
    new Uint8Array(copy).set(buf);
    return new Float64Array(copy);
  }

  transcriptFile(id) { return path.join(this.projectDir(id), 'transcript.json'); }
  proxyFile(id) { return path.join(this.projectDir(id), 'proxy.mp4'); }
  fastFile(id) { return path.join(this.projectDir(id), 'fast.mp4'); }

  /** Fast copies take ~20 MB per minute: only the `keep` newest stay (they are remade on demand). */
  pruneFastCopies(keep = 3) {
    const root = path.join(this.root, 'projects');
    let files = [];
    try {
      files = fs.readdirSync(root).map((id) => path.join(root, id, 'fast.mp4')).filter((f) => fs.existsSync(f))
        .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    } catch { return; }
    for (const { f } of files.slice(keep)) {
      try { fs.rmSync(f, { force: true }); } catch { /* in use: next time */ }
    }
  }
}

module.exports = { Store };
