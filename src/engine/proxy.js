'use strict';
// Copies of a recording for the editor window only, always at the recording's own size. Renders use the original.
// - review copy: for a file the window cannot play at all (MPEG-2, some MKVs); same frame rate.
// - fast copies: for smooth 4x and 6x. The window decodes about 100 frames a second whatever the size, so 6x of a
//   30 fps recording (180 a second) freezes for about 2 s every 18 s of video. Each fast speed gets a copy whose frames
//   a second times the speed make 60, one new frame per refresh of a 60 Hz screen: 15 frames a second for 4x, 10 for
//   6x. (A frame rate that does not fit judders: 10 frames a second at 4x, 40 a second, came out as about 20 on screen,
//   and 15 at 6x, 90 a second, fell to 30 after a while.) Both are made in one pass, in the background, as soon as a
//   recording opens, and are on screen only while playing fast.
const fs = require('node:fs');
const { run, hasEncoder, progressSeconds } = require('./tools');

const FAST_COPIES = [{ rate: 4, fps: 15 }, { rate: 6, fps: 10 }];
const H264_MAX = 4096;          // widest picture NVENC H.264 takes

/**
 * One ffmpeg pass writing every output ([{ path, map, video }]). Each is written under a temporary name, so a cancelled
 * copy never looks finished. Decoding runs on the CPU: faster here than -hwaccel (no copies back from the GPU).
 */
async function encode(src, info, outputs, tools, { filter, signal, onProgress, lowPriority = false } = {}) {
  const tmp = outputs.map((o) => o.path.replace(/\.mp4$/i, '.partial.mp4'));
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  if (filter) args.push('-filter_complex', filter);
  outputs.forEach((o, k) => {
    args.push('-map', o.map, '-map', '0:a:0?', ...o.video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', tmp[k]);
  });
  args.push('-progress', 'pipe:1', '-nostats');
  await run(tools.ffmpeg, args, {
    signal,
    lowPriority,
    onStdoutLine: (line) => {
      const s = progressSeconds(line);
      if (s !== null && info.duration > 0) onProgress?.(Math.min(1, s / info.duration));
    },
  });
  outputs.forEach((o, k) => fs.renameSync(tmp[k], o.path));
  return outputs.map((o) => o.path);
}

/** Same size and frame rate as the source; a keyframe every second so jumps (skipped cuts) stay quick. */
async function makeProxy(src, info, outPath, tools, opts) {
  const gop = ['-g', String(Math.max(1, Math.round(info.video?.fps || 30)))];
  const wide = (info.video?.width || 0) > H264_MAX ? ['-vf', `scale=${H264_MAX}:-2`] : [];
  const video = (await hasEncoder(tools.ffmpeg, 'h264_nvenc'))
    ? [...wide, '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', ...gop]
    : [...wide, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...gop];
  const [file] = await encode(src, info, [{ path: outPath, map: '0:v:0', video }], tools, opts);
  return file;
}

/**
 * The fast copies (`outs` = [{ fps, path }]): same size, a keyframe every second. AV1 on the GPU when it can: CQ 40 on
 * screen recordings looks the same as the original at 100 %, and the fastest preset makes both copies in the time one
 * took at the default with no visible loss (PSNR 44.1 vs 44.3 dB); about 20 + 18 MB per minute of 3840x1440.
 * Runs at low priority.
 */
async function makeFastCopies(src, info, outs, tools, opts = {}) {
  const av1 = await hasEncoder(tools.ffmpeg, 'av1_nvenc');
  const nvenc = !av1 && (await hasEncoder(tools.ffmpeg, 'h264_nvenc'));
  const scale = !av1 && (info.video?.width || 0) > H264_MAX ? `,scale=${H264_MAX}:-2` : '';
  const filter = `[0:v:0]split=${outs.length}${outs.map((_, k) => `[s${k}]`).join('')};`
    + outs.map((o, k) => `[s${k}]fps=${o.fps}${scale}[o${k}]`).join(';');
  const outputs = outs.map((o, k) => {
    const gop = ['-g', String(o.fps)];
    const video = av1 ? ['-c:v', 'av1_nvenc', '-preset', 'p1', '-cq', '40', ...gop]
      : nvenc ? ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '28', ...gop]
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', ...gop];
    return { path: o.path, map: `[o${k}]`, video };
  });
  return encode(src, info, outputs, tools, { ...opts, filter, lowPriority: true });
}

module.exports = { makeProxy, makeFastCopies, FAST_COPIES };
