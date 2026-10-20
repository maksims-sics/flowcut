'use strict';
// End-to-end test: launches the real app (Playwright's Electron driver) on generated clips, reviews and edits with
// mouse and keyboard, makes a moment louder, renders MP4 and MOV, and checks the files. Screenshots: test/artifacts/.
// usage: npm run e2e                     (add -- --file "D:\path\real.mp4" [--transcribe] for a real recording)
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'artifacts');
const CLIP = path.join(OUT, 'clip.mp4');
const CLIP4K = path.join(OUT, 'clip4k.mp4');
const PROFILE = path.join(OUT, 'profile');
// 220 Hz tone bursts at 1-3, 4.2-6, 6.3-8 and 10-11 s over a quiet noise floor
const TONE = '0.1*sin(2*PI*220*t)*(between(t,1,3)+between(t,4.2,6)+between(t,6.3,8)+between(t,10,11))+0.001*(2*random(0)-1)';
let failures = 0;

function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function makeClip(file, size, preset) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=12`,
    '-f', 'lavfi', '-i', `aevalsrc='${TONE}':s=48000:d=12`,
    '-c:v', 'libx264', '-preset', preset, '-g', '60', '-pix_fmt', 'yuv420p',   // a keyframe every 2 s, like OBS
    '-c:a', 'aac', '-b:a', '192k', '-shortest', file]);
}

function probeStreams(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration,width,height,avg_frame_rate', '-of', 'json', file]);
  return JSON.parse(out.toString()).streams;
}

/** mean volume (dB) of a file's audio between a and b seconds */
function meanDb(file, a, b) {
  const r = require('node:child_process').spawnSync('ffmpeg', ['-hide_banner', '-ss', String(a), '-t', String(b - a), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : NaN;
}

async function launch(env) {
  const app = await _electron.launch({ executablePath: electronPath, args: [ROOT], env: { ...process.env, FLOWCUT_USER_DATA: PROFILE, ...env } });
  const page = await app.firstWindow();
  page.on('pageerror', (err) => { console.log(`page error: ${err.message}`); failures++; });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log(`console error: ${msg.text()}`); });
  return { app, page };
}

const state = (page, fn, arg) => page.evaluate(fn, arg);
const edits = (page) => state(page, () => window.__flowcut.history.count);
const output = (page) => state(page, () => window.__flowcut.S.cut.stats.outputSeconds);
const now = (page) => state(page, () => window.__flowcut.player.time);
const view = (page) => state(page, () => ({ ...window.__flowcut.timeline.view }));
/** where the playhead sits in the visible timeline: 0 = left edge, 0.5 = middle, 1 = right edge */
const playheadAt = (page) => state(page, () => {
  const { timeline: tl, player } = window.__flowcut;
  return (player.time - tl.view.start) / (tl.view.end - tl.view.start);
});

async function pointAt(page, t, lane = 'wave') {
  const box = await page.locator('#timeline').boundingBox();
  const { x, y } = await page.evaluate(([tt, ln]) => {
    const tl = window.__flowcut.timeline;
    const r = tl.rows[ln];
    return { x: tl.x(tt), y: r.y + r.h * 0.3 };
  }, [t, lane]);
  return { x: box.x + x, y: box.y + y };
}

async function seek(page, t) {
  await page.evaluate((tt) => window.__flowcut.player.seek(tt), t);
  await page.waitForTimeout(120);
}

async function render(page, format) {
  await page.selectOption('#format', format);
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => [...document.querySelectorAll('.toast')].filter((t) => /Render (finished|failed)/.test(t.textContent)).length);
  await page.click('#btnRender');
  await page.waitForFunction((n) => [...document.querySelectorAll('.toast')].filter((t) => /Render (finished|failed)/.test(t.textContent)).length > n, before, { timeout: 180000 });
  const failed = await page.evaluate(() => [...document.querySelectorAll('.toast.error')].map((t) => t.textContent.trim()).find((x) => x.includes('Render failed')));
  if (failed) console.log(`render error: ${failed}`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  // the synthetic clip has no speech: no automatic transcription (Whisper can invent words on pure tones)
  fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ transcript: { auto: false } }));
  makeClip(CLIP, '1280x720', 'veryfast');

  const { app, page } = await launch({ FLOWCUT_OPEN: CLIP });
  await page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(() => window.__flowcut?.S.cut?.segments?.length > 0);
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 20000 });

  const auto = await state(page, () => {
    const { S } = window.__flowcut;
    return { kept: S.cut.segments.filter((s) => s.keep).map((s) => [s.start, s.end]), out: S.cut.stats.outputSeconds, pauses: S.cut.stats.silenceCuts };
  });
  check(auto.kept.length === 3, 'silences found automatically: 3 kept pieces, short 0.3 s pause bridged', JSON.stringify(auto.kept.map(([a, b]) => [a.toFixed(2), b.toFixed(2)])));
  check(Math.abs(auto.out - 7.33) < 0.15 && auto.pauses === 4, 'auto output about 7.3 s, 4 pauses cut', `${auto.out.toFixed(3)} s`);
  check(await page.locator('#level').count() === 0, 'no silence settings in the window (automatic only)');
  const rows = await page.locator('#reviewList .ri').count();
  check(rows === 4, 'review list shows every cut', `${rows} rows`);
  await page.screenshot({ path: path.join(OUT, '1-editor.png') });

  // speeds; 6x makes the fast copy (same size, 10 frames a second) and plays it, stopping shows the original again
  await page.keyboard.press('2');
  const rate = await state(page, () => window.__flowcut.player.rate);
  await page.click('#speeds button[data-rate="6"]');
  const rate6 = await state(page, () => window.__flowcut.player.rate);
  check(rate === 2 && rate6 === 6, 'speeds 2× (key) and 6× (button) set the playback rate');
  const fastUrl = await page.waitForFunction(() => window.__flowcut.S.project.fastUrl, null, { timeout: 90000 }).then((h) => h.jsonValue()).catch(() => null);
  if (fastUrl) {
    const v = probeStreams(fileURLToPath(fastUrl)).find((s) => s.codec_type === 'video');
    check(v.width === 1280 && v.height === 720 && v.avg_frame_rate === '10/1', '6× made the fast copy: same size, 10 frames a second', `${v.width}x${v.height} ${v.codec_name} ${v.avg_frame_rate}`);
    await page.waitForFunction(() => window.__flowcut.player.fastReady, null, { timeout: 10000 });
    await seek(page, 4.3);
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    const playingFast = await state(page, () => ({ fast: window.__flowcut.player.showingFast, shown: !document.querySelector('#videoFast').classList.contains('is-off'), t: window.__flowcut.player.time }));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.querySelector('#video').classList.contains('is-off'), null, { timeout: 3000 }).catch(() => {});
    const stopped = await state(page, () => {
      const m = document.querySelector('#video');
      return { fast: window.__flowcut.player.showingFast, shown: !m.classList.contains('is-off'), t: m.currentTime, playing: window.__flowcut.player.playing };
    });
    check(playingFast.fast && playingFast.shown && playingFast.t > 5.5, 'playing at 6× shows the fast copy', `at ${playingFast.t.toFixed(2)} s`);
    check(!stopped.fast && stopped.shown && !stopped.playing, 'stopping shows the original again, on the same moment', `original at ${stopped.t.toFixed(2)} s`);
  } else {
    check(false, '6× made the fast copy');
  }
  await page.keyboard.press('1');

  // the preview shows the whole frame (it used to be as wide as the stage and cut off at the bottom)
  const fit = await state(page, () => {
    const st = document.querySelector('.stage').getBoundingClientRect();
    const v = document.querySelector('#video').getBoundingClientRect();
    return { st: [st.width, st.height], v: [v.width, v.height] };
  });
  check(fit.v[0] <= fit.st[0] + 1 && fit.v[1] <= fit.st[1] + 1, 'the preview fits the whole frame in the stage', `video box ${fit.v.map(Math.round).join('x')}, stage ${fit.st.map(Math.round).join('x')}`);

  // S splits: nothing is cut until a piece's bar is clicked
  let n = await edits(page);
  let before = await output(page);
  await seek(page, 5.0);
  await page.keyboard.press('s');
  await seek(page, 5.6);
  await page.keyboard.press('s');
  await page.waitForFunction((k) => window.__flowcut.history.count === k + 2, n);
  const piece = await state(page, () => window.__flowcut.S.pieces.find((p) => Math.abs(p.start - 5) < 0.01));
  let after = await output(page);
  check(piece && Math.abs(piece.end - 5.6) < 0.01 && Math.abs(after - before) < 0.01, 'S splits at the playhead without cutting', piece ? `piece ${piece.start.toFixed(2)}-${piece.end.toFixed(2)} s, output still ${after.toFixed(2)} s` : 'no piece');
  let p = await pointAt(page, 5.3, 'bar');
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction((o) => Math.abs(window.__flowcut.S.cut.stats.outputSeconds - o) > 0.3, before);
  after = await output(page);
  check(Math.abs(before - after - 0.6) < 0.05, 'clicking the bar of a piece cuts it', `${before.toFixed(2)} s -> ${after.toFixed(2)} s`);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction((o) => Math.abs(window.__flowcut.S.cut.stats.outputSeconds - o) < 0.01, before);
  check(true, 'clicking it again brings it back');
  await seek(page, 5.3);
  await page.keyboard.press('Delete');
  await page.waitForFunction((o) => Math.abs(window.__flowcut.S.cut.stats.outputSeconds - o) > 0.3, before);
  after = await output(page);
  check(Math.abs(before - after - 0.6) < 0.05, 'Del cuts the piece under the playhead', `${after.toFixed(2)} s`);

  // O flips the piece under the playhead (the 8.15-9.99 s pause becomes kept), K brings back a cut
  n = await edits(page);
  before = after;
  await seek(page, 9.0);
  await page.keyboard.press('o');
  await page.waitForFunction((k) => window.__flowcut.history.count === k + 1, n);
  after = await output(page);
  check(after - before > 1.7, 'O flips the piece under the playhead', `${before.toFixed(2)} s -> ${after.toFixed(2)} s`);
  await page.keyboard.press('Control+z');
  await page.waitForFunction((k) => window.__flowcut.history.count === k, n);
  check(Math.abs((await output(page)) - before) < 0.01, 'Ctrl+Z undoes it');
  await page.keyboard.press('k');
  await page.waitForFunction((k) => window.__flowcut.history.count === k + 1, n);
  after = await output(page);
  check(after - before > 1.7, 'K brings back the cut under the playhead', `${before.toFixed(2)} s -> ${after.toFixed(2)} s`);
  await page.keyboard.press('Control+z');
  await page.waitForFunction((k) => window.__flowcut.history.count === k, n);

  // double-click flips the 3.15-4.19 s pause to kept
  n = await edits(page);
  p = await pointAt(page, 3.65);
  await page.mouse.dblclick(p.x, p.y);
  await page.waitForFunction((k) => window.__flowcut.history.count >= k + 1, n);
  check(true, 'double-click flips a piece');

  // dragging on the timeline selects nothing: it slides the view
  await state(page, () => window.__flowcut.timeline.setView(0, 6));
  n = await edits(page);
  p = await pointAt(page, 3);
  const p2 = await pointAt(page, 2);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p2.x, p2.y, { steps: 6 });
  await page.mouse.up();
  const slid = await view(page);
  check(Math.abs(slid.start - 1) < 0.1 && (await edits(page)) === n && !('sel' in (await state(page, () => window.__flowcut.S))),
    'dragging slides the timeline (no selection, no edit)', `view ${slid.start.toFixed(2)}-${slid.end.toFixed(2)} s`);
  await state(page, () => window.__flowcut.timeline.fit());

  // split at 1.5 s and 2.5 s, V in between: that piece is 3 dB louder
  await seek(page, 1.5);
  await page.keyboard.press('s');
  await seek(page, 2.5);
  await page.keyboard.press('s');
  await seek(page, 2.0);
  await page.keyboard.press('v');
  await page.waitForFunction(() => window.__flowcut.S.cut.gains.length === 1);
  const gain = await state(page, () => window.__flowcut.S.cut.gains[0]);
  check(gain.db === 3 && Math.abs(gain.start - 1.5) < 0.02 && Math.abs(gain.end - 2.5) < 0.02, 'V makes the piece under the playhead 3 dB louder', `${gain.start.toFixed(2)}-${gain.end.toFixed(2)} s +${gain.db} dB`);
  check(await page.locator('#reviewList .ri-louder').count() === 1, 'the louder moment is listed for review');
  await page.screenshot({ path: path.join(OUT, '2-edited.png') });

  // a review row jumps 1 s before its cut, and Space then plays that cut (preview stays on)
  await page.click('#reviewList .ri-silence >> nth=1');
  const picked = await state(page, () => ({ t: window.__flowcut.player.time, pass: window.__flowcut.player.pass }));
  check(picked.pass && Math.abs(picked.t - (picked.pass.start - 1)) < 0.05, 'a review row jumps 1 s before its cut', picked.pass ? `${picked.pass.start.toFixed(2)}-${picked.pass.end.toFixed(2)} s` : 'no cut');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1600);
  const tRow = await now(page);
  const hintRow = await page.locator('#stageHint').textContent();
  await page.keyboard.press('Space');
  check(picked.pass && tRow > picked.pass.start + 0.2 && tRow < picked.pass.end, '...and Space plays that cut instead of skipping it', `at ${tRow.toFixed(2)} s, hint "${hintRow}"`);

  // clicking inside a cut plays it from there
  p = await pointAt(page, 8.6);
  await page.mouse.click(p.x, p.y);
  const clicked = await state(page, () => ({ t: window.__flowcut.player.time, pass: window.__flowcut.player.pass }));
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const tClick = await now(page);
  await page.keyboard.press('Space');
  check(clicked.pass && Math.abs(clicked.t - 8.6) < 0.1 && tClick > 8.9 && tClick < clicked.pass.end, 'clicking in a cut plays that cut (not reviving it)', `from ${clicked.t.toFixed(2)} s to ${tClick.toFixed(2)} s`);

  // preview still skips the cuts it runs into: playback jumps over the 8.15-9.99 s cut
  await seek(page, 7.9);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  const tPlay = await now(page);
  check(tPlay > 9.9, 'Preview result skips the cuts it runs into', `stopped at ${tPlay.toFixed(2)} s`);

  // the timeline follows: the playhead walks to the middle and stays there; paused, the view slides freely
  await state(page, () => window.__flowcut.timeline.setView(0, 4));
  await seek(page, 1.0);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1700);
  const f1 = await playheadAt(page);
  const v1 = await view(page);
  await page.waitForTimeout(500);
  const f2 = await playheadAt(page);
  const v2 = await view(page);
  await page.keyboard.press('Space');
  check(Math.abs(f1 - 0.5) < 0.05 && Math.abs(f2 - 0.5) < 0.05 && v2.start > v1.start + 0.3, 'while playing the playhead stays in the middle and the timeline slides', `at ${f1.toFixed(2)} and ${f2.toFixed(2)} of the view, view from ${v1.start.toFixed(2)} to ${v2.start.toFixed(2)} s`);
  const box = await page.locator('#timeline').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);
  const v3 = await view(page);
  await page.waitForTimeout(400);
  const v4 = await view(page);
  check(v3.start > v2.start + 0.5 && Math.abs(v4.start - v3.start) < 1e-6, 'paused, the wheel slides the timeline and it stays there', `view ${v2.start.toFixed(2)} -> ${v3.start.toFixed(2)} s`);
  await state(page, () => window.__flowcut.timeline.fit());

  // words on the video: the phrase being spoken, the word being spoken lit, cut words struck through
  await state(page, () => window.__flowcut.setWords([
    { w: 'Hello', s: 1.1, e: 1.45 }, { w: 'this', s: 1.55, e: 1.85 }, { w: 'is', s: 1.95, e: 2.15 },
    { w: 'a', s: 2.2, e: 2.3 }, { w: 'test.', s: 2.35, e: 2.9 }, { w: 'Cut', s: 8.3, e: 8.6 }, { w: 'here', s: 8.7, e: 9.0 },
  ]));
  await seek(page, 1.7);
  const cap1 = await state(page, () => ({ shown: !document.querySelector('#caption').hidden, text: document.querySelector('#caption').textContent.trim(), now: document.querySelector('#caption .now')?.textContent }));
  check(cap1.shown && cap1.text.startsWith('Hello this is a test.') && cap1.now === 'this', 'words on the video: the phrase, the word being spoken lit', `"${cap1.text}", lit "${cap1.now}"`);
  await seek(page, 8.5);
  const cap2 = await state(page, () => ({ text: document.querySelector('#caption').textContent.trim(), cut: [...document.querySelectorAll('#caption .cut')].map((e) => e.textContent) }));
  check(cap2.cut.includes('Cut') && cap2.cut.includes('here'), '...and words in a cut struck through', `"${cap2.text}"`);
  await page.screenshot({ path: path.join(OUT, '7-words.png') });
  await page.keyboard.press('c');
  const capOff = await state(page, () => document.querySelector('#caption').hidden);
  await page.keyboard.press('c');
  const capOn = await state(page, () => !document.querySelector('#caption').hidden);
  check(capOff && capOn, 'C turns the words on the video off and on');
  await state(page, () => window.__flowcut.setWords(null));

  // render MP4, then MOV
  const expectFrames = await state(page, () => Math.round(window.__flowcut.S.cut.stats.outputSeconds * 30));
  const firstKept = await state(page, () => window.__flowcut.S.cut.segments.find((s) => s.keep).start);
  await render(page, 'mp4');
  const mp4 = path.join(OUT, 'clip_flowcut.mp4');
  check(fs.existsSync(mp4), 'render wrote clip_flowcut.mp4');
  if (fs.existsSync(mp4)) {
    const st = probeStreams(mp4);
    const v = st.find((s) => s.codec_type === 'video');
    const a = st.find((s) => s.codec_type === 'audio');
    check(Number(v.nb_read_frames) === expectFrames, 'MP4 frame count matches the cut list', `${v.nb_read_frames} vs ${expectFrames}`);
    check(Math.abs(Number(a.duration) - Number(v.nb_read_frames) / 30) < 0.03 && a.codec_name === 'aac', 'MP4 sound is AAC and as long as the picture', `${a.duration} s`);
    // boosted 1.5-2.5 s (source) vs plain tone 2.6-2.95 s, both in the first kept piece
    const boosted = meanDb(mp4, 1.6 - firstKept, 2.4 - firstKept);
    const plain = meanDb(mp4, 2.65 - firstKept, 2.95 - firstKept);
    check(Math.abs(boosted - plain - 3) < 0.4, 'the louder moment is +3 dB in the render', `${boosted} dB vs ${plain} dB`);
  }
  await page.screenshot({ path: path.join(OUT, '3-rendered.png') });
  await render(page, 'mov');
  const mov = path.join(OUT, 'clip_flowcut.mov');
  if (fs.existsSync(mov)) {
    const st = probeStreams(mov);
    const v = st.find((s) => s.codec_type === 'video');
    const a = st.find((s) => s.codec_type === 'audio');
    check(Number(v.nb_read_frames) === expectFrames && a.codec_name === 'pcm_s24le', 'MOV: same frames, lossless 24-bit sound', `${v.nb_read_frames} frames, ${a.codec_name}`);
  } else {
    check(false, 'render wrote clip_flowcut.mov');
  }
  await page.selectOption('#format', 'mp4');

  // help overlay
  await page.keyboard.press('Shift+?');
  await page.waitForSelector('#help:not([hidden])');
  await page.screenshot({ path: path.join(OUT, '4-shortcuts.png') });
  await page.keyboard.press('Escape');
  await app.close();

  // welcome screen with the recent list
  const second = await launch({});
  await second.page.waitForSelector('#recentSection:not([hidden])', { timeout: 15000 });
  await second.page.waitForTimeout(300);
  await second.page.screenshot({ path: path.join(OUT, '0-welcome.png') });
  check(true, 'welcome screen lists the recent recording');
  await second.app.close();

  // 4K: the editor always shows the original size, also after 4x / 6x
  makeClip(CLIP4K, '3840x2160', 'ultrafast');
  const big = await launch({ FLOWCUT_OPEN: CLIP4K });
  await big.page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
  await big.page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 30000 });
  await big.page.keyboard.press('4');
  await big.page.waitForFunction(() => window.__flowcut.player.fastReady, null, { timeout: 120000 }).catch(() => {});
  await big.page.evaluate(() => window.__flowcut.player.seek(4.3));
  await big.page.keyboard.press('Space');
  await big.page.waitForTimeout(600);
  const fastSize = await big.page.evaluate(() => {
    const f = document.querySelector('#videoFast');
    return { fast: window.__flowcut.player.showingFast, w: f.videoWidth, h: f.videoHeight };
  });
  await big.page.keyboard.press('Space');
  await big.page.waitForFunction(() => !document.querySelector('#video').classList.contains('is-off'), null, { timeout: 3000 }).catch(() => {});
  const mainSize = await big.page.evaluate(() => {
    const m = document.querySelector('#video');
    return { w: m.videoWidth, h: m.videoHeight, badge: !document.querySelector('#stageBadge').hidden, shown: !m.classList.contains('is-off') };
  });
  check(fastSize.fast && fastSize.w === 3840 && fastSize.h === 2160, '4K at 4×: the fast copy has the original size', `${fastSize.w}x${fastSize.h}`);
  check(mainSize.w === 3840 && mainSize.h === 2160 && mainSize.shown && !mainSize.badge, '4K stopped: the original itself is shown (no 1080p copy)', `${mainSize.w}x${mainSize.h}`);
  await big.app.close();

  // an MKV with a codec the window cannot decode: opens, then a review copy of the same size makes it play
  const mkv = path.join(OUT, 'clip4k.mkv');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', CLIP4K, '-c:v', 'mpeg2video', '-q:v', '4', '-c:a', 'copy', mkv]);
  const third = await launch({ FLOWCUT_OPEN: mkv });
  await third.page.waitForSelector('#editor:not([hidden])', { timeout: 60000 });
  await third.page.waitForFunction(() => window.__flowcut?.S.cut?.segments?.length > 0);
  const unplayable = await third.page.waitForSelector('#stageMessage:not([hidden])', { timeout: 15000 }).then(() => true).catch(() => false);
  check(unplayable, 'a video the window cannot decode is detected (sound alone does not count)');
  if (unplayable) {
    await third.page.click('#btnProxy');
    await third.page.waitForFunction(() => document.querySelector('#video').videoWidth > 0 && !document.querySelector('#stageBadge').hidden, null, { timeout: 180000 });
    const w = await third.page.evaluate(() => document.querySelector('#video').videoWidth);
    check(w === 3840, 'the review copy plays, at the original size', `${w} px wide`);
  }
  await third.app.close();

  // optional: a real recording
  const fi = process.argv.indexOf('--file');
  if (fi > 0) {
    const file = process.argv[fi + 1];
    const real = await launch({ FLOWCUT_OPEN: file });
    await real.page.waitForSelector('#editor:not([hidden])', { timeout: 600000 });
    await real.page.waitForFunction(() => window.__flowcut?.S.cut?.segments?.length > 0);
    await real.page.waitForFunction(() => document.querySelector('#video').readyState >= 2, null, { timeout: 60000 }).catch(() => {});
    const info = await real.page.evaluate(() => {
      const { S } = window.__flowcut;
      const v = document.querySelector('#video');
      return { kept: S.cut.segments.filter((s) => s.keep).length, out: S.cut.stats.outputSeconds, w: v.videoWidth, ready: v.readyState };
    });
    check(info.ready >= 2, `real recording plays (${path.basename(file)})`, `${info.w}px, ${info.kept} kept pieces, ${info.out.toFixed(2)} s`);
    if (process.argv.includes('--transcribe')) {
      await real.page.click('details.more:has(#btnTranscribe) > summary');
      await real.page.click('#btnTranscribe');
      await real.page.waitForSelector('.toast.success >> text=Transcript ready', { timeout: 900000 });
      await real.page.waitForTimeout(800);
      const res = await real.page.evaluate(() => ({ words: window.__flowcut.S.words?.length || 0, fillers: window.__flowcut.S.cut.stats.fillerCuts }));
      check(res.words > 20, 'Whisper words appear and filler words are marked', `${res.words} words, ${res.fillers} filler cuts`);
      const f = await real.page.evaluate(() => window.__flowcut.S.cut.segments.find((s) => s.reason === 'filler' && !s.keep));
      if (f) {
        await real.page.click('.tabs button[data-filter="filler"]');
        await real.page.evaluate((s) => { window.__flowcut.player.seek(s.start - 1); window.__flowcut.timeline.setView(s.start - 5, s.start + 7); }, f);
        await real.page.waitForTimeout(1500);
        await real.page.screenshot({ path: path.join(OUT, '6-real-fillers.png') });
      }
    }
    await real.page.evaluate(() => { window.__flowcut.player.seek(20); window.__flowcut.timeline.setView(14, 26); });
    await real.page.waitForTimeout(1500);
    await real.page.screenshot({ path: path.join(OUT, '5-real-recording.png') });
    await real.app.close();
  }

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  if (!failures) {
    // the 4K clips and the copies in the test profile take ~300 MB; screenshots and the small renders stay
    for (const f of [CLIP4K, path.join(OUT, 'clip4k.mkv'), PROFILE]) fs.rmSync(f, { recursive: true, force: true });
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
