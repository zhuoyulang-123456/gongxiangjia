/**
 * 共享夹 - 预加载脚本（P2P v2）
 * 把主进程能力安全地暴露给界面。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('gxj', {
  getState: () => ipcRenderer.invoke('get-state'),
  getFiles: () => ipcRenderer.invoke('get-files'),
  getPeers: () => ipcRenderer.invoke('get-peers'),
  topEntries: () => ipcRenderer.invoke('top-entries'),

  pair: (deviceId) => ipcRenderer.invoke('pair', deviceId),
  acceptPair: (deviceId) => ipcRenderer.invoke('accept-pair', deviceId),
  rejectPair: (deviceId) => ipcRenderer.invoke('reject-pair', deviceId),
  unpair: (deviceId) => ipcRenderer.invoke('unpair', deviceId),
  setPerm: (deviceId, perm) => ipcRenderer.invoke('set-perm', deviceId, perm),
  setScope: (deviceId, scope) => ipcRenderer.invoke('set-scope', deviceId, scope),

  makeLink: () => ipcRenderer.invoke('make-link'),
  pairLink: (text) => ipcRenderer.invoke('pair-link', text),

  openFolder: () => ipcRenderer.invoke('open-folder'),
  openFile: (rel) => ipcRenderer.invoke('open-file', rel),
  deleteFile: (rel) => ipcRenderer.invoke('delete-file', rel),
  addFiles: (paths) => ipcRenderer.invoke('add-files', paths),
  addFilesDialog: () => ipcRenderer.invoke('add-files-dialog'),
  saveFile: (rel, dest) => ipcRenderer.invoke('save-file', rel, dest),
  showInFolder: (rel) => ipcRenderer.invoke('show-in-folder', rel),
  startDrag: (rel) => ipcRenderer.send('start-drag', rel),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  listTrash: () => ipcRenderer.invoke('list-trash'),
  restoreTrash: (id) => ipcRenderer.invoke('restore-trash', id),
  deleteTrash: (id) => ipcRenderer.invoke('delete-trash', id),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),

  listVersions: (rel) => ipcRenderer.invoke('list-versions', rel),
  restoreVersion: (rel, id) => ipcRenderer.invoke('restore-version', rel, id),

  sendText: (text) => ipcRenderer.invoke('send-text', text),
  listTexts: () => ipcRenderer.invoke('list-texts'),
  sendClipboard: () => ipcRenderer.invoke('send-clipboard'),
  getWebUrl: () => ipcRenderer.invoke('web-url'),

  // 悬浮球
  ballAddFiles: (paths) => ipcRenderer.invoke('ball:add-files', paths),
  ballSendText: (text) => ipcRenderer.invoke('send-text', text),
  ballDragEnter: () => ipcRenderer.send('ball:drag-enter'),
  ballDragLeave: () => ipcRenderer.send('ball:drag-leave'),
  ballLog: (m) => ipcRenderer.send('ball:log', m),
  ballMenu: () => ipcRenderer.send('ball:menu'),
  ballStartDrag: (rel) => ipcRenderer.send('ball:start-drag', rel),
  ballToggle: () => ipcRenderer.invoke('ball:toggle'),
  ballState: () => ipcRenderer.invoke('ball:state'),
  onBallState: (cb) => ipcRenderer.on('ball:state', (_e, d) => cb(d)),
  ballDragStart: () => ipcRenderer.send('ball:drag-start'),
  ballDragTo: (dx, dy) => ipcRenderer.send('ball:drag-to', dx, dy),
  ballDragEnd: () => ipcRenderer.send('ball:drag-end'),
  lanList: () => ipcRenderer.invoke('lan-list'),
  lanSend: (id) => ipcRenderer.invoke('lan-send', id),
  ballOpen: () => ipcRenderer.invoke('ball:open'),
  ballCopy: (text) => ipcRenderer.invoke('ball:copy', text),
  ballOpenFile: (rel) => ipcRenderer.invoke('ball:open-file', rel),
  ballSendClipboard: () => ipcRenderer.invoke('ball:send-clipboard'),
  ballCopyFile: (rel) => ipcRenderer.invoke('copy-file', rel),
  copyFile: (rel) => ipcRenderer.invoke('copy-file', rel),
  addBinary: (name, data) => ipcRenderer.invoke('add-binary', name, data),
  ballDismiss: () => ipcRenderer.invoke('ball:dismiss'),
  ballGetLogin: () => ipcRenderer.invoke('ball:get-login'),
  ballSetLogin: (on) => ipcRenderer.invoke('ball:set-login', on),
  onBallEvent: (cb) => ipcRenderer.on('ball:set', (_e, d) => cb(d)),

  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return null; }
  },

  onPeerEvent: (cb) => ipcRenderer.on('peer-event', (_e, data) => cb(data)),
});
