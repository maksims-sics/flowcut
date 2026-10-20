'use strict';
// Worker thread: analysis WAV (mono s16) -> loudness of every 40 ms window in dB.
// Exact arithmetic (cut positions depend on it): samples become float32 the way Chromium's decodeAudioData converts s16
// (negatives * 1/32768, positives * 1/32767, in float), squares are summed left to right in float64, and
// level = 20 * log10(sqrt(sum / samplesPerWindow)). A partial last window is still divided by the full size.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

const SEGMENT = 0.04;
const NEG = Math.fround(1 / 32768);
const POS = Math.fround(1 / 32767);

function wavLayout(fd) {
  const head = Buffer.alloc(65536);
  const got = fs.readSync(fd, head, 0, head.length, 0);
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt = null;
  while (off + 8 <= got) {
    const id = head.toString('ascii', off, off + 4);
    const size = head.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: head.readUInt16LE(off + 10), sampleRate: head.readUInt32LE(off + 12), bits: head.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      const total = fs.fstatSync(fd).size;
      const bytes = size === 0 || size === 0xffffffff ? total - (off + 8) : Math.min(size, total - (off + 8));
      return { ...fmt, dataOffset: off + 8, dataBytes: bytes };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV without a data chunk');
}

function main() {
  const { wavPath, emulateOffset } = workerData;
  const fd = fs.openSync(wavPath, 'r');
  try {
    const { channels, sampleRate, bits, dataOffset, dataBytes } = wavLayout(fd);
    if (channels !== 1 || bits !== 16) throw new Error(`expected mono 16-bit WAV, got ${channels} ch ${bits} bit`);
    const sis = SEGMENT * sampleRate;
    if (!Number.isInteger(sis)) throw new Error(`sample rate ${sampleRate} gives a fractional 40 ms window`);
    // imitate ffmpeg 5.0.1's start trim (negative offset) or start padding (positive) when it was not used
    const skip = emulateOffset < 0 ? Math.round(-emulateOffset * sampleRate) : 0;
    const pad = emulateOffset > 0 ? Math.round(emulateOffset * sampleRate) : 0;
    const fileSamples = Math.floor(dataBytes / 2);
    const total = Math.max(0, fileSamples - skip) + pad;
    const windows = Math.ceil(total / sis);
    const nFull = Math.floor(total / sis);
    const sums = new Float64Array(windows);

    let pos = pad;                       // output sample index of the next real sample
    let fileIndex = skip;                // input sample index
    const block = Buffer.alloc(1 << 22); // 2M samples per read
    let lastReport = 0;
    while (fileIndex < fileSamples) {
      const want = Math.min(block.length, (fileSamples - fileIndex) * 2);
      const got = fs.readSync(fd, block, 0, want, dataOffset + fileIndex * 2);
      if (got <= 0) break;
      const n = got >> 1;
      const samples = new Int16Array(block.buffer, block.byteOffset, n);
      let w = Math.floor(pos / sis);
      let edge = (w + 1) * sis;
      let sum = sums[w] || 0;
      for (let i = 0; i < n; i++, pos++) {
        if (pos === edge) {
          sums[w] = sum;
          w++;
          edge += sis;
          sum = sums[w];
        }
        const v = samples[i];
        const f = v < 0 ? Math.fround(v * NEG) : Math.fround(v * POS);
        sum += f * f;
      }
      sums[w] = sum;
      fileIndex += n;
      const p = fileIndex / fileSamples;
      if (p - lastReport > 0.02) { parentPort.postMessage({ type: 'progress', value: p }); lastReport = p; }
    }

    const db = new Float64Array(windows);
    for (let w = 0; w < windows; w++) db[w] = 20 * Math.log10(Math.sqrt(sums[w] / sis));
    parentPort.postMessage({
      type: 'done',
      result: { sampleRate, samplesPerWindow: sis, samples: total, windows, nFull, db },
    }, [db.buffer]);
  } finally {
    fs.closeSync(fd);
  }
}

try {
  main();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err.message });
}
