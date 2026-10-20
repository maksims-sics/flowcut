'use strict';
// Analysis = the audio step (first audio track, mono, -async 1, -itsoffset start offset) + 40 ms loudness windows.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { run, progressSeconds, CancelledError } = require('./tools');

/** Audio track duration minus container duration, rounded to milliseconds. null when ffprobe has none. */
function startOffset(info, track = 0) {
  const a = info.audio[track];
  if (!a || !(a.duration > 0)) return null;
  return parseFloat(parseFloat(a.duration - info.duration).toFixed(3));
}

/** First aphasemeter reading below -0.005 = the stereo channels cancel; then the right one is inverted. */
async function audioOutOfPhase(src, track, ffmpeg, signal) {
  let first = null;
  try {
    await run(ffmpeg, ['-hide_banner', '-t', '10', '-i', src, '-filter_complex',
      `[0:a:${track}]aphasemeter=video=0,ametadata=print`, '-f', 'null', '-'], {
      signal,
      onStderrLine: (line) => {
        const m = first === null && /lavfi\.aphasemeter\.phase=(-?\d+\.\d+)/.exec(line);
        if (m) first = Number(m[1]);
      },
    });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
  }
  return first !== null && first < -0.005;
}

/**
 * Writes the analysis WAV (mono s16). An ffmpeg 5.0 build set as `analysisFfmpeg` trims the start itself for a
 * negative -itsoffset; newer ffmpeg does not, so with it the levels step imitates that trim instead.
 */
async function extractAnalysisAudio(src, info, tools, outWav, { signal, onProgress } = {}) {
  const exact = Boolean(tools.analysisFfmpeg);
  const ffmpeg = tools.analysisFfmpeg || tools.ffmpeg;
  if (!ffmpeg) throw new Error('ffmpeg not found. Install ffmpeg or set its path in Settings.');
  if (!info.audio.length) throw new Error('This file has no audio track, so there are no silences to find.');
  // MKV files carry no audio stream length: they are analysed without the start offset
  const offset = startOffset(info);
  const filters = [];
  let phaseFlipped = false;
  if (info.channelCount === 2) {
    phaseFlipped = await audioOutOfPhase(src, 0, ffmpeg, signal);
    if (phaseFlipped) filters.push('aeval=val(0)|-val(1),pan=mono|c0=c0+c1');
  }
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-async', '1'];
  if (exact && offset !== null) args.push('-itsoffset', `${offset}`);
  args.push('-i', src);
  if (filters.length) args.push('-filter:a', filters.join(','));
  args.push('-map', '0:a:0?', '-ac', '1', '-progress', 'pipe:1', '-nostats', outWav);
  await run(ffmpeg, args, {
    signal,
    onStdoutLine: (line) => {
      const s = progressSeconds(line);
      if (s !== null && onProgress && info.duration > 0) onProgress(Math.min(1, s / info.duration));
    },
  });
  return {
    exact,
    ffmpeg,
    offset: offset ?? 0,
    // analysis time = real time + offset, so the UI draws levels at (analysis time - offset)
    shiftSeconds: -(offset ?? 0),
    emulateOffset: exact ? 0 : (offset ?? 0),
    phaseFlipped,
  };
}

/** 40 ms window levels (dB) of the analysis WAV, computed in a worker thread. */
function computeLevels(wavPath, { emulateOffset = 0, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const worker = new Worker(path.join(__dirname, 'levels-worker.js'), { workerData: { wavPath, emulateOffset } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => { worker.terminate(); finish(reject, new CancelledError()); };
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', (m) => {
      if (m.type === 'progress') onProgress?.(m.value);
      else if (m.type === 'done') finish(resolve, m.result);
      else if (m.type === 'error') finish(reject, new Error(m.message));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => { if (code !== 0) finish(reject, new Error(`levels worker exited with ${code}`)); });
  });
}

module.exports = { extractAnalysisAudio, computeLevels, startOffset };
