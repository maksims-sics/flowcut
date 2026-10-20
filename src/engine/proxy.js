'use strict';
// Copies of a recording for the editor window only, always at the recording's own size. Renders use the original.
// - review copy: for a file the window cannot play at all (MPEG-2, some MKVs); same frame rate.
// - fast copy: for smooth 4x and 6x. The window decodes about 100 frames a second whatever the size, so 6x of a
//   30 fps recording (180 a second) freezes for about 2 s every 18 s of video. This copy has 10 frames a second:
//   6x then needs 60, which is also all a 60 Hz screen shows. It is on screen only while playing fast.
const fs = require('node:fs');
const { run, hasEncoder, progressSeconds } = require('./tools');

const FAST_FPS = 10;
const H264_MAX = 4096;          // widest picture NVENC H.264 takes

async function encode(src, info, outPath, tools, video, { signal, onProgress } = {}) {
  // written under a temporary name: a cancelled copy never looks finished
  const tmp = outPath.replace(/\.mp4$/i, '.partial.mp4');
  // decoding on the CPU is faster here than -hwaccel (no copies back from the GPU): 24 min of 1440p AV1 in ~2 min
  await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-map', '0:v:0', '-map', '0:a:0?', ...video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp], {
    signal,
    onStdoutLine: (line) => {
      const s = progressSeconds(line);
      if (s !== null && info.duration > 0) onProgress?.(Math.min(1, s / info.duration));
    },
  });
  fs.renameSync(tmp, outPath);
  return outPath;
}

/** Same size and frame rate as the source; a keyframe every second so jumps (skipped cuts) stay quick. */
async function makeProxy(src, info, outPath, tools, opts) {
  const gop = ['-g', String(Math.max(1, Math.round(info.video?.fps || 30)))];
  const wide = (info.video?.width || 0) > H264_MAX ? ['-vf', `scale=${H264_MAX}:-2`] : [];
  const video = (await hasEncoder(tools.ffmpeg, 'h264_nvenc'))
    ? [...wide, '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', ...gop]
    : [...wide, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', ...gop];
  return encode(src, info, outPath, tools, video, opts);
}

/**
 * Same size, 10 frames a second, a keyframe every second. AV1 on the GPU when it can: on screen recordings CQ 40
 * looks the same as the original at 100 % and takes about 18 MB per minute of 1440p.
 */
async function makeFastCopy(src, info, outPath, tools, opts) {
  const gop = ['-g', String(FAST_FPS)];
  let video;
  if (await hasEncoder(tools.ffmpeg, 'av1_nvenc')) {
    video = ['-vf', `fps=${FAST_FPS}`, '-c:v', 'av1_nvenc', '-preset', 'p4', '-cq', '40', ...gop];
  } else {
    const vf = (info.video?.width || 0) > H264_MAX ? `fps=${FAST_FPS},scale=${H264_MAX}:-2` : `fps=${FAST_FPS}`;
    video = (await hasEncoder(tools.ffmpeg, 'h264_nvenc'))
      ? ['-vf', vf, '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '28', ...gop]
      : ['-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', ...gop];
  }
  return encode(src, info, outPath, tools, video, opts);
}

module.exports = { makeProxy, makeFastCopy, FAST_FPS };
