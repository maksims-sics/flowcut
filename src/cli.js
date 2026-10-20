'use strict';
// FlowCut without the window, for scripts and automation.
// usage: npm run cut -- "C:\Videos\recording.mp4" [--render] [--json] [--level -45] [--out file.mp4]
//                       [--encoder auto|nvenc|x264] [--quality best|smaller] [--force]
// Detection uses FlowCut's built-in values (--level sets a fixed silence level instead of the automatic one).
const fs = require('node:fs');
const path = require('node:path');
const { findTools } = require('./engine/tools');
const { probe } = require('./engine/probe');
const { extractAnalysisAudio, computeLevels } = require('./engine/analyze');
const { DEFAULT_SETTINGS, computeCuts } = require('./engine/cuts');
const { render } = require('./engine/render');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function savedAppSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'FlowCut', 'settings.json'), 'utf8'));
  } catch {
    return null;
  }
}

const progressLine = (label) => (p) => process.stdout.write(`\r${label} ${Math.round(p * 100)}%   `);

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--') && fs.existsSync(a));
  if (!file) {
    console.log('usage: npm run cut -- <video> [--render] [--json] [--level -45] [--out file.mp4]');
    process.exit(2);
  }
  const saved = savedAppSettings();
  const settings = { ...DEFAULT_SETTINGS };
  if (flag('level')) Object.assign(settings, { autoLevel: false, levelDb: Number(flag('level')) });
  const tools = findTools(saved?.tools || {});

  const info = await probe(file, tools);
  const tmp = fs.mkdtempSync(path.join(path.dirname(file), '.flowcut-cli-'));
  let analysis;
  try {
    const wav = path.join(tmp, 'analysis.wav');
    const audio = await extractAnalysisAudio(file, info, tools, wav, { onProgress: progressLine('analysing audio') });
    const lv = await computeLevels(wav, { emulateOffset: audio.emulateOffset });
    analysis = { ...lv, shiftSeconds: audio.shiftSeconds };
    process.stdout.write('\r');
    console.log(`analysis: ${audio.exact ? 'analysis ffmpeg (start trimmed by ffmpeg)' : 'ffmpeg (start trim imitated)'}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const res = computeCuts(analysis, info, settings, []);
  const kept = res.segments.filter((s) => s.keep).length;
  console.log(`${path.basename(file)}: level ${res.level} dB${settings.autoLevel ? ' (auto)' : ''} | ${kept} kept pieces, `
    + `${res.stats.cuts} cuts | ${res.stats.sourceSeconds.toFixed(2)} s -> ${res.stats.outputSeconds.toFixed(3)} s`);

  if (process.argv.includes('--json')) {
    const out = `${file}.cuts.json`;
    if (fs.existsSync(out) && !process.argv.includes('--force')) throw new Error(`exists, not overwriting: ${out}`);
    fs.writeFileSync(out, JSON.stringify(res.segments.map(({ start, end, keep }) => ({ start, end, keep })), null, 1));
    console.log(`cut list -> ${out}`);
  }
  if (process.argv.includes('--render')) {
    const r = saved?.render || {};
    const outPath = flag('out') || path.join(path.dirname(file), `${path.parse(file).name}${r.suffix || '_flowcut'}.mp4`);
    const t0 = Date.now();
    const result = await render(file, info, res.segments,
      { outPath, encoder: flag('encoder', r.encoder || 'auto'), quality: flag('quality', r.quality || 'best'), level: res.level },
      tools, { onProgress: progressLine('rendering'), onStatus: (s) => process.stdout.write(`\r${s}\n`) });
    process.stdout.write('\r');
    console.log(`rendered ${result.frames} frames (${result.seconds.toFixed(3)} s, ${result.pieces} pieces, ${result.encoder}) `
      + `in ${Math.round((Date.now() - t0) / 1000)} s -> ${result.outPath}`);
  }
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
