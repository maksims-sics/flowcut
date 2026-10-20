'use strict';
// The only bridge between the page and Node: window.flowcut. The page itself has no Node or file access.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function listen(channel) {
  return (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('flowcut', {
  info: call('app:info'),
  saveAppSettings: call('app:settings:save'),
  startupFile: call('app:startup-file'),
  toggleDevTools: call('app:toggle-devtools'),

  pickVideo: call('dialog:open-video'),
  chooseFolder: call('dialog:choose-folder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  reveal: call('shell:reveal'),
  openPath: call('shell:open'),
  recent: call('recent:list'),

  openProject: call('project:open'),
  levels: call('project:levels'),
  saveProject: call('project:save'),          // (id, { edits, gainEdits, splits })
  compute: call('cuts:compute'),              // (id, { edits, gainEdits }) -> { segments, gains, stats, level }
  transcript: call('transcript:get'),
  transcribe: call('transcribe:start'),
  render: call('render:start'),               // (id, { edits, gainEdits, render: { format, encoder } })
  makeProxy: call('proxy:make'),
  makeFast: call('fast:make'),
  cancelJob: call('job:cancel'),

  onJob: listen('job'),
  onOpenFile: listen('open-file'),
});
