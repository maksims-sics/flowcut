'use strict';
// Playback smoothness check: opens a real recording in the real app (throwaway profile) and plays it at each speed with
// "Preview result" on, measuring what reaches the screen: frames shown per second, gaps between frames (a stall = no
// new frame for 150 ms or more), how fast the recording really advanced, every jump over a cut (switched to a waiting
// element, waited for one, or seeked) and the timeline's drawing time. Nothing is edited or rendered.
// usage: npm run smooth -- --file "D:\path\recording.mp4" [options]
//   --rates 1,2,4,6   speeds to play          --seconds 20   how long each speed plays    --at 60   start (s)
//   --span 30         seconds of timeline in view (default: as opened, the whole recording)
//   --wait-fast       wait for the fast copy before measuring (made in the background when the recording opens)
//   --project DIR     copy an existing project folder (%APPDATA%\FlowCut\projects\<id>) in: no new analysis, its
//                     transcript and fast copy come along
//   --no-captions     words on the video off          --no-words-lane   timeline words lane not drawn
//   --verbose         every jump                     --keep            keep the test profile (test/artifacts/smooth-profile)
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'artifacts');
const PROFILE = path.join(OUT, 'smooth-profile');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const FILE = arg('file');
const SECONDS = Number(arg('seconds', 20));
const RATES = arg('rates', '1,2,4,6').split(',').map(Number);
const AT = Number(arg('at', 60));
const PROJECT = arg('project');
const SPAN = Number(arg('span', 0));
const CODECS = { h264: 'avc1.640033', hevc: 'hvc1.1.6.L153.B0', av1: 'av01.0.12M.08', vp9: 'vp09.00.51.08' };

/** Installed in the page: records every frame each <video> puts on screen, seeks, jumps and the timeline's drawing. */
function installProbe() {
  const P = { frames: [], seeks: [], draw: [], jumps: [], raf: [] };
  window.__probe = P;
  const tick = (now) => { if (P.on) P.raf.push(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const hook = (el) => {
    if (el.__probed) return;
    el.__probed = true;
    const onFrame = (now, meta) => {
      if (P.on) P.frames.push({ el: el.id, now, media: meta.mediaTime, shown: !el.classList.contains('is-off') });
      el.requestVideoFrameCallback(onFrame);
    };
    el.requestVideoFrameCallback(onFrame);
    let seekAt = 0;
    el.addEventListener('seeking', () => { seekAt = performance.now(); });
    el.addEventListener('seeked', () => { if (P.on && seekAt) P.seeks.push(performance.now() - seekAt); });
  };
  const stage = document.querySelector('.stage');
  stage.querySelectorAll('video').forEach(hook);
  // the fast copies' elements are made when the copies arrive
  new MutationObserver(() => stage.querySelectorAll('video').forEach(hook)).observe(stage, { childList: true });
  const { timeline, player } = window.__flowcut;
  const draw = timeline.draw.bind(timeline);
  timeline.draw = () => { const a = performance.now(); draw(); if (P.on) P.draw.push(performance.now() - a); };
  const jumpOver = player.jumpOver.bind(player);
  player.jumpOver = (cut) => {
    const before = player.v;
    jumpOver(cut);
    const how = player.holding ? 'waited' : player.v !== before ? 'switched' : 'seeked';
    if (P.on && cut.to !== null) P.jumps.push({ at: performance.now(), to: cut.to, how });
  };
}

function summarize(p, wall, rate) {
  const shown = p.frames.filter((f) => f.shown);
  const gaps = [];
  let played = 0;
  for (let i = 1; i < shown.length; i++) {
    gaps.push(shown[i].now - shown[i - 1].now);
    const d = shown[i].media - shown[i - 1].media;
    if (d > 0 && d < 0.5 * Math.max(1, rate)) played += d;          // a jump over a cut is not playing
  }
  gaps.sort((a, b) => a - b);
  const q = (x) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(x * gaps.length))] : 0);
  const stalls = gaps.filter((g) => g >= 150);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const jumps = p.jumps.map((j) => {
    const next = shown.find((f) => f.now > j.at && f.media >= j.to - 0.01);       // first frame after the cut
    const prev = [...shown].reverse().find((f) => f.now <= j.at);
    return { how: j.how, gap: next && prev ? Math.round(next.now - prev.now) : null };
  });
  return {
    rate,
    fps: shown.length / wall,
    speed: played / wall,
    gapP50: q(0.5),
    gapP95: q(0.95),
    gapMax: gaps.length ? gaps[gaps.length - 1] : 0,
    stalls: stalls.length,
    stallSec: stalls.reduce((s, g) => s + g, 0) / 1000,
    seekAvg: avg(p.seeks),
    drawAvg: avg(p.draw),
    drawMax: p.draw.length ? Math.max(...p.draw) : 0,
    jumps,
    fastShown: shown.filter((f) => f.el.startsWith('videoFast')).length,
    pageFps: p.raf.length / wall,
    // frames shown in each second of the run: shows when a run went from 60 to 30 and back
    perSecond: Array.from({ length: Math.floor(wall) }, (_, k) => shown.filter((f) => f.now - p.t0 >= k * 1000 && f.now - p.t0 < (k + 1) * 1000).length),
    pagePerSecond: Array.from({ length: Math.floor(wall) }, (_, k) => p.raf.filter((t) => t - p.t0 >= k * 1000 && t - p.t0 < (k + 1) * 1000).length),
  };
}

function copyProject(dir) {
  const id = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).id || path.basename(dir);
  const dest = path.join(PROFILE, 'projects', id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (!/partial/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(dest, f));
  const pj = path.join(dest, 'project.json');
  const proj = JSON.parse(fs.readFileSync(pj, 'utf8'));
  if (proj.fast && typeof proj.fast === 'object') {          // fast copies that came along are used from their new place
    for (const fps of Object.keys(proj.fast)) proj.fast[fps] = path.join(dest, `fast${fps}.mp4`);
  } else {
    delete proj.fast;
  }
  fs.writeFileSync(pj, JSON.stringify(proj));
}

async function main() {
  if (!FILE || !fs.existsSync(FILE)) throw new Error('usage: npm run smooth -- --file "path\\to\\recording.mp4"');
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROFILE, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ transcript: { auto: false }, view: { captions: !flag('no-captions') } }));
  if (PROJECT) copyProject(PROJECT);
  // the project id is made from the path as Windows writes it
  const file = path.resolve(FILE);
  const app = await _electron.launch({ executablePath: electronPath, args: [ROOT], env: { ...process.env, FLOWCUT_USER_DATA: PROFILE, FLOWCUT_OPEN: file } });
  const page = await app.firstWindow();
  page.on('pageerror', (err) => console.log(`page error: ${err.message}`));
  await page.waitForSelector('#editor:not([hidden])', { timeout: 15 * 60000 });
  await page.waitForFunction(() => window.__flowcut?.S.cut?.segments?.length > 0, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 60000 });
  const env = await page.evaluate(async (codecs) => {
    const { S } = window.__flowcut;
    const info = S.project.info.video;
    let decode = 'unknown';
    if (codecs[info.codec]) {
      try {
        const r = await navigator.mediaCapabilities.decodingInfo({
          type: 'file', video: { contentType: `video/mp4; codecs="${codecs[info.codec]}"`, width: info.width, height: info.height, bitrate: 50e6, framerate: info.fps },
        });
        decode = r.supported ? (r.powerEfficient ? 'hardware' : 'software') : 'not supported';
      } catch { /* unknown */ }
    }
    const kept = S.cut.segments.filter((s) => s.keep).map((s) => s.end - s.start);
    return {
      size: `${info.width}x${info.height}`, codec: info.codec, fps: info.fps, decode, words: S.words?.length || 0,
      cuts: S.cut.segments.filter((s) => !s.keep).length, kept: kept.length, short: kept.filter((k) => k < 2).length,
      fast: Boolean(S.project.fastCopies),
    };
  }, CODECS);
  console.log(`${path.basename(file)}: ${env.size} ${env.codec} @ ${env.fps} fps (${env.decode} decode), ${env.cuts} cuts, `
    + `${env.kept} kept pieces (${env.short} under 2 s), ${env.words} words, fast copy ${env.fast ? 'ready' : 'not yet'}`);
  await page.evaluate(installProbe);
  if (flag('no-words-lane')) await page.evaluate(() => { window.__flowcut.timeline.drawWords = () => {}; });
  if (flag('mute')) await page.evaluate(() => { for (const el of document.querySelectorAll('.stage video')) el.muted = true; });

  if (flag('wait-fast') && RATES.some((r) => r * env.fps > 75)) {
    console.log('waiting for the fast copy ...');
    await page.waitForFunction(() => window.__flowcut.player.fastReady, null, { timeout: 30 * 60000 });
  }

  const rows = [];
  for (const rate of RATES) {
    await page.evaluate(([r, t, span]) => {
      const { player, timeline } = window.__flowcut;
      player.pause();
      document.querySelector(`#speeds button[data-rate="${r}"]`).click();
      player.seek(t, null);
      if (span) timeline.setView(t - span / 4, t - span / 4 + span);
    }, [rate, AT, SPAN]);
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const P = window.__probe;
      for (const k of ['frames', 'seeks', 'draw', 'jumps', 'raf']) P[k].length = 0;
      P.on = true;
      P.t0 = performance.now();
      window.__flowcut.player.play();
    });
    await page.waitForTimeout(SECONDS * 1000);
    const res = await page.evaluate(() => {
      const P = window.__probe;
      P.on = false;
      window.__flowcut.player.pause();
      return { p: JSON.parse(JSON.stringify(P)), wall: (performance.now() - P.t0) / 1000 };
    });
    const s = summarize(res.p, res.wall, rate);
    rows.push(s);
    const count = (how) => s.jumps.filter((j) => j.how === how).length;
    const worst = Math.max(0, ...s.jumps.map((j) => j.gap || 0));
    console.log(`${rate}x  shown ${s.fps.toFixed(1)} fps  real speed ${s.speed.toFixed(2)}x  frame gap p50 ${s.gapP50.toFixed(0)} / p95 ${s.gapP95.toFixed(0)} / max ${s.gapMax.toFixed(0)} ms`
      + `  stalls ${s.stalls} (${s.stallSec.toFixed(1)} s)  jumps ${s.jumps.length}: ${count('switched')} switched, ${count('waited')} waited, ${count('seeked')} seeked (worst ${worst} ms)`
      + `  timeline ${s.drawAvg.toFixed(1)} / ${s.drawMax.toFixed(1)} ms  page ${s.pageFps.toFixed(0)} fps${s.fastShown ? '  (fast copy)' : ''}`);
    if (flag('verbose')) console.log(`    jumps ${JSON.stringify(s.jumps)}
    shown per second ${s.perSecond.join(' ')}
    page per second  ${s.pagePerSecond.join(' ')}`);
  }
  fs.writeFileSync(path.join(OUT, 'smooth.json'), JSON.stringify({ file, env, rows }, null, 1));
  await app.close();
  if (!flag('keep')) fs.rmSync(PROFILE, { recursive: true, force: true });
  const bad = rows.filter((r) => r.stalls > 0);
  console.log(bad.length ? `STALLS at ${bad.map((r) => `${r.rate}x`).join(', ')}` : 'SMOOTH: no stalls');
}

main().catch((err) => { console.error(err); process.exit(1); });
