'use strict';
// One-encode renderer. Picture: ffmpeg `select` keeps exactly the frames of the kept pieces. Sound: decoded once and
// cut sample-exact on the same frame boundaries, so picture and sound never drift, however many cuts. Every join
// gets a 4 ms fade so cuts never click, and "louder" ranges are amplified here with a guard against clipping.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run, ffmpegMajor, hasEncoder, CancelledError, ToolError } = require('./tools');
const { frameRanges } = require('./cuts');
const { isConstantFrameRate } = require('./probe');

const JOIN_FADE = 0.004;   // s, at every cut
const GAIN_FADE = 0.02;    // s, at the edges of a louder range
const HEADROOM_DB = -0.3;  // a louder range never peaks above this
const FORMATS = {
  mp4: { ext: '.mp4', audio: ['-c:a', 'aac', '-b:a', '320k'], extra: ['-movflags', '+faststart'] },
  mov: { ext: '.mov', audio: ['-c:a', 'pcm_s24le'], extra: [] },
};

/** a+b+c... nested in parentheses: ffmpeg rejects a flat sum of more than 100 terms (groups of 20 tested to 6000). */
function sumExpr(terms, group = 20) {
  if (terms.length <= group) return terms.join('+');
  const parts = [];
  for (let i = 0; i < terms.length; i += group) parts.push(`(${sumExpr(terms.slice(i, i + group), group)})`);
  return sumExpr(parts, group);
}

/** "x.mp4" if free, else "x (2).mp4", "x (3).mp4"... never overwrites. */
function freePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function audioMix(info) {
  const n = info.audio.length;
  return n > 1 ? `${info.audio.map((_, i) => `[0:a:${i}]`).join('')}amix=inputs=${n},` : '[0:a:0]';
}

/** Loudest sample (dBFS) of the source audio between a and b seconds, for the louder-range guard. */
async function peakDb(src, info, a, b, ffmpeg, signal) {
  let max = null;
  await run(ffmpeg, ['-hide_banner', '-ss', a.toFixed(3), '-t', Math.max(0.05, b - a).toFixed(3), '-i', src,
    '-filter_complex', `${audioMix(info)}volumedetect[a]`, '-map', '[a]', '-f', 'null', '-'], {
    signal,
    onStderrLine: (line) => { const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(line); if (m) max = m[1] === '-inf' ? -Infinity : Number(m[1]); },
  });
  return max ?? 0;
}

/** Louder ranges with the gain each may really get (never pushes a peak above HEADROOM_DB). */
async function guardGains(src, info, gains, ffmpeg, signal) {
  const out = [];
  for (const g of gains || []) {
    const peak = await peakDb(src, info, g.start, g.end, ffmpeg, signal);
    const db = Math.max(0, Math.min(g.db, HEADROOM_DB - peak));
    out.push({ ...g, requestedDb: g.db, db, limited: db < g.db - 0.05 });
  }
  return out;
}

/**
 * Decodes the audio (every track mixed; start fixed like -async 1), keeps only the frame ranges,
 * fades every join, amplifies louder ranges, and writes raw float32. Streams: no full-length temp file.
 */
function cutAudio(src, info, ranges, outFile, ffmpeg, { gains = [], signal, onProgress } = {}) {
  const a0 = info.audio[0];
  const sr = a0.sampleRate;
  const ch = (a0.channels || 2) >= 2 ? 2 : 1;
  const bpf = 4 * ch;                                   // bytes per sample frame
  const { fpsNum, fpsDen } = info.video;
  const toSample = (frame) => Math.round((frame * sr * fpsDen) / fpsNum);
  const sRanges = ranges.map(([a, b]) => [toSample(a), toSample(b)]);
  const totalSamples = Math.round(info.duration * sr);
  const joinFade = Math.max(1, Math.round(JOIN_FADE * sr));
  const gainFade = Math.max(1, Math.round(GAIN_FADE * sr));
  const gainRanges = gains.filter((g) => g.db > 0).map((g) => ({
    a: Math.round(g.start * sr), b: Math.round(g.end * sr), k: 10 ** (g.db / 20),
  }));

  // gain at source sample s: louder ranges ramp in and out over GAIN_FADE
  const gainAt = (s) => {
    for (const g of gainRanges) {
      if (s < g.a || s >= g.b) continue;
      const ramp = Math.min(1, (s - g.a + 0.5) / gainFade, (g.b - s - 0.5) / gainFade);
      return 1 + (g.k - 1) * Math.max(0, ramp);
    }
    return 1;
  };
  const touchesGain = (a, b) => gainRanges.some((g) => g.a < b && g.b > a);

  const args = ['-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex',
    `${audioMix(info)}aresample=async=1:min_hard_comp=0.100000:first_pts=0[a]`, '-map', '[a]',
    '-ac', String(ch), '-ar', String(sr), '-f', 'f32le', 'pipe:1'];

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const out = fs.createWriteStream(outFile);
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let carry = Buffer.alloc(0);
    let pos = 0;                                          // source sample frame of the next decoded frame
    let ri = 0;
    let stderrTail = '';

    const emit = (frames, from, r) => {
      // frames: Float32Array of whole sample frames starting at source frame `from`; keep the part inside range r
      const [s0, s1] = sRanges[r];
      const a = Math.max(s0, from);
      const b = Math.min(s1, from + frames.length / ch);
      if (b <= a) return true;
      const piece = frames.slice((a - from) * ch, (b - from) * ch);
      const fadeIn = s0 > 0;
      const fadeOut = s1 < totalSamples;
      const needsWork = (fadeIn && a - s0 < joinFade) || (fadeOut && s1 - b < joinFade) || touchesGain(a, b);
      if (needsWork) {
        for (let s = a; s < b; s++) {
          let k = gainAt(s);
          if (fadeIn && s - s0 < joinFade) k *= (s - s0 + 0.5) / joinFade;
          if (fadeOut && s1 - s <= joinFade) k *= (s1 - s - 0.5) / joinFade;
          if (k === 1) continue;
          const o = (s - a) * ch;
          for (let c = 0; c < ch; c++) piece[o + c] *= k;
        }
      }
      return out.write(Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength));
    };

    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % bpf);
      carry = Buffer.from(buf.subarray(whole));
      if (!whole) return;
      const frames = new Float32Array(whole / 4);
      Buffer.from(frames.buffer).set(buf.subarray(0, whole));
      const count = whole / bpf;
      while (ri < sRanges.length && sRanges[ri][1] <= pos) ri++;
      let ok = true;
      for (let r = ri; r < sRanges.length && sRanges[r][0] < pos + count; r++) ok = emit(frames, pos, r) && ok;
      pos += count;
      if (!ok) { child.stdout.pause(); out.once('drain', () => child.stdout.resume()); }
      if (onProgress && totalSamples > 0) onProgress(Math.min(1, pos / totalSamples));
    });
    const kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) { out.destroy(); return reject(new CancelledError()); }
      if (code !== 0) { out.destroy(); return reject(new ToolError(ffmpeg, code, stderrTail)); }
      // audio shorter than the picture: pad the end of the kept ranges with silence
      for (const [a, b] of sRanges) {
        const from = Math.max(a, pos);
        if (b > from) out.write(Buffer.alloc((b - from) * bpf));
      }
      out.end(() => resolve({ sampleRate: sr, channels: ch }));
    });
  });
}

/**
 * Video encoder arguments, colour tags copied from the source.
 * Measured on 4K AV1 OBS footage against the original:
 *   best     NVENC constant QP 12      VMAF 99.6 (min 98.5), PSNR 50.2 dB, ~190 Mbps, 2.2x realtime
 *            (x264 CRF 12 slow, the CPU reference: VMAF 99.5, PSNR 50.5 dB, 0.16x realtime)
 *   smaller  NVENC CQ 15, ceiling lifted VMAF 98.9 (min 97.1), PSNR 48.0 dB, ~130 Mbps
 * Without -maxrate NVENC silently capped VBR at ~123 Mbps, so lower CQ values changed nothing.
 */
function videoArgs(encoder, info, quality = 'best') {
  const v = info.video;
  const tenBit = /10|12/.test(v.pixFmt || '');
  const color = [];
  if (v.colorPrimaries) color.push('-color_primaries', v.colorPrimaries);
  if (v.colorTransfer) color.push('-color_trc', v.colorTransfer);
  if (v.colorSpace) color.push('-colorspace', v.colorSpace);
  if (v.colorRange) color.push('-color_range', v.colorRange);
  const best = quality !== 'smaller';
  const lift = ['-maxrate', '300M', '-bufsize', '600M'];
  if (tenBit) {
    // 10-bit sources keep their depth: H.264 hardware has no 10-bit, HEVC does
    return encoder === 'x264'
      ? ['-c:v', 'libx265', '-crf', best ? '12' : '16', '-preset', 'medium', '-pix_fmt', 'yuv420p10le', ...color]
      : ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-tune', 'hq', ...(best ? ['-rc', 'constqp', '-qp', '12'] : ['-rc', 'vbr', '-cq', '15', '-b:v', '0', ...lift]),
        '-profile:v', 'main10', '-pix_fmt', 'p010le', ...color];
  }
  return encoder === 'x264'
    ? ['-c:v', 'libx264', '-crf', best ? '12' : '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...color]
    : ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', ...(best ? ['-rc', 'constqp', '-qp', '12'] : ['-rc', 'vbr', '-cq', '15', '-b:v', '0', ...lift]),
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...color];
}

/**
 * Renders the kept segments of `src` to a new file.
 * opts: { outPath (the extension follows `format`), format: 'mp4'|'mov', encoder: 'auto'|'nvenc'|'x264',
 *         quality: 'best'|'smaller', gains: [{start, end, db}], segmentsMap: bool, level }
 * Returns { outPath, frames, seconds, pieces, encoder, gains }.
 */
async function render(src, info, segments, opts, tools, { signal, onProgress, onStatus } = {}) {
  if (!info.video) throw new Error('This file has no video stream. Rendering audio-only files is not supported yet.');
  if (!tools.ffmpeg) throw new Error('ffmpeg not found.');
  const { fps, fpsNum, fpsDen, nbFrames } = info.video;
  const ranges = frameRanges(segments, fps, nbFrames);
  if (!ranges.length) throw new Error('Nothing is kept: every part of the recording is cut.');
  const totalFrames = ranges.reduce((t, [a, b]) => t + b - a, 0);
  const format = FORMATS[opts.format] || FORMATS.mp4;

  const outPath = freePath(opts.outPath.replace(/\.[^.\\/]+$/, '') + format.ext);
  const partial = outPath.replace(/(\.[^.\\/]+)$/, '.partial$1');
  const work = fs.mkdtempSync(path.join(path.dirname(outPath), '.flowcut-render-'));
  const audioFile = path.join(work, 'audio.f32');
  const vfFile = path.join(work, 'select.txt');
  try {
    let gains = [];
    if (opts.gains?.length) {
      onStatus?.('Checking the louder moments');
      gains = await guardGains(src, info, opts.gains, tools.ffmpeg, signal);
    }
    onStatus?.('Cutting the audio');
    const { sampleRate, channels } = await cutAudio(src, info, ranges, audioFile, tools.ffmpeg, {
      gains, signal, onProgress: (p) => onProgress?.(p * 0.05),
    });

    const terms = isConstantFrameRate(info)
      ? ranges.map(([a, b]) => `between(n,${a},${b - 1})`)
      : ranges.map(([a, b]) => `between(t,${(info.video.startTime + (a - 0.5) / fps).toFixed(6)},${(info.video.startTime + (b - 0.5) / fps).toFixed(6)})`);
    fs.writeFileSync(vfFile, `select='${sumExpr(terms)}',setpts=N/FRAME_RATE/TB`, 'utf8');
    const vfArgs = (await ffmpegMajor(tools.ffmpeg)) >= 7 ? ['-/filter:v', vfFile] : ['-filter_script:v', vfFile];

    let encoder = opts.encoder || 'auto';
    if (encoder === 'auto') encoder = (await hasEncoder(tools.ffmpeg, 'h264_nvenc')) ? 'nvenc' : 'x264';
    const encode = (enc) => run(tools.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
      '-f', 'f32le', '-ar', String(sampleRate), '-ac', String(channels), '-i', audioFile,
      ...vfArgs, '-map', '0:v:0', '-map', '1:a:0', ...videoArgs(enc, info, opts.quality),
      '-r', `${fpsNum}/${fpsDen}`, ...format.audio, ...format.extra, '-progress', 'pipe:1', '-nostats', partial,
    ], {
      signal,
      onStdoutLine: (line) => {
        const m = /^frame=(\d+)/.exec(line);
        if (m) onProgress?.(0.05 + 0.95 * Math.min(1, Number(m[1]) / totalFrames));
      },
    });
    onStatus?.(`Encoding ${totalFrames} frames (${encoder === 'nvenc' ? 'NVENC' : 'x264'})`);
    try {
      await encode(encoder);
    } catch (err) {
      const gpuProblem = err instanceof ToolError && /nvenc|cuda|no capable devices|OpenEncodeSession/i.test(err.stderrTail || '');
      if (encoder !== 'nvenc' || !gpuProblem) throw err;
      encoder = 'x264';
      onStatus?.(`NVENC unavailable, encoding ${totalFrames} frames with x264`);
      await encode(encoder);
    }
    fs.renameSync(partial, outPath);

    if (opts.segmentsMap) {
      let at = 0;
      const map = ranges.map(([a, b]) => {
        const item = { raw_start: a / fps, raw_end: b / fps, cut_start: at / fps, cut_end: (at + b - a) / fps, raw_frames: [a, b] };
        at += b - a;
        return item;
      });
      fs.writeFileSync(outPath.replace(/\.[^.\\/]+$/, '.segments.json'),
        JSON.stringify({ source: src, fps, level_db: opts.level, segments: map }, null, 1), 'utf8');
    }
    return { outPath, frames: totalFrames, seconds: totalFrames / fps, pieces: ranges.length, encoder, gains };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { render, sumExpr, freePath, videoArgs, cutAudio, FORMATS, JOIN_FADE };
