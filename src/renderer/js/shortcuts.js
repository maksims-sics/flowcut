// Keyboard shortcuts. The table doubles as the help screen (press ?).
// repeat: false = holding the key down does not repeat the action (S, O, V... act once per press).
const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'range';

export function shortcutTable(a) {
  const ctrl = (e) => e.ctrlKey || e.metaKey;
  const plain = (e) => !ctrl(e) && !e.altKey;
  const arrow = (e) => e.code === 'ArrowLeft' || e.code === 'ArrowRight';
  const dir = (e) => (e.code === 'ArrowLeft' || e.code === 'ArrowUp' ? -1 : 1);
  const SPEED_KEYS = ['Digit1', 'Digit2', 'Digit4', 'Digit6', 'Numpad1', 'Numpad2', 'Numpad4', 'Numpad6'];
  return [
    { group: 'Review' },
    { keys: 'Space', label: 'Play / pause', match: (e) => e.code === 'Space', run: a.togglePlay, repeat: false },
    { keys: '1 2 4 6', label: 'Speed 1×, 2×, 4×, 6×', match: (e) => plain(e) && SPEED_KEYS.includes(e.code), run: (e) => a.speed(Number(e.code.slice(-1))), repeat: false },
    { keys: 'P', label: 'Preview the result (skip the cuts) on / off', match: (e) => plain(e) && e.code === 'KeyP', run: a.togglePreview, repeat: false },
    { keys: 'C', label: 'Words on the video on / off (the word being spoken lights up)', match: (e) => plain(e) && e.code === 'KeyC', run: a.captions, repeat: false },
    { keys: '↑ / ↓', label: 'Previous / next cut (also Shift + ← / →)', match: (e) => (e.code === 'ArrowUp' || e.code === 'ArrowDown') && !e.shiftKey && plain(e), run: (e) => a.jumpCut(dir(e)) },
    { keys: 'Shift + ← / →', label: 'Previous / next cut', match: (e) => arrow(e) && e.shiftKey, run: (e) => a.jumpCut(dir(e)), hidden: true },
    { keys: '← / →', label: 'One frame back / forward', match: (e) => arrow(e) && !e.shiftKey && plain(e), run: (e) => a.step(dir(e)) },
    { keys: 'Ctrl + ← / →', label: '5 seconds back / forward', match: (e) => arrow(e) && ctrl(e), run: (e) => a.nudge(dir(e) * 5) },
    { keys: 'Home / End', label: 'Start / end', match: (e) => e.code === 'Home' || e.code === 'End', run: (e) => a.seekEdge(e.code === 'End') },
    { group: 'Cut' },
    { keys: 'S', label: 'Split the recording at the playhead (nothing is cut yet)', match: (e) => plain(e) && e.code === 'KeyS', run: a.split, repeat: false },
    { keys: 'Click', label: 'On the bar above a piece: cut that piece or bring it back. Below it: move the playhead (in a cut, preview plays it)', match: () => false },
    { keys: 'O', label: 'Flip the piece under the playhead between kept and cut (or double-click it)', match: (e) => plain(e) && e.code === 'KeyO', run: a.flipHere, repeat: false },
    { keys: 'Del', label: 'Cut the piece under the playhead', match: (e) => e.code === 'Delete' || e.code === 'Backspace', run: a.cutHere, repeat: false },
    { keys: 'K', label: 'Keep: bring back the piece under the playhead', match: (e) => plain(e) && e.code === 'KeyK', run: a.keepHere, repeat: false },
    { keys: 'V', label: 'Louder: +3 dB on the piece under the playhead; Shift + V removes it', match: (e) => !ctrl(e) && e.code === 'KeyV', run: (e) => a.louder(e.shiftKey ? 'reset' : 'add'), repeat: false },
    { keys: 'Drag / Wheel', label: 'Slide the timeline left / right (Ctrl + wheel zooms). While playing it follows the playhead', match: () => false },
    { keys: 'Esc', label: 'Close', match: (e) => e.code === 'Escape', run: a.escape, always: true },
    { keys: 'Ctrl + Z', label: 'Undo (Ctrl + Y redo)', match: (e) => ctrl(e) && e.code === 'KeyZ' && !e.shiftKey, run: a.undo },
    { keys: 'Ctrl + Y', label: 'Redo', match: (e) => ctrl(e) && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)), run: a.redo, hidden: true },
    { group: 'View and files' },
    { keys: '+ / -', label: 'Zoom in / out (or Ctrl + wheel); 0 shows the whole recording', match: (e) => plain(e) && ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract'].includes(e.code), run: (e) => a.zoom(e.code === 'Equal' || e.code === 'NumpadAdd' ? 0.6 : 1 / 0.6) },
    { keys: '0', label: 'Whole recording', match: (e) => plain(e) && (e.code === 'Digit0' || e.code === 'Numpad0'), run: a.fit, hidden: true },
    { keys: 'Ctrl + O', label: 'Open a recording', match: (e) => ctrl(e) && e.code === 'KeyO', run: a.open, always: true },
    { keys: 'Ctrl + R', label: 'Render', match: (e) => ctrl(e) && e.code === 'KeyR', run: a.render, always: true },
    { keys: '?', label: 'This list', match: (e) => e.key === '?' || e.code === 'F1', run: a.help, always: true },
    { keys: 'F12', label: 'Developer tools', match: (e) => e.code === 'F12' || (ctrl(e) && e.shiftKey && e.code === 'KeyI'), run: a.devtools, always: true, hidden: true },
  ];
}

export function installShortcuts(table) {
  document.addEventListener('keydown', (e) => {
    for (const s of table) {
      if (!s.run || !s.match(e)) continue;
      if (typing(e.target) && !s.always) return;
      e.preventDefault();
      if (!e.repeat || s.repeat !== false) s.run(e);
      return;
    }
  });
  // a clicked button keeps focus and would swallow Space / S: hand focus back to the page after clicks
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button, label.toggle');
    if (b && !b.closest('.menu')) setTimeout(() => document.activeElement?.blur?.(), 0);
  }, true);
}
