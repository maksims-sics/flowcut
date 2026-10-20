'use strict';
// Proves a FlowCut render keeps the quality: renders a recording exactly like the app (silence cuts, default
// settings), then compares every rendered frame with the same source frame and the sound with the source sound.
// usage: npm run quality -- "D:\path\recording.mp4" [--format mp4|mov] [--quality best|smaller] [--seconds 60]
//   picture: VMAF (4K model for 4K), PSNR, SSIM over all frames
//   sound:   signal-to-noise of the rendered sound vs the source over the kept parts (the 4 ms join fades excluded);
//            MOV (lossless) should be essentially identical, MP4 (AAC 320k) transparent
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findTools } = require('../src/engine/tools');
const { probe, isConstantFrameRate } = require('../src/engine/probe');
const { extractAnalysisAudio, computeLevels } = require('../src/engine/analyze');
const { DEFAULT_SETTINGS, computeCuts, frameRanges } = require('../src/engine/cuts');
const { render, sumExpr, JOIN_FADE } = require('../src/engine/render');

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };

function pcm(file, sr, ch, extraIn = []) {
  const r = spawnSync('ffmpeg', ['-v', 'error', ...extraIn, '-i', file, '-map', '0:a:0', '-ac', String(ch), '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 - 1 });
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
}

async function main() {
  const src = process.argv.slice(2).find((a) => !a.startsWith('--') && fs.existsSync(a));
  if (!src) { console.log('usage: npm run quality -- <recording> [--format mp4|mov] [--seconds 60]'); process.exit(2); }
  const format = flag('format', 'mp4');
  const quality = flag('quality', 'best');
  const tools = findTools();
  let info = await probe(src, tools);
  const work = fs.mkdtempSync(path.join(path.dirname(src), '.flowcut-quality-'));
  try {
    // analysis + cuts, like the app (no manual edits)
    const wav = path.join(work, 'a.wav');
    const audio = await extractAnalysisAudio(src, info, tools, wav);
    const lv = await computeLevels(wav, { emulateOffset: audio.emulateOffset });
    const settings = { ...DEFAULT_SETTINGS };
    const seconds = Number(flag('seconds', 0));
    let { segments } = computeCuts({ ...lv, shiftSeconds: audio.shiftSeconds }, info, settings, []);
    if (seconds) segments = segments.map((s) => (s.start >= seconds ? { ...s, keep: false } : s.end > seconds ? { ...s, end: seconds } : s));
    const t0 = Date.now();
    const out = await render(src, info, segments, { outPath: path.join(work, 'render'), format, quality }, tools, {});
    const renderSec = (Date.now() - t0) / 1000;
    const outInfo = await probe(out.outPath, tools);
    console.log(`rendered ${out.frames} frames (${out.seconds.toFixed(2)} s, ${out.pieces} pieces) in ${renderSec.toFixed(0)} s | `
      + `${(fs.statSync(out.outPath).size * 8 / out.seconds / 1e6).toFixed(0)} Mbps | ${outInfo.video.codec} ${outInfo.video.pixFmt} `
      + `${outInfo.video.colorPrimaries || '?'}/${outInfo.video.colorRange || '?'} | ${outInfo.audio[0].codec}`);

    // picture: the same frames out of the source, side by side with the render
    const ranges = frameRanges(segments, info.video.fps, info.video.nbFrames);
    const terms = ranges.map(([a, b]) => `between(n,${a},${b - 1})`);
    if (!isConstantFrameRate(info)) console.log('note: variable frame rate source, frame matching may be off');
    const script = path.join(work, 'metrics.txt');
    const model = info.video.height >= 2000 ? 'version=vmaf_4k_v0.6.1' : 'version=vmaf_v0.6.1';
    const log = path.join(work, 'vmaf.json').replace(/\\/g, '/').replace(':', '\\:');
    fs.writeFileSync(script, `[1:v]select='${sumExpr(terms)}',setpts=N/FRAME_RATE/TB,split=3[r1][r2][r3];`
      + `[0:v]setpts=N/FRAME_RATE/TB,split=3[d1][d2][d3];[d1][r1]libvmaf=model=${model}:n_threads=16:log_fmt=json:log_path='${log}';`
      + '[d2][r2]psnr;[d3][r3]ssim');
    const m = spawnSync('ffmpeg', ['-hide_banner', '-i', out.outPath, '-i', src, '-/filter_complex', script, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 2 ** 28 });
    const vm = JSON.parse(fs.readFileSync(path.join(work, 'vmaf.json'), 'utf8')).pooled_metrics.vmaf;
    const psnr = /PSNR .*average:([\d.inf]+)/.exec(m.stderr)?.[1];
    const ssim = /SSIM .*All:([\d.]+)/.exec(m.stderr)?.[1];
    console.log(`picture: VMAF mean ${vm.mean.toFixed(2)} (min ${vm.min.toFixed(2)}) | PSNR ${psnr} dB | SSIM ${ssim}  (100 / inf / 1 = identical)`);

    // sound: source samples of the kept ranges vs the render, fades at joins excluded
    const sr = info.audio[0].sampleRate;
    const ch = Math.min(2, info.audio[0].channels || 2);
    const ref = pcm(src, sr, ch, []);
    const got = pcm(out.outPath, sr, ch, []);
    const { fpsNum, fpsDen } = info.video;
    const fade = Math.round(JOIN_FADE * sr);
    let sig = 0;
    let err = 0;
    let pos = 0;
    let peakDiff = 0;
    for (const [a, b] of ranges) {
      const s0 = Math.round((a * sr * fpsDen) / fpsNum);
      const s1 = Math.round((b * sr * fpsDen) / fpsNum);
      for (let s = s0 + fade; s < s1 - fade; s++) {
        const o = pos + (s - s0);
        for (let c = 0; c < ch; c++) {
          const r = ref[s * ch + c];
          const g = got[o * ch + c];
          if (r === undefined || g === undefined) continue;
          sig += r * r;
          err += (g - r) * (g - r);
          peakDiff = Math.max(peakDiff, Math.abs(g - r));
        }
      }
      pos += s1 - s0;
    }
    const snr = err === 0 ? Infinity : 10 * Math.log10(sig / err);
    console.log(`sound: SNR ${snr === Infinity ? 'infinite (bit-identical)' : `${snr.toFixed(1)} dB`} | largest sample difference ${(20 * Math.log10(peakDiff || 1e-12)).toFixed(1)} dBFS`
      + `  (${format === 'mov' ? 'lossless PCM: expect > 90 dB' : 'AAC 320k: transparent is ~25 dB and up'})`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
