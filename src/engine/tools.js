'use strict';
// Finding and running the external tools (ffmpeg, ffprobe, python).
// Plain Node, no Electron imports: the engine also runs from tests and the command line.
const { spawn } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

class ToolError extends Error {
  constructor(tool, code, stderrTail) {
    super(`${path.basename(tool)} exited with code ${code}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
    this.name = 'ToolError';
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

function which(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Tool paths. `custom` (from settings) wins over PATH. */
function findTools(custom = {}) {
  return {
    ffmpeg: custom.ffmpeg || which('ffmpeg'),
    ffprobe: custom.ffprobe || which('ffprobe'),
    // Optional ffmpeg used only for the analysis audio. An ffmpeg 5.0 build trims the start itself for a negative
    // -itsoffset; with newer builds (the default) the levels step imitates that trim, near-identical to the bit.
    analysisFfmpeg: custom.analysisFfmpeg || null,
    python: custom.python || which('python') || which('py'),
  };
}

/** Calls cb for every complete line written to a stream (\n, \r\n or \r). */
function eachLine(stream, cb) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let m;
    while ((m = /\r\n|\n|\r/.exec(buf))) {
      cb(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
    }
  });
  stream.on('end', () => { if (buf) cb(buf); });
}

/**
 * Runs a tool. Resolves with { stdout, stderrTail } (stdout only when capture is on),
 * rejects with ToolError or CancelledError (when `signal` aborts, the process is killed).
 */
function run(exe, args, { signal, onStdoutLine, onStderrLine, capture = false, cwd, lowPriority = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(exe, args, { cwd, windowsHide: true });
    // background work (the fast copy) yields the CPU to playback in the window
    if (lowPriority && child.pid) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: normal */ } }
    const out = [];
    let stderrTail = '';
    if (capture) child.stdout.on('data', (d) => out.push(d));
    else if (onStdoutLine) eachLine(child.stdout, onStdoutLine);
    else child.stdout.resume();
    eachLine(child.stderr, (line) => {
      stderrTail = (stderrTail + line + '\n').slice(-4000);
      if (onStderrLine) onStderrLine(line);
    });
    const kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => { signal?.removeEventListener('abort', kill); reject(err); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (signal?.aborted) return reject(new CancelledError());
      if (code !== 0) return reject(new ToolError(exe, code, stderrTail));
      resolve({ stdout: capture ? Buffer.concat(out) : null, stderrTail });
    });
  });
}

/** ffmpeg `-progress pipe:1` output -> seconds done. */
function progressSeconds(line) {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
  return m ? Number(m[1]) / 1e6 : null;
}

const cache = new Map();
async function ffmpegMajor(exe) {
  const key = `major:${exe}`;
  if (!cache.has(key)) {
    const { stdout } = await run(exe, ['-hide_banner', '-version'], { capture: true });
    const m = /ffmpeg version (\d+)/.exec(stdout.toString());
    cache.set(key, m ? Number(m[1]) : 0);
  }
  return cache.get(key);
}

async function encoders(exe) {
  const key = `enc:${exe}`;
  if (!cache.has(key)) {
    const { stdout } = await run(exe, ['-hide_banner', '-encoders'], { capture: true });
    cache.set(key, stdout.toString());
  }
  return cache.get(key);
}

async function hasEncoder(exe, name) {
  return new RegExp(`\\s${name}\\s`).test(await encoders(exe));
}

/** Number -> text the way a JavaScript template literal prints it (the ffmpeg args are built that way). */
function jsNumber(x) {
  return `${x}`;
}

module.exports = {
  CancelledError, ToolError, which, findTools, run, eachLine, progressSeconds, ffmpegMajor, hasEncoder, jsNumber,
};
