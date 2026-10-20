'use strict';
// Word-level transcript with faster-whisper (python/transcribe_worker.py), on the GPU when CUDA works.
// Uses its own 16 kHz audio extraction WITHOUT the analysis audio's start shift, so word times are true video times.
const fs = require('node:fs');
const path = require('node:path');
const { run, progressSeconds } = require('./tools');

const WORKER = path.join(__dirname, '..', '..', 'python', 'transcribe_worker.py');

/** { ok, version, gpu, reason } - whether Python + faster-whisper are usable. */
async function whisperStatus(tools) {
  if (!tools.python) return { ok: false, reason: 'Python was not found on PATH.' };
  try {
    const { stdout } = await run(tools.python, ['-c',
      'import faster_whisper, ctranslate2; print(faster_whisper.__version__, ctranslate2.get_cuda_device_count())'],
    { capture: true });
    const [version, gpus] = stdout.toString().trim().split(/\s+/);
    return { ok: true, version, gpu: Number(gpus) > 0 };
  } catch {
    return { ok: false, reason: 'faster-whisper is not installed for this Python (pip install faster-whisper).' };
  }
}

/**
 * opts: { language: 'en'|'lv'|'ru'|'auto'..., vocabulary: 'names, products', model }
 * Writes and returns { words: [{w, s, e, p}], segments: [{s, e, text}], model, device, language }.
 */
async function transcribe(src, info, outJson, tools, opts = {}, { signal, onProgress, onStatus } = {}) {
  if (!tools.python) throw new Error('Python was not found, so Whisper cannot run.');
  const wav = outJson.replace(/\.json$/i, '.16k.wav');
  try {
    onStatus?.('Preparing audio');
    await run(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-map', '0:a:0', '-ac', '1',
      '-ar', '16000', '-progress', 'pipe:1', '-nostats', wav], {
      signal,
      onStdoutLine: (line) => {
        const s = progressSeconds(line);
        if (s !== null && info.duration > 0) onProgress?.(0.05 * Math.min(1, s / info.duration));
      },
    });
    const args = ['-u', WORKER, '--wav', wav, '--out', outJson, '--lang', opts.language || 'en'];
    if (opts.vocabulary) args.push('--vocab', opts.vocabulary);
    if (opts.model) args.push('--model', opts.model);
    let workerError = null;
    try {
      await run(tools.python, args, {
        signal,
        onStdoutLine: (line) => {
          let m;
          try { m = JSON.parse(line); } catch { return; }
          if (m.event === 'status') onStatus?.(m.message);
          if (m.event === 'error') workerError = m.message;
          if (m.event === 'progress' && info.duration > 0) onProgress?.(0.05 + 0.95 * Math.min(1, m.t / info.duration));
        },
      });
    } catch (err) {
      if (workerError) throw new Error(`Whisper failed: ${workerError}`);
      throw err;
    }
    return JSON.parse(fs.readFileSync(outJson, 'utf8'));
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

module.exports = { whisperStatus, transcribe };
