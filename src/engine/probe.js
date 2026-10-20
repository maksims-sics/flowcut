'use strict';
// Media facts the editor needs, read with ffprobe:
// duration = container duration, frame rate = r_frame_rate, channel count = the LAST audio stream's.
const fs = require('node:fs');
const { run } = require('./tools');

function num(v, fallback = null) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

async function probe(file, tools, { signal } = {}) {
  if (!tools.ffprobe) throw new Error('ffprobe not found. Install ffmpeg or set its path in Settings.');
  const { stdout } = await run(tools.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { capture: true, signal });
  const res = JSON.parse(stdout.toString());
  const stat = fs.statSync(file);
  const info = {
    path: file,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    duration: num(res.format?.duration, 0),
    formatName: res.format?.format_name || '',
    video: null,
    audio: [],
    channelCount: null,
  };
  for (const s of res.streams || []) {
    if (s.codec_type === 'video' && !info.video && s.codec_name !== 'mjpeg') {
      const [fpsNum, fpsDen] = String(s.r_frame_rate || '30/1').split('/').map(Number);
      const nb = Number.parseInt(s.nb_frames, 10);
      info.video = {
        index: s.index,
        codec: s.codec_name,
        width: s.width,
        height: s.height,
        fpsNum,
        fpsDen: fpsDen || 1,
        fps: fpsNum / (fpsDen || 1),
        avgFrameRate: s.avg_frame_rate || '',
        nbFrames: Number.isFinite(nb) ? nb : null,
        startTime: num(s.start_time, 0),
        pixFmt: s.pix_fmt,
        // copied into the render so colours look identical (OBS: bt709, limited range)
        colorPrimaries: s.color_primaries && s.color_primaries !== 'unknown' ? s.color_primaries : null,
        colorTransfer: s.color_transfer && s.color_transfer !== 'unknown' ? s.color_transfer : null,
        colorSpace: s.color_space && s.color_space !== 'unknown' ? s.color_space : null,
        colorRange: s.color_range && s.color_range !== 'unknown' ? s.color_range : null,
      };
    }
    if (s.codec_type === 'audio') {
      info.audio.push({
        index: s.index,
        codec: s.codec_name,
        channels: s.channels,
        sampleRate: Number.parseInt(s.sample_rate, 10) || 48000,
        duration: num(s.duration, -1),
        bitRate: num(s.bit_rate, null),
      });
      info.channelCount = s.channels;
    }
  }
  return info;
}

/** True when the frame count says constant frame rate (OBS files are, even if avg_frame_rate is an odd fraction). */
function isConstantFrameRate(info) {
  const v = info.video;
  if (!v) return false;
  if (v.nbFrames) return Math.abs(v.nbFrames - info.duration * v.fps) <= 2;
  const [n, d] = v.avgFrameRate.split('/').map(Number);
  return d > 0 && Math.abs(n / d - v.fps) / v.fps < 1e-3;
}

module.exports = { probe, isConstantFrameRate };
