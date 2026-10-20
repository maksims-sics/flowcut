// FlowCut page controller: opens recordings, keeps edits / cuts / review in sync, and drives the jobs.
import { $, basename, dirname, stem, debounce, fmtLength, fmtTime, escapeHtml, timeAgo, segmentIndexAt } from './util.js';
import { hydrateIcons, setIcon } from './icons.js';
import { Timeline } from './timeline.js';
import { Player } from './player.js';
import { EditHistory } from './edits.js';
import { ReviewList } from './review.js';
import { Toasts } from './toasts.js';
import { shortcutTable, installShortcuts } from './shortcuts.js';
import { buildPieces, pieceAt, onEdge } from './pieces.js';
import { Captions } from './captions.js';

const api = window.flowcut;
const LOUDER_STEP_DB = 3;
const PASS_HINT = 'Playing a cut part: it stays cut (click its bar or K to bring it back)';
const S = {
  info: null,          // tools + app settings (app:info)
  project: null,       // snapshot of the open recording
  cut: null,           // { segments, gains, stats, level } from the engine
  pieces: [],          // the engine's segments split again at your splits (what the piece bar shows)
  words: null,
  prefix: [],          // kept seconds before each segment (result time)
  busyJob: null,
  transcribe: null,    // { id, progress, message } while Whisper runs
  renderToasts: new Map(),
  proxyJob: null,
  proxyToast: null,
  fastJob: null,
  fastToast: null,
};

hydrateIcons();
const toasts = new Toasts($('#toasts'));
const history = new EditHistory(onEditsChanged);
const timeline = new Timeline($('#timeline'), {
  onSeek: (t) => player.seek(t),          // into a cut: preview plays that cut (player.pass)
  onToggleAt: flipAt,                     // double-click in the lanes
  onTogglePiece: togglePiece,             // click on a piece's bar
});
const player = new Player($('#video'), $('#videoFast'), {
  onTime: (t) => { timeline.setTime(t, player.playing); updateTimecodes(t); review.setTime(t); captions.setTime(t); },
  onState: (playing) => setIcon($('#btnPlay'), playing ? 'pause' : 'play'),
  onError: onVideoError,
  onPass: (on) => { if (on) flash(PASS_HINT, 0); else unflash(PASS_HINT); },
  onPassChange: (range) => timeline.setPass(range),
});
const review = new ReviewList($('.card-review'), { onPick: pickItem, onAction: itemAction });
const captions = new Captions($('#caption'));
// Chromium plays the sound of a file whose video codec it lacks (MPEG-2, some HEVC) without raising an error:
// a missing picture is detected here so the review-copy offer still appears
$('#video').addEventListener('loadedmetadata', (e) => {
  if (S.project?.info.video && !S.project.usingProxy && e.target.videoWidth === 0) onVideoError({ code: 4 });
});
// for DevTools (F12) and the end-to-end test: window.__flowcut.S is the live state
window.__flowcut = { S, timeline, player, history, review, captions, setWords: (w) => setWords(w) };

// ---------------------------------------------------------------- startup
init().catch((err) => toasts.error('FlowCut could not start', err.message));

async function init() {
  bindUi();
  api.onJob(onJob);
  api.onOpenFile((file) => openFile(file));
  S.info = await api.info();
  renderToolsStatus();
  renderRecent();
  applyAppSettings();
  const file = await api.startupFile();
  if (file) openFile(file);
}

function bindUi() {
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
  on('#btnOpen', 'click', pickAndOpen);
  on('#btnOpenBig', 'click', pickAndOpen);
  on('#btnRender', 'click', startRender);
  on('#btnRender2', 'click', startRender);
  on('#btnPlay', 'click', () => player.toggle());
  on('#btnPrevCut', 'click', () => jumpCut(-1));
  on('#btnNextCut', 'click', () => jumpCut(1));
  on('#skipCuts', 'change', (e) => { player.skipCuts = e.target.checked; });
  on('#speeds', 'click', (e) => { const b = e.target.closest('button[data-rate]'); if (b) setSpeed(Number(b.dataset.rate)); });
  on('#btnUndo', 'click', () => history.undo());
  on('#btnRedo', 'click', () => history.redo());
  on('#captionsOn', 'change', (e) => setCaptions(e.target.checked));
  on('#btnZoomIn', 'click', () => timeline.zoom(0.6, player.time));
  on('#btnZoomOut', 'click', () => timeline.zoom(1 / 0.6, player.time));
  on('#btnZoomFit', 'click', () => timeline.fit());
  on('#btnHelp', 'click', showHelp);
  on('#btnHelp2', 'click', showHelp);
  on('#helpClose', 'click', () => { $('#help').hidden = true; });
  on('#btnTranscribe', 'click', () => (S.transcribe ? api.cancelJob(S.transcribe.id) : startTranscribe()));
  on('#btnProxy', 'click', () => makeProxy());
  on('#busyCancel', 'click', () => S.busyJob && api.cancelJob(S.busyJob));
  on('#btnOutDir', 'click', chooseOutputDir);
  on('#btnOutDirReset', 'click', () => saveRenderPrefs({ outputDir: '' }));
  on('#format', 'change', (e) => { saveRenderPrefs({ format: e.target.value }); e.target.blur(); });
  on('#quality', 'change', (e) => { saveRenderPrefs({ quality: e.target.value }); e.target.blur(); });
  on('#lang', 'change', (e) => e.target.blur());
  on('#fillersOn', 'change', (e) => saveFillers({ enabled: e.target.checked }));
  on('#fillerList', 'change', (e) => saveFillers({ list: e.target.value }));

  const drop = $('#drop');
  document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('is-over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(api.pathForFile(file));
  });

  const table = shortcutTable({
    togglePlay: () => S.project && player.toggle(),
    speed: setSpeed,
    togglePreview: () => { const c = $('#skipCuts'); c.checked = !c.checked; player.skipCuts = c.checked; flash(c.checked ? 'Preview result: cuts are skipped' : 'Everything plays, cuts included'); },
    step: (n) => S.project && player.step(n),
    jumpCut,
    nudge: (s) => S.project && player.seek(player.time + s),
    seekEdge: (end) => S.project && player.seek(end ? S.project.info.duration : 0),
    split: splitHere,
    flipHere: () => S.project && flipAt(player.time),
    cutHere: () => setPieceHere(false),
    keepHere: () => setPieceHere(true),
    louder,
    captions: () => setCaptions(!$('#captionsOn').checked),
    escape: () => { $('#help').hidden = true; },
    undo: () => history.undo(),
    redo: () => history.redo(),
    zoom: (f) => timeline.zoom(f, player.time),
    fit: () => timeline.fit(),
    open: pickAndOpen,
    render: startRender,
    help: showHelp,
    devtools: () => api.toggleDevTools(),
  });
  installShortcuts(table);
  $('#helpList').innerHTML = table.filter((s) => !s.hidden).map((s) => (s.group
    ? `<dt class="help-group">${escapeHtml(s.group)}</dt>`
    : `<dt>${s.keys.split(' ').map((k) => (/^[+/]$/.test(k) ? k : `<kbd>${escapeHtml(k)}</kbd>`)).join(' ')}</dt><dd>${escapeHtml(s.label)}</dd>`)).join('');
}

// ---------------------------------------------------------------- welcome screen
function renderToolsStatus() {
  const i = S.info;
  const item = (ok, text, warn = false) => `<span><i class="dot ${ok ? 'ok' : warn ? 'warn' : 'bad'}"></i>${escapeHtml(text)}</span>`;
  $('#toolsStatus').innerHTML = [
    item(Boolean(i.tools.ffmpeg), i.tools.ffmpeg ? `ffmpeg ${i.ffmpegMajor}` : 'ffmpeg missing'),
    item(i.nvenc, i.nvenc ? 'NVENC encoder' : 'CPU encoder (x264)', true),
    item(i.whisper.ok, i.whisper.ok ? `Filler words: Whisper on ${i.whisper.gpu ? 'GPU' : 'CPU'}` : 'Whisper not available', true),
  ].join('');
}

async function renderRecent() {
  const list = await api.recent();
  $('#recentSection').hidden = !list.length;
  $('#recentList').innerHTML = list.map((r, i) => `
    <li><button data-i="${i}">
      <span class="r-name">${escapeHtml(r.name)}</span>
      <span class="r-meta">${escapeHtml(fmtLength(r.duration))} · ${escapeHtml(timeAgo(r.openedAt))}</span>
      <span class="r-path">${escapeHtml(dirname(r.path))}</span>
    </button></li>`).join('');
  $('#recentList').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => openFile(list[Number(b.dataset.i)].path)));
}

function applyAppSettings() {
  const s = S.info.settings;
  $('#format').value = s.render.format;
  $('#quality').value = s.render.quality;
  $('#lang').value = s.transcript.language;
  $('#vocab').value = s.transcript.vocabulary;
  $('#fillersOn').checked = s.fillers.enabled;
  $('#fillerList').value = s.fillers.list;
  $('#encoderChip').textContent = S.info.nvenc ? 'GPU' : 'CPU';
  $('#captionsOn').checked = s.view?.captions !== false;
  captions.setEnabled($('#captionsOn').checked);
  renderWhisperNote();
  renderOutput();
}

/** The words over the video (C). */
async function setCaptions(on) {
  $('#captionsOn').checked = on;
  captions.setEnabled(on);
  captions.setTime(player.time);
  flash(on ? 'Words on the video' : 'Words on the video: off');
  S.info.settings = await api.saveAppSettings({ view: { ...S.info.settings.view, captions: on } });
}

// ---------------------------------------------------------------- opening
async function pickAndOpen() {
  const file = await api.pickVideo();
  if (file) openFile(file);
}

async function openFile(file) {
  if (!file || S.busyJob) return;
  save.flush();                        // the last change of the current recording is written first
  player.pause();
  if (S.fastJob) api.cancelJob(S.fastJob);   // that copy was for the recording being closed
  $('#busyTitle').textContent = 'Opening';
  $('#busyFile').textContent = basename(file);
  $('#busyStep').textContent = 'Starting';
  $('#busyPct').textContent = '';
  $('#busyBar').classList.add('indeterminate');
  $('#busyBar > i').style.width = '0';
  $('#busy').hidden = false;
  try {
    await api.openProject(file);       // the job's start/progress/done events drive the rest
  } catch (err) {
    $('#busy').hidden = true;
    toasts.error('Could not open the file', err.message);
  }
}

async function loadProject(snap) {
  S.project = snap;
  S.pieces = [];
  const levels = await api.levels(snap.id);
  timeline.setData({ duration: snap.info.duration, levels, shift: snap.analysis.shiftSeconds });
  player.load(snap.mediaUrl, snap.info.video?.fps || 30);
  if (snap.fastUrl) player.setFast(snap.fastUrl);
  setSpeed(1);
  $('#stageBadge').hidden = !snap.usingProxy;
  $('#stageMessage').hidden = true;
  history.reset({ edits: snap.edits, gainEdits: snap.gainEdits, splits: snap.splits });
  setWords(snap.hasTranscript ? await api.transcript(snap.id) : null);
  $('#welcome').hidden = true;
  $('#editor').hidden = false;
  document.body.classList.add('editing');
  $('#btnRender').disabled = false;
  $('#docName').textContent = snap.name;
  document.title = `${snap.name} · FlowCut`;
  renderOutput();
  if (!snap.hasTranscript && S.info.whisper.ok && S.info.settings.transcript.auto) startTranscribe();
  renderFillerStatus();
}

// ---------------------------------------------------------------- cuts
let computing = false;
let dirty = false;

async function recompute() {
  if (!S.project) return;
  if (computing) { dirty = true; return; }
  computing = true;
  try {
    do {
      dirty = false;
      const res = await api.compute(S.project.id, { edits: history.edits, gainEdits: history.gainEdits });
      S.cut = res;
      timeline.setSegments(res.segments);
      timeline.setGains(res.gains);
      player.setSegments(res.segments);
      player.setGains(res.gains);
      updatePieces();
      if (player.pass) player.setPass(player.cutRunAt(player.pass.start + 1e-3));   // kept now, or reshaped
      review.update(res.segments, res.gains);
      captions.setSegments(res.segments);
      buildPrefix();
      renderStats();
      renderFillerStatus();
      updateTimecodes(player.time);
    } while (dirty);
  } catch (err) {
    toasts.error('Could not compute the cuts', err.message);
  } finally {
    computing = false;
  }
}

const save = debounce(() => {
  if (S.project) api.saveProject(S.project.id, { edits: history.edits, gainEdits: history.gainEdits, splits: history.splits });
}, 400);

function onEditsChanged() {
  const n = history.count;
  $('#editsChip').textContent = n ? `${n} edit${n === 1 ? '' : 's'}` : 'no edits';
  $('#editsChip').className = `chip${n ? ' edit' : ''}`;
  $('#btnUndo').disabled = !history.canUndo;
  $('#btnRedo').disabled = !history.canRedo;
  updatePieces();                      // a split shows at once; cut / keep after the engine answers
  recompute();
  save();
}

/** The pieces the bar shows: the engine's segments, split again at your splits and at your edits' edges. */
function updatePieces() {
  S.pieces = buildPieces(S.cut?.segments, history.splits, history.edits);
  timeline.setPieces(S.pieces, history.splits);
}

function buildPrefix() {
  let acc = 0;
  S.prefix = S.cut.segments.map((s) => { const before = acc; if (s.keep) acc += s.end - s.start; return before; });
}

function renderStats() {
  const st = S.cut.stats;
  const pct = st.sourceSeconds ? Math.round((1 - st.outputSeconds / st.sourceSeconds) * 100) : 0;
  const parts = [`${st.silenceCuts} pause${st.silenceCuts === 1 ? '' : 's'}`];
  if (S.words) parts.push(`${st.fillerCuts} filler${st.fillerCuts === 1 ? '' : 's'}`);
  if (st.manualEdits) parts.push(`${st.manualEdits} yours`);
  $('#docStats').innerHTML = `${escapeHtml(fmtLength(st.sourceSeconds))} → <b>${escapeHtml(fmtLength(st.outputSeconds))}</b>`
    + ` · −${pct}% · ${parts.join(' · ')}`;
  $('#tcOutputTotal').textContent = fmtTime(st.outputSeconds);
  $('#tcDuration').textContent = fmtTime(st.sourceSeconds);
}

function outputTime(t) {
  const segs = S.cut?.segments;
  if (!segs?.length) return 0;
  const i = segmentIndexAt(segs, t);
  if (i < 0) return 0;
  return S.prefix[i] + (segs[i].keep ? Math.min(t, segs[i].end) - segs[i].start : 0);
}

function updateTimecodes(t) {
  $('#tcSource').textContent = fmtTime(t);
  $('#tcOutput').textContent = fmtTime(outputTime(t));
}

function jumpCut(dir) {
  const segs = S.cut?.segments;
  if (!segs) return;
  const t = player.time;
  const starts = segs.filter((s) => !s.keep).map((s) => s.start);
  const target = dir > 0
    ? starts.find((x) => x > t + 0.01) ?? S.project.info.duration
    : [...starts].reverse().find((x) => x < t - 0.05) ?? 0;
  player.pause();
  player.seek(target);
  timeline.reveal(target);
}

// ---------------------------------------------------------------- playback
/** 4x and 6x need the fast copy (the window decodes ~100 frames a second); it is made the first time they are used. */
function setSpeed(rate) {
  if (!S.project) return;
  player.setRate(rate);
  for (const b of $('#speeds').querySelectorAll('button')) b.classList.toggle('is-on', Number(b.dataset.rate) === rate);
  if (S.project.info.video && player.needsFast(rate) && !S.project.fastUrl) makeFast();
}

let flashTimer = 0;
function flash(text, ms = 1800) {
  const el = $('#stageHint');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(flashTimer);
  if (text && ms) flashTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** Hides the hint only if it still shows `text` (another message may have replaced it). */
function unflash(text) {
  const el = $('#stageHint');
  if (!el.hidden && el.textContent === text) el.hidden = true;
}

// ---------------------------------------------------------------- editing
// S splits the recording at the playhead into pieces, and every piece has a bar at the top of the
// timeline: click it to cut the piece or bring it back. O flips the piece under the playhead, K keeps it, Del cuts
// it, V makes it louder. Nothing is cut by S itself.

/** S: a split at the playhead. */
function splitHere() {
  if (!S.project) return;
  const t = player.time;
  if (onEdge(S.pieces, t)) { flash('Already split here'); return; }
  history.addSplit(t);
  flash(`Split at ${fmtTime(t)}: click the bar above a piece to cut it or bring it back`);
}

/** A click on a piece's bar: a kept piece is cut, a cut one comes back. */
function togglePiece(p) {
  history.addEdit({ start: p.start, end: p.end, op: p.keep ? 'cut' : 'keep' });
  flash(`${p.keep ? 'Cut' : 'Brought back'} ${(p.end - p.start).toFixed(2)} s`);
}

/** O and double-click: flip the piece at t. */
function flipAt(t) {
  const p = pieceAt(S.pieces, t);
  if (p) togglePiece(p);
}

/** K (keep = true) brings back the cut piece under the playhead; Del (keep = false) cuts the kept one. */
function setPieceHere(keep) {
  if (!S.project) return;
  const p = pieceAt(S.pieces, player.time);
  if (!p) return;
  if (p.keep === keep) { flash(keep ? 'This piece is kept already' : 'This piece is cut already'); return; }
  togglePiece(p);
}

/** V: +3 dB on the piece under the playhead (split with S first for a shorter part). Shift+V: removes the boost there. */
function louder(op) {
  if (!S.project) return;
  const t = player.time;
  let range = null;
  if (op === 'reset') {
    const g = S.cut?.gains.find((x) => t >= x.start && t < x.end);
    if (g) range = { start: g.start, end: g.end };
  } else {
    const p = pieceAt(S.pieces, t);
    if (p) range = { start: p.start, end: p.end };
  }
  if (!range || range.end - range.start < 0.05) {
    flash(op === 'reset' ? 'No louder part under the playhead.' : 'Nothing to make louder here.', 3000);
    return;
  }
  history.addGain(op === 'reset' ? { ...range, op: 'reset' } : { ...range, op: 'add', db: LOUDER_STEP_DB });
  flash(op === 'reset' ? 'Boost removed' : `This piece +${LOUDER_STEP_DB} dB (V again for more)`);
}

/** A review row: 1 s before it, and a cut there plays when you press Space (it is not jumped over). */
function pickItem(item) {
  player.pause();
  const run = item.kind === 'louder' ? null : player.cutRunAt((item.start + item.end) / 2);
  player.seek(Math.max(0, item.start - 1), run);
  timeline.reveal(item.start);
}

function itemAction(item) {
  if (item.kind === 'louder') history.addGain({ start: item.start, end: item.end, op: 'reset' });
  else history.addEdit({ start: item.start, end: item.end, op: 'keep' });
}

// ---------------------------------------------------------------- transcript and filler words
function renderWhisperNote() {
  const w = S.info.whisper;
  $('#btnTranscribe').disabled = !w.ok;
  $('#whisperNote').textContent = w.ok ? `faster-whisper ${w.version} on the ${w.gpu ? 'GPU' : 'CPU'}.` : w.reason;
}

function setWords(tr) {
  S.words = Array.isArray(tr) ? tr : tr?.words || null;
  timeline.setWords(S.words);
  captions.setWords(S.words);
  captions.setTime(player.time);
  renderFillerStatus();
}

function renderFillerStatus() {
  const chip = $('#transcriptChip');
  const status = $('#fillerStatus');
  const bar = $('#transcribeBar');
  const w = S.info?.whisper;
  bar.hidden = !S.transcribe;
  if (S.transcribe) {
    chip.textContent = `${Math.round(S.transcribe.progress * 100)}%`;
    chip.className = 'chip';
    status.textContent = S.transcribe.message || 'Transcribing';
    bar.querySelector('i').style.width = `${Math.round(S.transcribe.progress * 100)}%`;
    timeline.wordsHint = 'Transcribing: words and filler cuts appear here when ready';
    $('#btnTranscribe').innerHTML = 'Cancel';
    return;
  }
  $('#btnTranscribe').textContent = 'Transcribe again';
  if (!w?.ok) {
    chip.textContent = 'off';
    status.textContent = 'Whisper is not available, so filler words are not found.';
    timeline.wordsHint = 'No transcript: Whisper is not available';
    return;
  }
  if (!S.words) {
    chip.textContent = 'waiting';
    status.textContent = 'Starts automatically when a recording opens.';
    return;
  }
  const st = S.cut?.stats;
  chip.textContent = `${S.words.length} words`;
  chip.className = 'chip accent';
  const enabled = S.info.settings.fillers.enabled;
  status.textContent = !enabled ? 'Filler words are not cut (switched off).'
    : st ? `${st.fillerCuts} filler word${st.fillerCuts === 1 ? '' : 's'} cut${st.fillersFound > st.fillerCuts ? `, ${st.fillersFound - st.fillerCuts} kept by you` : ''}.` : '';
}

async function startTranscribe() {
  if (!S.project || S.transcribe) return;
  try {
    await api.transcribe(S.project.id, { language: $('#lang').value, vocabulary: $('#vocab').value.trim() });
  } catch (err) {
    toasts.error('Could not start Whisper', err.message);
  }
}

async function saveFillers(patch) {
  S.info.settings = await api.saveAppSettings({ fillers: { ...S.info.settings.fillers, ...patch } });
  recompute();
}

// ---------------------------------------------------------------- render, export, review copy
function renderOutput() {
  const r = S.info?.settings.render;
  if (!r) return;
  $('#outDir').textContent = r.outputDir || 'Next to the recording';
  $('#outDir').title = r.outputDir || '';
  $('#btnOutDirReset').hidden = !r.outputDir;
  $('#outName').textContent = S.project ? `${stem(S.project.path)}${r.suffix || '_flowcut'}.${r.format === 'mov' ? 'mov' : 'mp4'}` : '';
  const picture = r.quality === 'smaller'
    ? 'Picture: VMAF 98.9 vs the original (still very hard to tell apart), smaller file.'
    : 'Picture: visually lossless, VMAF 99.6 vs the original on your 4K footage.';
  $('#qualityNote').textContent = `${picture} Sound: ${r.format === 'mov' ? 'lossless 24-bit' : 'AAC 320 kbps'}.`;
}

async function saveRenderPrefs(patch) {
  S.info.settings = await api.saveAppSettings({ render: { ...S.info.settings.render, ...patch } });
  renderOutput();
}

async function chooseOutputDir() {
  const dir = await api.chooseFolder(S.info.settings.render.outputDir || (S.project ? dirname(S.project.path) : ''));
  if (dir) saveRenderPrefs({ outputDir: dir });
}

async function startRender() {
  if (!S.project) return;
  try {
    await api.render(S.project.id, {
      edits: history.edits,
      gainEdits: history.gainEdits,
      render: { format: $('#format').value, quality: $('#quality').value },
    });
  } catch (err) {
    toasts.error('Could not start the render', err.message);
  }
}


function onVideoError(err) {
  if (!S.project || S.project.usingProxy) return;
  $('#stageText').textContent = err?.code === 4
    ? "This file can't play in the editor window (codec or container)."
    : 'The video could not be loaded.';
  $('#stageMessage').hidden = false;
}

async function makeProxy() {
  if (!S.project || S.proxyJob || S.project.usingProxy) return;
  try {
    await api.makeProxy(S.project.id);
  } catch (err) {
    toasts.error('Could not make a review copy', err.message);
  }
}

async function makeFast() {
  if (!S.project || S.fastJob) return;
  try {
    await api.makeFast(S.project.id);
  } catch (err) {
    toasts.error('Could not make the fast copy', err.message);
  }
}

// ---------------------------------------------------------------- jobs
function onJob(m) {
  if (m.kind === 'analyze') return onAnalyzeJob(m);
  if (m.kind === 'transcribe') return onTranscribeJob(m);
  if (m.kind === 'render') return onRenderJob(m);
  if (m.kind === 'proxy') return onProxyJob(m);
  if (m.kind === 'fast') return onFastJob(m);
  return undefined;
}

function onAnalyzeJob(m) {
  if (m.type === 'start') { S.busyJob = m.id; return; }
  if (m.type === 'progress') {
    $('#busyStep').textContent = m.message || 'Working';
    if (m.progress > 0) {
      $('#busyBar').classList.remove('indeterminate');
      $('#busyBar > i').style.width = `${Math.round(m.progress * 100)}%`;
      $('#busyPct').textContent = `${Math.round(m.progress * 100)}%`;
    }
    return;
  }
  S.busyJob = null;
  $('#busy').hidden = true;
  if (m.type === 'done') loadProject(m.result).catch((err) => toasts.error('Could not show the recording', err.message));
  else if (m.type === 'error') toasts.error('Could not open the recording', m.error);
}

function onTranscribeJob(m) {
  if (m.type === 'start') { S.transcribe = { id: m.id, progress: 0, message: 'Starting Whisper' }; renderFillerStatus(); return; }
  if (m.type === 'progress') {
    S.transcribe.progress = m.progress;
    if (m.message) S.transcribe.message = m.message;
    renderFillerStatus();
    return;
  }
  S.transcribe = null;
  if (m.type === 'done') {
    api.transcript(S.project.id).then((words) => { setWords(words); recompute(); });
    toasts.success('Transcript ready', `${m.result.words} words (${m.result.model} on ${m.result.device === 'cuda' ? 'GPU' : 'CPU'}). Filler words are marked violet.`);
  } else if (m.type === 'error') {
    toasts.error('Transcription failed', m.error);
  }
  renderFillerStatus();
}

function onRenderJob(m) {
  let t = S.renderToasts.get(m.id);
  if (m.type === 'start') {
    t = toasts.show({
      title: 'Rendering', body: m.label, progress: true, closable: false,
      actions: [{ label: 'Cancel', onClick: () => api.cancelJob(m.id) }],
    });
    S.renderToasts.set(m.id, t);
    return;
  }
  if (!t) return;
  if (m.type === 'progress') {
    t.update({ progress: m.progress, body: `${m.label} · ${Math.round(m.progress * 100)}%${m.message ? ` · ${m.message}` : ''}` });
    return;
  }
  t.close();
  S.renderToasts.delete(m.id);
  if (m.type === 'done') {
    const r = m.result;
    const capped = (r.gains || []).filter((g) => g.limited);
    const note = capped.length ? ` · ${capped.length} louder moment${capped.length === 1 ? ' was' : 's were'} capped to avoid distortion` : '';
    toasts.success('Render finished', `${basename(r.outPath)} · ${fmtLength(r.seconds)} · ${r.pieces} pieces · ${r.encoder === 'nvenc' ? 'NVENC' : 'x264'}${note}`, [
      { label: 'Show in folder', onClick: (h) => { api.reveal(r.outPath); h.close(); } },
      { label: 'Play', primary: true, onClick: (h) => { api.openPath(r.outPath); h.close(); } },
    ]);
  } else if (m.type === 'error') {
    toasts.error('Render failed', m.error);
  }
}

function onProxyJob(m) {
  if (m.type === 'start') {
    S.proxyJob = m.id;
    $('#btnProxy').disabled = true;
    S.proxyToast = toasts.show({
      title: 'Making a review copy',
      body: 'Same size as the recording, in a format the editor window can play. Renders always use the original.',
      progress: true,
      actions: [{ label: 'Cancel', onClick: () => api.cancelJob(m.id) }],
    });
    return;
  }
  if (m.type === 'progress') { S.proxyToast?.update({ progress: m.progress }); return; }
  S.proxyJob = null;
  S.proxyToast?.close();
  $('#btnProxy').disabled = false;
  if (m.type === 'done') {
    if (S.project?.id !== m.result.projectId) return;
    S.project.usingProxy = true;
    $('#stageMessage').hidden = true;
    $('#stageBadge').hidden = false;
    player.swap(m.result.mediaUrl, S.project.info.video?.fps || 30);
  } else if (m.type === 'error') {
    toasts.error('Review copy failed', m.error);
  }
}

function onFastJob(m) {
  if (m.type === 'start') {
    S.fastJob = m.id;
    S.fastToast = toasts.show({
      title: 'Making the fast copy for 4× and 6×',
      body: 'The editor window decodes about 100 frames a second, so the original freezes at 4× and 6×. This copy has '
        + 'the same size and 10 frames a second; it is only on screen while playing fast. Until it is ready, 4× and 6× may stutter.',
      progress: true,
      actions: [{ label: 'Cancel', onClick: () => api.cancelJob(m.id) }],
    });
    return;
  }
  if (m.type === 'progress') { S.fastToast?.update({ progress: m.progress }); return; }
  S.fastJob = null;
  S.fastToast?.close();
  if (m.type === 'done') {
    if (S.project?.id !== m.result.projectId) return;        // made for a recording that is no longer open
    S.project.fastUrl = m.result.fastUrl;
    player.setFast(m.result.fastUrl);
  } else if (m.type === 'error') {
    toasts.error('Fast copy failed', m.error);
  }
}

function showHelp() { $('#help').hidden = false; }
