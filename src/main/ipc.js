'use strict';
// The API the window uses (exposed as window.flowcut by preload.js). Every channel is listed in README.md.
const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findTools, hasEncoder, ffmpegMajor } = require('../engine/tools');
const { probe } = require('../engine/probe');
const { extractAnalysisAudio, computeLevels } = require('../engine/analyze');
const { DEFAULT_SETTINGS, computeCuts } = require('../engine/cuts');
const { findFillers, parseList, DEFAULT_LIST } = require('../engine/fillers');
const { resolveGains } = require('../engine/gains');
const { render } = require('../engine/render');
const { transcribe, whisperStatus } = require('../engine/transcribe');
const { makeProxy, makeFastCopy } = require('../engine/proxy');
const { Jobs } = require('./jobs');

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi', 'ts'];

const APP_DEFAULTS = {
  detection: { ...DEFAULT_SETTINGS },   // silences: fixed rules and values, no UI
  fillers: { enabled: true, list: DEFAULT_LIST },
  render: { format: 'mp4', quality: 'best', encoder: 'auto', suffix: '_flowcut', outputDir: '', segmentsMap: false },
  transcript: { language: 'en', vocabulary: '', auto: true },
  view: { captions: true },             // the spoken words over the video
  tools: {},                            // custom paths: { ffmpeg, ffprobe, analysisFfmpeg, python }
};

/** App settings: the saved ones over the defaults. */
function loadAppSettings(store) {
  const saved = store.settings() || {};
  const settings = {
    ...APP_DEFAULTS,
    ...saved,
    // no detection settings in the window (automatic only): always the built-in values. A value saved by an older
    // version (v1 had a level slider) must not linger: it made the cuts drift from the built-in rules.
    detection: { ...APP_DEFAULTS.detection },
    fillers: { ...APP_DEFAULTS.fillers, ...saved.fillers },
    render: { ...APP_DEFAULTS.render, ...saved.render },
    transcript: { ...APP_DEFAULTS.transcript, ...saved.transcript },
    view: { ...APP_DEFAULTS.view, ...saved.view },
    tools: { ...saved.tools },
  };
  store.saveSettings(settings);
  return settings;
}

function registerIpc({ getWindow, store, startupFile }) {
  const jobs = new Jobs((msg) => getWindow()?.webContents.send('job', msg));
  const loaded = new Map();       // project id -> { project, analysis: {db, nFull, shiftSeconds}, words }
  let settings = loadAppSettings(store);
  let tools = findTools(settings.tools);
  let whisper = null;
  let pendingStartup = startupFile;

  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));
  const need = (id) => {
    const p = loaded.get(id);
    if (!p) throw new Error('Project is not open');
    return p;
  };
  // the editor shows the original; only a file the window cannot play at all is shown through its review copy
  const mediaPath = (project) => (project.proxy && fs.existsSync(project.proxy) ? project.proxy : project.source.path);
  const fastPath = (project) => (project.fast && fs.existsSync(project.fast) ? project.fast : null);
  /** Copies made before v3 were 1080p and stood in for the original at 4x / 6x: they are dropped. */
  const dropOldCopies = (id, project) => {
    if (project.proxy && project.proxyRes !== 'source') delete project.proxy;
    if (!project.proxy && !jobs.isBusy('proxy')) {
      try { fs.rmSync(store.proxyFile(id), { force: true }); } catch { /* still open somewhere: next time */ }
    }
    if (project.fast && !fs.existsSync(project.fast)) delete project.fast;
  };
  const readWords = (id) => {
    const f = store.transcriptFile(id);
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).words : null; } catch { return null; }
  };
  const snapshot = (id) => {
    const { project, words } = need(id);
    return {
      id,
      name: path.basename(project.source.path),
      path: project.source.path,
      mediaUrl: pathToFileURL(mediaPath(project)).href,
      usingProxy: mediaPath(project) !== project.source.path,
      fastUrl: fastPath(project) ? pathToFileURL(fastPath(project)).href : null,
      info: project.info,
      analysis: project.analysis,
      edits: project.edits || [],
      gainEdits: project.gainEdits || [],
      splits: project.splits || [],
      hasTranscript: Boolean(words),
    };
  };
  const saveProject = (id) => store.saveProject(id, need(id).project);

  /** Silences -> filler words from the transcript -> your edits; plus the louder ranges. */
  const cutsFor = (id, state = {}) => {
    const p = need(id);
    const duration = p.project.info.duration;
    const fillers = settings.fillers.enabled && p.words
      ? findFillers(p.words, parseList(settings.fillers.list), { duration, levels: { db: p.analysis.db, shift: p.analysis.shiftSeconds } })
      : [];
    const cut = computeCuts(p.analysis, p.project.info, settings.detection, state.edits ?? p.project.edits, fillers);
    cut.gains = resolveGains(state.gainEdits ?? p.project.gainEdits, duration);
    return cut;
  };

  // ---- app
  handle('app:info', async () => {
    if (!whisper) whisper = whisperStatus(tools);
    return {
      version: app.getVersion(),
      tools: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, python: tools.python },
      ffmpegMajor: tools.ffmpeg ? await ffmpegMajor(tools.ffmpeg).catch(() => 0) : 0,
      nvenc: tools.ffmpeg ? await hasEncoder(tools.ffmpeg, 'h264_nvenc').catch(() => false) : false,
      whisper: await whisper,
      settings,
    };
  });
  handle('app:settings:save', (patch) => {
    settings = { ...settings, ...patch };
    store.saveSettings(settings);
    if (patch.tools) { tools = findTools(settings.tools); whisper = null; }
    return settings;
  });
  handle('app:startup-file', () => { const f = pendingStartup; pendingStartup = null; return f; });
  handle('app:toggle-devtools', () => getWindow()?.webContents.toggleDevTools());

  // ---- dialogs and shell
  handle('dialog:open-video', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: 'Open a recording',
      properties: ['openFile'],
      filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }, { name: 'All files', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:choose-folder', async (current) => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Render into this folder', defaultPath: current || undefined, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('shell:reveal', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
  handle('shell:open', (p) => (p && fs.existsSync(p) ? shell.openPath(p) : 'not found'));
  handle('recent:list', () => store.recent());

  // ---- projects
  handle('project:open', (file) => {
    if (!file || !fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    return jobs.start('analyze', path.basename(file), async ({ signal, progress, status }) => {
      status('Reading the file');
      const info = await probe(file, tools, { signal });
      const id = store.projectId(info);
      let project = store.loadProject(id);
      let db;
      if (project && store.hasLevels(id)) {
        db = store.loadLevels(id);
        project.info = info;                                   // fresh media facts (e.g. colour tags)
      } else {
        const wav = path.join(store.projectDir(id), 'analysis.wav');
        try {
          status('Finding the silences');
          const audio = await extractAnalysisAudio(file, info, tools, wav, { signal, onProgress: (p) => progress(p * 0.7) });
          const lv = await computeLevels(wav, { emulateOffset: audio.emulateOffset, signal, onProgress: (p) => progress(0.7 + p * 0.3) });
          db = lv.db;
          store.saveLevels(id, db);
          project = {
            version: 2,
            id,
            source: { path: file, size: info.size, mtimeMs: info.mtimeMs },
            info,
            analysis: {
              exact: audio.exact,
              offset: audio.offset,
              shiftSeconds: audio.shiftSeconds,
              phaseFlipped: audio.phaseFlipped,
              sampleRate: lv.sampleRate,
              samplesPerWindow: lv.samplesPerWindow,
              windows: lv.windows,
              nFull: lv.nFull,
            },
            edits: [],
            gainEdits: [],
            createdAt: new Date().toISOString(),
          };
        } finally {
          fs.rmSync(wav, { force: true });
        }
      }
      dropOldCopies(id, project);
      store.saveProject(id, project);
      loaded.set(id, {
        project,
        analysis: { db, nFull: project.analysis.nFull, shiftSeconds: project.analysis.shiftSeconds },
        words: readWords(id),
      });
      store.addRecent({ path: file, name: path.basename(file), duration: info.duration });
      return snapshot(id);
    });
  });
  handle('project:levels', (id) => Float32Array.from(need(id).analysis.db));
  handle('project:save', (id, { edits, gainEdits, splits }) => {
    const { project } = need(id);
    if (edits) project.edits = edits;
    if (gainEdits) project.gainEdits = gainEdits;
    if (splits) project.splits = splits;
    saveProject(id);
    return true;
  });
  handle('cuts:compute', (id, state) => cutsFor(id, state));

  // ---- transcript
  handle('transcript:get', (id) => need(id).words);
  handle('transcribe:start', (id, opts = {}) => {
    const p = need(id);
    settings = { ...settings, transcript: { ...settings.transcript, ...opts } };
    store.saveSettings(settings);
    return jobs.start('transcribe', path.basename(p.project.source.path), async ({ signal, progress, status }) => {
      const result = await transcribe(p.project.source.path, p.project.info, store.transcriptFile(id), tools, settings.transcript,
        { signal, onProgress: progress, onStatus: status });
      p.words = result.words;
      return { words: result.words.length, device: result.device, model: result.model };
    });
  });

  // ---- render and export
  handle('render:start', (id, state = {}) => {
    const p = need(id);
    settings = { ...settings, render: { ...settings.render, ...(state.render || {}) } };
    store.saveSettings(settings);
    const rs = settings.render;
    const src = p.project.source.path;
    const dir = rs.outputDir && fs.existsSync(rs.outputDir) ? rs.outputDir : path.dirname(src);
    const outPath = path.join(dir, `${path.parse(src).name}${rs.suffix || '_flowcut'}.${rs.format === 'mov' ? 'mov' : 'mp4'}`);
    const cut = cutsFor(id, state);
    return jobs.start('render', path.basename(outPath), async ({ signal, progress, status }) => {
      const info = await probe(src, tools, { signal });       // fresh facts incl. colour tags
      return render(src, info, cut.segments,
        { outPath, format: rs.format, quality: rs.quality, encoder: rs.encoder, gains: cut.gains, segmentsMap: rs.segmentsMap, level: cut.level },
        tools, { signal, onProgress: progress, onStatus: status });
    });
  });
  // ---- review copy and jobs
  handle('proxy:make', (id) => {
    const { project } = need(id);
    if (jobs.isBusy('proxy')) return null;
    return jobs.start('proxy', path.basename(project.source.path), async ({ signal, progress, status }) => {
      status('Making a review copy');
      const file = await makeProxy(project.source.path, project.info, store.proxyFile(id), tools, { signal, onProgress: progress });
      Object.assign(need(id).project, { proxy: file, proxyRes: 'source' });
      saveProject(id);
      return { projectId: id, mediaUrl: pathToFileURL(file).href };
    });
  });
  handle('fast:make', (id) => {
    const { project } = need(id);
    if (jobs.isBusy('fast')) return null;
    return jobs.start('fast', path.basename(project.source.path), async ({ signal, progress, status }) => {
      status('Making the fast copy');
      const file = await makeFastCopy(project.source.path, project.info, store.fastFile(id), tools, { signal, onProgress: progress });
      need(id).project.fast = file;
      saveProject(id);
      store.pruneFastCopies(3);
      return { projectId: id, fastUrl: pathToFileURL(file).href };
    });
  });
  handle('job:cancel', (jobId) => jobs.cancel(jobId));

  return { jobs };
}

module.exports = { registerIpc };
