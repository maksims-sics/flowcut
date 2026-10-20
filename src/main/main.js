'use strict';
// FlowCut main process: one window, no native menu (shortcuts live in the page), custom dark title bar.
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const { Store } = require('./store');
const { registerIpc } = require('./ipc');

app.setName('FlowCut');
// Windows groups the window under FlowCut (own taskbar icon) instead of under Electron
if (process.platform === 'win32') app.setAppUserModelId('ai.flowbyte.flowcut');
// Tests run with a throwaway profile so they never touch real projects or settings
if (process.env.FLOWCUT_USER_DATA) app.setPath('userData', process.env.FLOWCUT_USER_DATA);

const VIDEO_RE = /\.(mp4|mov|mkv|m4v|webm|avi|ts)$/i;
const fileFromArgs = (argv) => argv.find((a) => !a.startsWith('-') && VIDEO_RE.test(a)) || null;

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: 'FlowCut',
    backgroundColor: '#0d1218',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d1218', symbolColor: '#c3cad3', height: 44 },
    icon: process.platform === 'win32'
      ? path.join(__dirname, '..', '..', 'build', 'icon.ico')
      : path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // the sound runs through Web Audio (louder moments); it must never stay suspended waiting for a click
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // a file dropped outside the drop zone must not replace the app with a video page
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const file = fileFromArgs(argv);
    if (file) win.webContents.send('open-file', file);
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const store = new Store(app.getPath('userData'));
    const { jobs } = registerIpc({
      getWindow: () => win,
      store,
      startupFile: process.env.FLOWCUT_OPEN || fileFromArgs(process.argv.slice(1)),
    });
    app.on('before-quit', () => jobs.cancelAll());
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
