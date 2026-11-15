/**
 * 共享夹 - 电脑版 主进程（P2P v2）
 *
 * 无中心服务器：每台电脑就是一个节点，局域网发现 + 配对 + 端到端加密直连。
 */

const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage, clipboard, dialog, screen, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const httpMod = require('http');
const dgram = require('dgram');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const { PeerManager } = require('./peer');

const LOCAL_FOLDER_NAME = '共享夹';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let pm = null;
let folderPath = '';

// ---------------- 悬浮球状态 ----------------
let ballWin = null;
let ballCfg = { edge: 'right', t: 0.5, mode: 'hover' };
let ballMode = 'idle';          // idle | active | received
let ballHidden = true;
let ballSuppressUntil = 0;   // 手动收起后，短时间内不要被悬停又弹出来
let ballManualHidden = false; // 用按钮手动隐藏：不再自动弹
let ballNearAt = 0;
let ballAwayAt = 0;
let ballWatchTimer = null;
let ballSnapTimer = null;
let ballDoneTimer = null;
let ballReceivedTimer = null;
let ballHideTimer = null;
let ballFileDrag = false;
let ballSnapping = false;
let ballDragging = false;
let ballTransfer = null;
let ballSpeed = 0;
let ballLastSent = 0;
let ballLastAt = 0;
const BALL_SIZE = 240;

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

// ---------------- P2P 引擎 ----------------
function initPeer() {
  folderPath = process.env.GXJ_FOLDER || path.join(app.getPath('documents'), LOCAL_FOLDER_NAME);
  pm = new PeerManager({
    dataDir: process.env.GXJ_DATA_DIR || app.getPath('userData'),
    folder: folderPath,
    name: os.hostname() || '我的电脑',
    port: 0,
    discovery: process.env.GXJ_NO_DISCOVERY !== '1',
    discoveryPort: Number(process.env.GXJ_DISCOVERY_PORT) || undefined,
  });

  // 对象型事件
  const fwd = (name, type) => pm.on(name, (d) => send('peer-event', { type, ...(d || {}) }));
  fwd('peer-online', 'peer-online');
  fwd('peer-offline', 'peer-offline');
  fwd('file-added', 'file-added');
  fwd('transfer', 'transfer');
  fwd('transfer-error', 'error');
  pm.on('pair-request', (d) => {
    send('peer-event', { type: 'pair-request', ...(d || {}) });
    try { showMainWindow(); } catch (e) {}
    try {
      new Notification({
        title: '共享夹 · 连接请求',
        body: `${(d && d.name) || '一台设备'} 想和你连接，点开确认`,
      }).show();
    } catch (e) {}
  });
  fwd('pair-waiting', 'pair-waiting');
  fwd('pair-rejected', 'pair-rejected');
  fwd('conflict', 'conflict');
  fwd('scan', 'scan');

  // 数组型事件（不能展开，否则会变成 {0:..,1:..}）
  const fwdList = (name, type) => pm.on(name, (list) => send('peer-event', { type, list: list || [] }));
  fwdList('discovered', 'discovered');
  fwdList('manifest', 'manifest');
  fwdList('pending-changed', 'pending');
  pm.on('peers-status', (list) => send('peer-event', { type: 'peers', list }));
  pm.on('peers-changed', () => send('peer-event', { type: 'peers', list: pm.statusList(), pending: pm.listPending() }));

  pm.on('transfer', (d) => {
    if (!d || !d.total || d.instant) return;
    const now = Date.now();
    if (ballTransfer && ballTransfer.path === d.path && ballLastAt) {
      const dt = (now - ballLastAt) / 1000;
      if (dt > 0.05) {
        const inst = Math.max(0, (d.sent - ballLastSent) / dt);
        ballSpeed = ballSpeed ? ballSpeed * 0.6 + inst * 0.4 : inst;
      }
    } else {
      ballSpeed = 0;
    }
    ballLastAt = now;
    ballLastSent = d.sent;
    ballTransfer = d;
    if (ballMode === 'received') return;
    const pct = d.total ? Math.round((d.sent / d.total) * 100) : 0;
    setBallMode('active', { progress: pct, speed: ballSpeed, name: d.path });
    if (d.sent >= d.total) {
      if (ballDoneTimer) clearTimeout(ballDoneTimer);
      ballDoneTimer = setTimeout(() => {
        if (ballMode === 'active') { setBallMode('idle'); hideBall(); }
      }, 1400);
    }
  });

  pm.on('file-added', (d) => {
    logBall('file-added path=' + (d && d.path) + ' from=' + (d && d.from) + ' conflict=' + (d && d.conflict));
    if (d && d.from && d.from !== '本机') broadcastWeb();
    if (!d || !d.from || d.from === '本机' || d.conflict) return;
    if (String(d.path || '').startsWith('文字/')) {
      const t = readTextRel(d.path);
      setBallMode('received', { name: d.path, kind: 'text', text: t || '', progress: 100, speed: 0, hint: '点图标复制文字 · 点右侧打开' });
      reassertBall();
      return;
    }
    setBallMode('received', { name: d.path, kind: 'file', progress: 100, speed: 0, hint: '点图标复制 · 拖出去 · 点右侧打开' });
    reassertBall();
  });

  pm.on('manifest', () => broadcastWeb());

  pm.on('file-dup', (d) => {
    if (!d || !d.path) return;
    if (String(d.path).startsWith('文字/')) {
      const t = readTextRel(d.path);
      setBallMode('received', { name: d.path, kind: 'text', text: t || '', progress: 100, speed: 0, hint: '点图标复制文字 · 点右侧打开', dup: true });
      return;
    }
    // 对方发了内容相同的文件：也弹球，提示已在本地
    setBallMode('received', {
      name: d.path, progress: 100, speed: 0,
      hint: '已在共享夹里，可直接拖出去', kind: 'file',
    });
    send('peer-event', { type: 'file-dup', ...d });
  });

  pm.start().catch((e) => {
    console.error('P2P 启动失败:', e);
    send('peer-event', { type: 'error', message: '启动失败：' + e.message });
  });
}

function snapshotState() {
  if (!pm) return { deviceId: '', myCode: '', name: '', folderPath, peers: [], discovered: [], pending: [], waiting: [], files: [] };
  return {
    deviceId: pm.deviceId,
    myCode: pm.myCode(),
    name: pm.name,
    port: pm.port,
    folderPath,
    peers: pm.statusList(),
    discovered: pm.listDiscovered(),
    pending: pm.listPending(),
    waiting: [...pm.peers.keys()].filter((id) => pm.isWaiting(id)),
    files: pm.listFiles(),
    trashCount: pm.listTrash().length,
    topEntries: pm.topEntries(),
    linkSpeed: pm.bestSpeed(),
  };
}

// ---------------- 窗口 & 托盘 ----------------
function createWindow(silent = false) {
  mainWindow = new BrowserWindow({
    width: 860, height: 720, minWidth: 620, minHeight: 520,
    title: '共享夹',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    backgroundColor: '#F8FAFC',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    send('ball:state', { hidden: ballManualHidden, always: ballCfg.mode === 'always' });
  });
  if (!silent) mainWindow.show();
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(false);
  mainWindow.show();
  mainWindow.focus();
}

// ---------------- 悬浮球 ----------------
function ballCfgPath() { return path.join(app.getPath('userData'), 'ball.json'); }
function loadBallCfg() {
  try {
    const o = JSON.parse(fs.readFileSync(ballCfgPath(), 'utf8'));
    if (['left', 'right', 'top', 'bottom'].includes(o.edge)) {
      // cfgv<2 是旧版本，旧默认值是「只在拖拽时出现」，会让新默认值失效。
      // 迁移一次，之后用户自己在托盘里选的会正常保留。
      const mode = o.cfgv === 2 && ['drag', 'hover', 'always'].includes(o.mode) ? o.mode : 'hover';
      ballCfg = { edge: o.edge, t: Math.min(0.92, Math.max(0.08, Number(o.t) || 0.5)), mode, cfgv: 2 };
    }
  } catch (e) {}
  saveBallCfg();
}
function saveBallCfg() {
  try { fs.writeFileSync(ballCfgPath(), JSON.stringify({ ...ballCfg, cfgv: 2 })); } catch (e) {}
}

function ballDisplay() {
  if (ballWin && !ballWin.isDestroyed()) return screen.getDisplayMatching(ballWin.getBounds());
  return screen.getPrimaryDisplay();
}
function dockPoint() {
  // 用完整屏幕边界，让球真正贴在屏幕边上（workArea 会避开 Dock）
  const wa = ballDisplay().bounds;
  const t = ballCfg.t;
  if (ballCfg.edge === 'left') return { x: wa.x, y: wa.y + wa.height * t };
  if (ballCfg.edge === 'right') return { x: wa.x + wa.width, y: wa.y + wa.height * t };
  if (ballCfg.edge === 'top') return { x: wa.x + wa.width * t, y: wa.y };
  return { x: wa.x + wa.width * t, y: wa.y + wa.height };
}
function ballInward() {
  return ballMode === 'idle' ? 0 : 14;
}
function ballSize() {
  const vertical = ballCfg.edge === 'left' || ballCfg.edge === 'right';
  if (ballMode === 'idle') return vertical ? { w: 100, h: 200 } : { w: 200, h: 100 };
  if (ballMode === 'active') return { w: 160, h: 200 };
  return vertical ? { w: 300, h: 150 } : { w: 300, h: 164 };
}
function ballCenter() {
  const p = dockPoint();
  return { x: p.x, y: p.y };
}
function positionBall() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const b = ballDisplay().bounds;
  const p = dockPoint();
  const { w, h } = ballSize();
  const pad = ballInward();
  let x;
  let y;
  if (ballCfg.edge === 'left') { x = b.x + pad; y = p.y - h / 2; }
  else if (ballCfg.edge === 'right') { x = b.x + b.width - w - pad; y = p.y - h / 2; }
  else if (ballCfg.edge === 'top') { x = p.x - w / 2; y = b.y + pad; }
  else { x = p.x - w / 2; y = b.y + b.height - h - pad; }
  ballSnapping = true;
  ballWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  setTimeout(() => { ballSnapping = false; }, 260);
}

function setBallPref(mode) {
  ballCfg.mode = mode;
  saveBallCfg();
  if (mode === 'always') { setBallMode('idle'); showBall(); }
  else if (mode === 'drag') { setBallMode('idle'); hideBall(); }
  else { setBallMode('idle'); }
  refreshTray();
}

// Windows 的分层窗口在 alpha=0 时会把鼠标/拖拽整块穿透，导致隐藏时收不到文件。
// 保留约 1% 不透明度：肉眼几乎不可见，但仍然是可投放的实体窗口。
function ballHiddenOpacity() {
  // Windows 的分层窗口在 alpha=0 时整块穿透；页面里用 1% 的"接收垫"保持可投放，
  // 所以窗口本身保持 1，只有 macOS 才用 0 隐藏。
  return process.platform === 'win32' ? 1 : 0;
}

function logBall(m) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'ball-debug.log'), new Date().toISOString() + ' ' + String(m) + '\n'); } catch (e) {}
}

function sendBall(d) {
  if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('ball:set', { win: process.platform === 'win32', ...d });
}
function showBall() {
  if (!ballWin || ballWin.isDestroyed()) return;
  if (!ballHidden) { sendBall({ visible: true }); return; }
  ballHidden = false;
  if (!ballWin.isVisible()) ballWin.showInactive();
  ballWin.moveTop();
  ballWin.setOpacity(1);
  logBall('ball show mode=' + ballMode + ' bounds=' + JSON.stringify(ballWin.getBounds()));
  sendBall({ visible: true, mode: ballMode, edge: ballCfg.edge });
}
function hideBall() {
  if (!ballWin || ballHidden) return;
  logBall('ball hide mode=' + ballMode);
  ballHidden = true;
  sendBall({ visible: false });
  setTimeout(() => {
    if (!ballHidden || ballMode !== 'idle') return;
    ballWin.setOpacity(ballHiddenOpacity());
  }, 280);
}
function setBallMode(mode, extra = {}) {
  ballMode = mode;
  if (mode !== 'idle') showBall();
  sendBall({ mode, edge: ballCfg.edge, ...extra });
  positionBall();
  if (mode === 'received') {
    if (ballReceivedTimer) clearTimeout(ballReceivedTimer);
    ballReceivedTimer = setTimeout(() => {
      if (ballMode === 'received') { setBallMode('idle'); hideBall(); }
    }, 40000);
  }
}

// 收到东西后，再确认两次「确实显示着」——防止某次收尾定时器把球又收起
function reassertBall() {
  [400, 1400].forEach((ms) => setTimeout(() => {
    if (!ballWin || ballWin.isDestroyed()) return;
    if (ballMode !== 'received') return;
    if (ballHidden) { showBall(); return; }
    sendBall({ visible: true, mode: 'received', edge: ballCfg.edge });
    try { ballWin.moveTop(); } catch (e) {}
  }, ms));
}

function startBallWatcher() {
  if (ballWatchTimer) clearInterval(ballWatchTimer);
  ballWatchTimer = setInterval(() => {
    if (!ballWin || ballWin.isDestroyed()) return;
    if (process.env.GXJ_BALL_ALWAYS === '1') {
      if (ballHidden && ballMode === 'idle') showBall();
      return;
    }
    if (ballMode !== 'idle' || ballDragging) return;
    if (ballFileDrag) { if (ballHidden) showBall(); return; }
    // 始终显示：平时就露着小半圆
    if (ballCfg.mode === 'always') { if (ballHidden) showBall(); return; }
    // 默认只响应拖拽；只有「鼠标停留」模式才按悬停显示
    if (ballCfg.mode !== 'hover') { if (!ballHidden) hideBall(); return; }
    const pt = screen.getCursorScreenPoint();
    const c = dockPoint();
    const b = ballDisplay().bounds;
    const now = Date.now();
    const edge = ballCfg.edge;
    // 到球所在那条屏幕边的距离
    let edgeDist;
    if (edge === 'left') edgeDist = pt.x - b.x;
    else if (edge === 'right') edgeDist = (b.x + b.width) - pt.x;
    else if (edge === 'top') edgeDist = pt.y - b.y;
    else edgeDist = (b.y + b.height) - pt.y;
    // 沿着这条边的位置偏差（球现在停在哪一段）
    const along = (edge === 'left' || edge === 'right') ? Math.abs(pt.y - c.y) : Math.abs(pt.x - c.x);
    const atEdge = edgeDist <= 10 && along <= 320;      // 鼠标贴边打转
    const nearDot = Math.hypot(pt.x - c.x, pt.y - c.y) < 90; // 停在球附近
    if (atEdge || nearDot) {
      ballAwayAt = 0;
      if (ballManualHidden) return;
      if (now < ballSuppressUntil) return;   // 刚手动收起，先别弹
      if (!ballNearAt) ballNearAt = now;
      // 贴边 400ms 就浮现；停在球附近稍慢一点，避免误触
      if (ballHidden && now - ballNearAt >= (atEdge ? 400 : 900)) showBall();
    } else {
      ballNearAt = 0;
      ballSuppressUntil = 0;
      if (!ballHidden) {
        if (!ballAwayAt) ballAwayAt = now;
        if (now - ballAwayAt > 600) hideBall();
      }
    }
  }, 120);
}

function scheduleSnap() {
  if (ballSnapping) return;
  ballDragging = true;
  if (ballSnapTimer) clearTimeout(ballSnapTimer);
  ballSnapTimer = setTimeout(() => { ballDragging = false; snapBall(); }, 480);
}
function snapBall() {
  if (!ballWin || ballWin.isDestroyed()) return;
  const b = ballWin.getBounds();
  const wa = screen.getDisplayMatching(b).bounds;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const dl = cx - wa.x;
  const dr = wa.x + wa.width - cx;
  const dt = cy - wa.y;
  const db = wa.y + wa.height - cy;
  const m = Math.min(dl, dr, dt, db);
  const edge = m === dl ? 'left' : m === dr ? 'right' : m === dt ? 'top' : 'bottom';
  const t = (edge === 'left' || edge === 'right')
    ? (cy - wa.y) / wa.height
    : (cx - wa.x) / wa.width;
  ballCfg = { edge, t: Math.min(0.92, Math.max(0.08, t)) };
  saveBallCfg();
  positionBall();
  sendBall({ edge, mode: ballMode });
}

function createBallWindow() {
  if (ballWin && !ballWin.isDestroyed()) return;
  loadBallCfg();
  ballWin = new BrowserWindow({
    width: BALL_SIZE,
    height: BALL_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  ballWin.setAlwaysOnTop(true, 'floating');
  ballWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ballWin.loadFile(path.join(__dirname, 'renderer', 'ball.html'));
  ballWin.webContents.on('did-finish-load', () => {
    positionBall();
    logBall('ball loaded bounds=' + JSON.stringify(ballWin.getBounds()) + ' visible=' + ballWin.isVisible());
    ballWin.showInactive();
    if (ballHidden && ballMode === 'idle') {
      ballWin.setOpacity(ballHiddenOpacity());
    } else {
      ballWin.setOpacity(1);
    }
    sendBall({ visible: !ballHidden, mode: ballMode, edge: ballCfg.edge });
  });
  ballWin.on('move', () => scheduleSnap());
  ballWin.on('closed', () => { ballWin = null; logBall('ball closed'); });
  logBall('ball created bounds=' + JSON.stringify(ballWin.getBounds()) + ' display=' + JSON.stringify(ballDisplay().bounds));
}

function makeTrayIcon() {
  // 用真实彩色图标：原来的黑色 template 位图只对 macOS 菜单栏有效，
  // 在 Windows 任务栏上是一团黑，等于看不见。
  try {
    const p = path.join(__dirname, 'assets', 'app-icon.png');
    const size = process.platform === 'darwin' ? 18 : 32;
    const img = nativeImage.createFromPath(p).resize({ width: size, height: size });
    if (!img.isEmpty()) {
      if (process.platform === 'darwin') img.setTemplateImage(false);
      return img;
    }
  } catch (e) {}
  const S = 44;
  const buf = Buffer.alloc(S * S * 4);
  const inside = (x, y) => {
    if (x >= 6 && x <= 22 && y >= 10 && y <= 16) return true;
    const x0 = 6, y0 = 15, x1 = 38, y1 = 34, r = 4;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    const on = inside(x, y);
    buf[o] = 59; buf[o + 1] = 130; buf[o + 2] = 246; buf[o + 3] = on ? 255 : 0;
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开共享夹', click: () => showMainWindow() },
    { label: '打开文件夹', click: () => shell.openPath(folderPath) },
    { label: '显示悬浮球', click: () => { setBallMode('idle'); showBall(); } },
    { label: '发送剪贴板文字', accelerator: 'CmdOrCtrl+Alt+S', click: () => sendClipboard() },
    {
      label: '悬浮球出现方式',
      submenu: [
        { label: '鼠标停留时出现（默认）', type: 'radio', checked: ballCfg.mode === 'hover', click: () => setBallPref('hover') },
        { label: '拖动文件时出现', type: 'radio', checked: ballCfg.mode === 'drag', click: () => setBallPref('drag') },
        { label: '始终显示', type: 'radio', checked: ballCfg.mode === 'always', click: () => setBallPref('always') },
      ],
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    {
      label: '发送到其他设备',
      submenu: (() => {
        const items = [...lanPeers.values()].map((p) => ({
          label: `${p.kind === 'phone' ? '📱' : '💻'} ${p.name}`,
          click: async () => {
            const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], title: '选择要发送的文件' });
            if (r.canceled || !r.filePaths.length) return;
            let ok = 0;
            for (const f of r.filePaths) if (await sendFileToPeer(p, f)) ok++;
            dialog.showMessageBox({ message: ok === r.filePaths.length ? '已发送 ' + ok + ' 个文件' : `发送了 ${ok}/${r.filePaths.length}` });
          },
        }));
        return items.length ? items : [{ label: '附近没有其他设备', enabled: false }];
      })(),
    },
    { type: 'separator' },
    { label: '退出共享夹', click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('共享夹');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

// ---------------- IPC ----------------
ipcMain.handle('get-state', () => snapshotState());
ipcMain.handle('get-files', () => ({ ok: true, files: pm ? pm.listFiles() : [] }));
ipcMain.handle('get-peers', () => ({
  peers: pm ? pm.statusList() : [],
  discovered: pm ? pm.listDiscovered() : [],
  pending: pm ? pm.listPending() : [],
  waiting: pm ? [...pm.peers.keys()].filter((id) => pm.isWaiting(id)) : [],
}));

ipcMain.handle('pair', (_e, deviceId) => {
  if (!pm) return { ok: false, message: '还没准备好' };
  const d = pm.discovered.get(deviceId);
  if (!d) return { ok: false, message: '对方设备已不在线，请确认它开着共享夹、在同一网络' };
  pm.pair(deviceId, d.address, d.port);
  return { ok: true };
});

ipcMain.handle('accept-pair', (_e, deviceId) => {
  if (!pm) return { ok: false, message: '还没准备好' };
  return pm.acceptPair(deviceId) ? { ok: true } : { ok: false, message: '请求已失效，请重新配对' };
});

ipcMain.handle('reject-pair', (_e, deviceId) => { if (pm) pm.rejectPair(deviceId); return { ok: true }; });
ipcMain.handle('unpair', (_e, deviceId) => { if (pm) pm.unpair(deviceId); return { ok: true }; });
ipcMain.handle('set-perm', (_e, deviceId, perm) => ({ ok: !!(pm && pm.setPerm(deviceId, perm)) }));
ipcMain.handle('set-scope', (_e, deviceId, scope) => ({ ok: !!(pm && pm.setScope(deviceId, scope)) }));
ipcMain.handle('top-entries', () => ({ entries: pm ? pm.topEntries() : [] }));

ipcMain.handle('make-link', () => {
  if (!pm) return { ok: false };
  const link = pm.makeLink();
  clipboard.writeText(link);
  return { ok: true, link, code: pm.myCode() };
});

ipcMain.handle('pair-link', (_e, text) => {
  if (!pm) return { ok: false, message: '还没准备好' };
  const info = pm.parseLink(text);
  if (!info) return { ok: false, message: '链接格式不对，请确认复制完整' };
  if (info.deviceId === pm.deviceId) return { ok: false, message: '这是你自己的配对链接' };
  pm.pair(info.deviceId, info.address, info.port, { signPub: info.signPub });
  return { ok: true, name: info.name };
});

ipcMain.handle('open-folder', () => { shell.openPath(folderPath); return { ok: true }; });

ipcMain.handle('open-file', (_e, rel) => {
  const p = path.join(folderPath, String(rel).split('/').join(path.sep));
  if (fs.existsSync(p)) { shell.openPath(p); return { ok: true }; }
  return { ok: false, message: '文件不存在' };
});

ipcMain.handle('delete-file', (_e, rel) => {
  if (!pm) return { ok: false, message: '还没准备好' };
  const done = pm.deleteFile(rel);
  return done ? { ok: true } : { ok: false, message: '删除失败（文件可能已不存在）' };
});

function sameContent(a, b) {
  return new Promise((resolve) => {
    try {
      const sa = fs.statSync(a);
      const sb = fs.statSync(b);
      if (sa.size !== sb.size) return resolve(false);
      const ha = crypto.createHash('sha256');
      const hb = crypto.createHash('sha256');
      const ra = fs.createReadStream(a);
      const rb = fs.createReadStream(b);
      ra.on('data', (d) => ha.update(d));
      rb.on('data', (d) => hb.update(d));
      let done = 0;
      const finish = () => { if (++done === 2) resolve(ha.digest('hex') === hb.digest('hex')); };
      ra.on('end', finish);
      rb.on('end', finish);
      ra.on('error', () => resolve(false));
      rb.on('error', () => resolve(false));
    } catch (e) { resolve(false); }
  });
}

async function addFilesToFolder(paths) {
  const results = [];
  for (const p of paths || []) {
    const name = path.basename(p);
    const dest = path.join(folderPath, name);
    if (fs.existsSync(dest)) {
      const same = await sameContent(p, dest);
      if (same) {
        // 内容相同：算作「再发一次」，通知对端弹球/提示
        if (pm) pm.advertise(name);
        results.push({ name, ok: true, duplicate: true });
      } else if (pm && pm.replaceFile(name, p)) {
        // 同名但内容不同：当作「更新」覆盖，旧内容自动进版本历史
        results.push({ name, ok: true, updated: true });
      } else {
        try { fs.copyFileSync(p, dest); results.push({ name, ok: true, updated: true }); }
        catch (e) { results.push({ name, ok: false, message: e.message }); }
      }
      continue;
    }
    try { fs.copyFileSync(p, dest); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, message: e.message }); }
  }
  return { ok: true, results };
}

ipcMain.handle('add-files', (_e, paths) => addFilesToFolder(paths));

// 从任意文件夹选择文件放进来
ipcMain.handle('add-files-dialog', async () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  const r = await dialog.showOpenDialog(win, {
    title: '选择要放进共享夹的文件',
    buttonLabel: '放进共享夹',
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  return addFilesToFolder(r.filePaths);
});

// 保存副本到别处
ipcMain.handle('save-file', async (e, rel, destPath) => {
  const src = path.join(folderPath, String(rel).split('/').join(path.sep));
  if (!fs.existsSync(src)) return { ok: false, message: '文件不存在' };
  let target = destPath;
  if (!target) {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    const r = await dialog.showSaveDialog(win, {
      title: '保存副本',
      buttonLabel: '保存',
      defaultPath: path.basename(String(rel)),
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    target = r.filePath;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    return { ok: true, path: target };
  } catch (err) { return { ok: false, message: err.message }; }
});

ipcMain.handle('show-in-folder', (_e, rel) => {
  const abs = path.join(folderPath, String(rel).split('/').join(path.sep));
  if (!fs.existsSync(abs)) return { ok: false, message: '文件不存在' };
  shell.showItemInFolder(abs);
  return { ok: true };
});

// 从窗口里把文件拖到 Finder / 资源管理器
let dragIconCache = null;
function dragIcon() {
  if (dragIconCache) return dragIconCache;
  try {
    // 打包后资源在 asar 里，用 fs 读（Electron 的 fs 支持 asar）再建图，避免拿到空图
    const buf = fs.readFileSync(path.join(__dirname, 'assets', 'drag-icon.png'));
    dragIconCache = nativeImage.createFromBuffer(buf).resize({ width: 64, height: 64 });
  } catch (e) { dragIconCache = nativeImage.createEmpty(); }
  return dragIconCache;
}
ipcMain.on('start-drag', (e, rel) => {
  try {
    const abs = path.join(folderPath, String(rel).split('/').join(path.sep));
    if (!fs.existsSync(abs)) return;
    e.sender.startDrag({ file: abs, icon: dragIcon() });
  } catch (err) { /* 忽略拖拽失败 */ }
});

ipcMain.handle('copy-text', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });

// ---------------- 复制文件到剪贴板 ----------------
let winClipHelper = null;

// Windows：剪贴板数据归进程所有，设置完就退会被清空。
// 所以起一个隐藏的常驻 PowerShell 持有它，下次复制时替换掉旧的。
function setWindowsClipboardFile(abs) {
  return new Promise((resolve) => {
    try {
      if (winClipHelper) { try { winClipHelper.kill(); } catch (e) {} winClipHelper = null; }
      const dir = app.getPath('userData');
      const scriptPath = path.join(dir, 'clip-helper.ps1');
      const donePath = path.join(dir, 'clip-done.txt');
      const logPath = path.join(dir, 'clip-helper.log');
      try { fs.unlinkSync(donePath); } catch (e) {}
      // 脚本必须是纯 ASCII：PowerShell 5 读无 BOM 文件按 ANSI 解码，中文路径会乱码。
      const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64');
      const lines = [
        '$ErrorActionPreference = "Continue"',
        "$p = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64(abs) + "'))",
        "$d = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64(donePath) + "'))",
        '$o = New-Object System.Collections.ArrayList',
        'function Note([string]$t) { [void]$o.Add($t) }',
        'try {',
        '  Set-Clipboard -Path $p',
        '  Note "SET=ok"',
        '} catch { Note ("E1=" + $_.Exception.Message) }',
        'try {',
        '  $l = @(Get-Clipboard -Format FileDropList)',
        '  Note ("COUNT=" + $l.Count)',
        '  if ($l.Count -gt 0) { Note ("P=" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$l[0]))) }',
        '} catch { Note ("E2=" + $_.Exception.Message) }',
        'Set-Content -LiteralPath $d -Value ($o -join "|") -Encoding ASCII',
        'Start-Sleep -Seconds 3600',
      ];
      fs.writeFileSync(scriptPath, lines.join('\r\n'), 'ascii');
      const fd = fs.openSync(logPath, 'w');
      const child = spawn('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      winClipHelper = child;
      child.on('exit', () => { if (winClipHelper === child) winClipHelper = null; });
      child.on('error', (e) => logBall('clip helper spawn err ' + e.message));
      setTimeout(() => {
        let raw = '';
        try { raw = fs.readFileSync(donePath, 'utf8').trim(); } catch (e) {}
        const get = (k) => {
          const m = new RegExp('(?:^|\\|)' + k + '=([^|]*)').exec(raw);
          return m ? m[1] : '';
        };
        let back = '';
        try { back = Buffer.from(get('P'), 'base64').toString('utf8'); } catch (e) {}
        const count = Number(get('COUNT') || 0);
        const norm = (x) => String(x).replace(/[\\/]+/g, '\\').toLowerCase();
        const same = count >= 1 && back && norm(back) === norm(abs);
        logBall('clip diag raw=' + raw + ' same=' + same);
        if (same) return resolve({ ok: true, mode: 'file' });
        try { child.kill(); } catch (e) {}
        winClipHelper = null;
        resolve({ ok: false, message: raw || 'clipboard write failed' });
      }, 1600);
    } catch (e) {
      logBall('clip helper error ' + e.message);
      resolve({ ok: false, message: e.message });
    }
  });
}

function copyFileToClipboard(abs) {
  return new Promise((resolve) => {
    const fallback = () => {
      try { clipboard.writeText(abs); resolve({ ok: true, mode: 'path' }); }
      catch (e) { resolve({ ok: false, message: '复制失败' }); }
    };
    const handle = (err, stdout, stderr) => {
      logBall('copy-file ' + abs + ' err=' + (err ? err.message : 'none') + ' stderr=' + String(stderr || '').slice(0, 160));
      if (err) return fallback();
      resolve({ ok: true, mode: 'file' });
    };
    try {
      if (process.platform === 'darwin') {
        // AppleScript 把文件引用放进剪贴板，Finder / 微信 / 文档都能粘贴
        const script = 'set the clipboard to (POSIX file ' + JSON.stringify(abs) + ')';
        execFile('osascript', ['-e', script], handle);
      } else if (process.platform === 'win32') {
        logBall('copy-file win helper ' + abs);
        setWindowsClipboardFile(abs).then((r) => resolve(r.ok ? r : fallback()));
      } else {
        const safe = abs.replace(/'/g, "'\\''");
        const cmd = "printf '%s' 'file://" + safe + "' | xclip -selection clipboard -t text/uri-list"
          + " 2>/dev/null || printf '%s' '" + safe + "' | xclip -selection clipboard 2>/dev/null";
        execFile('sh', ['-c', cmd], handle);
      }
    } catch (e) { fallback(); }
  });
}

ipcMain.handle('copy-file', async (_e, rel) => {
  const abs = path.join(folderPath, String(rel || '').split('/').join(path.sep));
  if (!fs.existsSync(abs)) return { ok: false, message: '文件不存在' };
  return copyFileToClipboard(abs);
});

// ---------------- 局域网发现（手机/平板/电脑互联） ----------------
const lanPeers = new Map();
let lanSock = null;

function lanAnnounce() {
  if (!lanSock || !webPort || !pm) return;
  try {
    const payload = Buffer.from(JSON.stringify({
      gxj: '1', id: pm.deviceId, name: pm.name, kind: 'desktop', port: webPort, token: webToken,
    }));
    lanSock.send(payload, 0, payload.length, 8795, '255.255.255.255');
  } catch (e) {}
}

function startLanDiscovery() {
  if (lanSock) return;
  try {
    lanSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    lanSock.on('error', () => {});
    lanSock.on('message', (buf, rinfo) => {
      try {
        const o = JSON.parse(buf.toString('utf8'));
        if (o.gxj !== '1' || !o.id || o.id === pm.deviceId) return;
        const isNew = !lanPeers.has(o.id);
        lanPeers.set(o.id, {
          id: o.id, name: String(o.name || '设备'), kind: o.kind || 'device',
          host: rinfo.address, port: Number(o.port) || 8790, token: String(o.token || ''), seen: Date.now(),
        });
        if (isNew) {
          logBall('lan peer found ' + o.name + ' ' + rinfo.address + ':' + (o.port || 0) + ' token=' + (o.token || ''));
          // 回一条，让对方也发现我
          lanAnnounce();
          refreshTray();
        }
      } catch (e) {}
    });
    lanSock.bind(8795, () => {
      try { lanSock.setBroadcast(true); } catch (e) {}
      lanAnnounce();
      setInterval(lanAnnounce, 3000);
      setInterval(() => {
        const now = Date.now();
        let changed = false;
        for (const [id, p] of lanPeers) {
          if (now - p.seen > 15000) { lanPeers.delete(id); changed = true; }
        }
        if (changed) refreshTray();
      }, 5000);
    });
  } catch (e) { logBall('lan discovery err ' + e.message); }
}

function sendFileToPeer(peer, file) {
  return new Promise((resolve) => {
    try {
      const name = encodeURIComponent(require('path').basename(file));
      const req = httpMod.request({
        host: peer.host,
        port: peer.port,
        path: `/api/upload?name=${name}&t=${encodeURIComponent(peer.token)}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size },
        timeout: 120000,
      }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      fs.createReadStream(file).pipe(req);
    } catch (e) { resolve(false); }
  });
}

// ---------------- 手机网页版 ----------------
let webServer = null;
let webPort = 0;
let webToken = '';

function ensureWebToken() {
  const p = path.join(app.getPath('userData'), 'web.json');
  try {
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (o.token) { webToken = o.token; return; }
  } catch (e) {}
  webToken = crypto.randomBytes(12).toString('hex');
  try { fs.writeFileSync(p, JSON.stringify({ token: webToken })); } catch (e) {}
}

function webUrl() {
  if (!pm || !webPort) return '';
  return `http://${pm.lanAddress()}:${webPort}/m?t=${webToken}`;
}

function safeRelPath(p) {
  const rel = String(p || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  if (parts[0].startsWith('.')) return null;
  return parts.join('/');
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, file, type) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'web', file));
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) { res.writeHead(404); res.end('not found'); }
}

const webClients = new Set();

function webStatePayload() {
  return {
    name: pm ? pm.name : '',
    code: pm ? pm.myCode() : '',
    files: pm ? pm.listFiles().filter((f) => !f.path.startsWith('文字/')) : [],
    texts: listTextFiles(20).map((x) => ({ name: x.name, path: x.path, mtime: x.mtime, text: x.text })),
    peers: pm ? pm.statusList().filter((p) => p.online).length : 0,
    devices: pm ? pm.statusList().filter((p) => p.online).map((p) => p.name) : [],
  };
}

/** 主动推给手机网页 / 安卓悬浮球 */
function broadcastWeb() {
  if (!webClients.size) return;
  const payload = 'data: ' + JSON.stringify(webStatePayload()) + '\n\n';
  for (const res of [...webClients]) {
    try { res.write(payload); } catch (e) { webClients.delete(res); }
  }
}

function handleWeb(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const token = u.searchParams.get('t') || '';
  // 静态资源不校验令牌（不含数据），API 必须带令牌
  const isStatic = p === '/m' || p === '/m/' || p === '/' ||
    p === '/m/style.css' || p === '/m/app.js' || p === '/m/icon.png' || p === '/m/manifest.json';
  if (!isStatic && (!webToken || token !== webToken)) {
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('令牌无效，请重新从电脑上复制链接');
    return;
  }

  if (p === '/m' || p === '/m/' || p === '/') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  if (p === '/m/style.css') return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
  if (p === '/m/app.js') return serveStatic(res, 'app.js', 'application/javascript; charset=utf-8');
  if (p === '/m/icon.png') return serveStatic(res, 'icon.png', 'image/png');
  if (p === '/m/manifest.json') {
    const mf = {
      name: '共享夹', short_name: '共享夹',
      start_url: '/m?t=' + webToken,
      display: 'standalone',
      background_color: '#F5F7FB',
      theme_color: '#2563EB',
      icons: [{ src: '/m/icon.png', sizes: '512x512', type: 'image/png' }],
    };
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify(mf));
    return;
  }

  if (p === '/api/state') {
    return sendJSON(res, 200, webStatePayload());
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    webClients.add(res);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    const bye = () => { clearInterval(beat); webClients.delete(res); };
    req.on('close', bye);
    req.on('error', bye);
    try { res.write('data: ' + JSON.stringify(webStatePayload()) + '\n\n'); } catch (e) {}
    return;
  }

  if (p === '/api/file') {
    const rel = safeRelPath(u.searchParams.get('p'));
    if (!rel) { res.writeHead(400); res.end('bad path'); return; }
    const abs = path.join(folderPath, rel.split('/').join(path.sep));
    let st;
    try { st = fs.statSync(abs); } catch (e) { res.writeHead(404); res.end('not found'); return; }
    const type = 'application/octet-stream';
    const name = encodeURIComponent(path.basename(abs));
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const rel = safeRelPath(u.searchParams.get('name'));
    if (!rel) { sendJSON(res, 400, { ok: false, message: '文件名不合法' }); return; }
    const base = path.posix.basename(rel);
    const dir = path.posix.dirname(rel);
    let target = rel;
    let n = 1;
    while (fs.existsSync(path.join(folderPath, target.split('/').join(path.sep)))) {
      const ext = path.posix.extname(base);
      const stem = ext ? base.slice(0, -ext.length) : base;
      const next = `${stem} (${n})${ext}`;
      target = dir === '.' ? next : `${dir}/${next}`;
      n++;
    }
    const abs = path.join(folderPath, target.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.gxj-upload-' + crypto.randomBytes(3).toString('hex');
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => {
      try {
        // 内容和已有的完全一样就不再存一份、也不弹球
        let dupOf = null;
        try {
          const h = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
          for (const [rel, ent] of pm ? pm.manifest.entries() : []) {
            if (ent.hash === h) { dupOf = rel; break; }
          }
        } catch (e) {}
        if (dupOf) {
          try { fs.unlinkSync(tmp); } catch (e) {}
          sendJSON(res, 200, { ok: true, name: dupOf, duplicated: true });
          return;
        }
        fs.renameSync(tmp, abs);
        sendJSON(res, 200, { ok: true, name: target });
        logBall('upload received ' + target);
        // 手机/平板直接传过来的：立刻弹「收到」卡片（不然只看到 100% 的传输条）
        try {
          const size = fs.statSync(abs).size;
          setBallMode('received', {
            name: target, kind: 'file', progress: 100, speed: 0,
            hint: '来自手机 · 点图标复制，拖出去',
          });
          send('peer-event', { type: 'file-added', path: target, size, from: '手机' });
        } catch (e) {}
      }
      catch (e) { try { fs.unlinkSync(tmp); } catch (er) {} sendJSON(res, 500, { ok: false, message: e.message }); }
    });
    out.on('error', (e) => sendJSON(res, 500, { ok: false, message: e.message }));
    return;
  }

  if (p === '/api/text' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      const r = saveText(body);
      sendJSON(res, r.ok ? 200 : 400, r);
      if (r && r.ok) {
        try {
          setBallMode('received', {
            name: r.name || '文字', kind: 'text', text: body, progress: 100, speed: 0,
            hint: '来自手机 · 点图标复制文字',
          });
          send('peer-event', { type: 'file-added', path: '文字/' + (r.name || ''), from: '手机' });
        } catch (e) {}
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
}

function startWebServer() {
  ensureWebToken();
  if (webServer) return;
  webServer = httpMod.createServer((req, res) => {
    try { handleWeb(req, res); } catch (e) { try { res.writeHead(500); res.end('err'); } catch (er) {} }
  });
  // 固定端口，方便手机「添加到主屏幕」后地址不变；被占用时退回随机端口
  webServer.once('error', () => {
    try {
      webServer.close();
      webServer = httpMod.createServer((req, res) => {
        try { handleWeb(req, res); } catch (e) { try { res.writeHead(500); res.end('err'); } catch (er) {} }
      });
      webServer.listen(0, '0.0.0.0', () => { webPort = webServer.address().port; });
    } catch (e) {}
  });
  webServer.listen(8789, '0.0.0.0', () => { webPort = 8789; });
}

// ---------------- 文字快传 ----------------
function textDir() { return path.join(folderPath, '文字'); }

function readTextRel(rel) {
  try {
    const abs = path.join(folderPath, String(rel).split('/').join(path.sep));
    const st = fs.statSync(abs);
    if (st.size > 200000) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch (e) { return ''; }
}

function cleanText(t) {
  return String(t || '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').slice(0, 200000);
}

function saveText(text) {
  setTimeout(() => { try { broadcastWeb(); } catch (e) {} }, 60);
  const t = cleanText(text).trim();
  if (!t) return { ok: false, message: '内容为空' };
  try {
    fs.mkdirSync(textDir(), { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const name = `文字 ${stamp}.txt`;
    fs.writeFileSync(path.join(textDir(), name), t, 'utf8');
    return { ok: true, name, path: '文字/' + name };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function listTextFiles(limit = 30) {
  const dir = textDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const files = names
    .filter((n) => n.endsWith('.txt') && !n.startsWith('.'))
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        return { name: n, size: st.size, mtime: st.mtimeMs, full };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  return files.map((f) => {
    let text = '';
    try { text = fs.readFileSync(f.full, 'utf8').slice(0, 20000); } catch (e) {}
    return { name: f.name, path: '文字/' + f.name, size: f.size, mtime: f.mtime, text };
  });
}

function notify(body) {
  try { new Notification({ title: '共享夹', body }).show(); } catch (e) {}
}

function sendClipboard() {
  let text = '';
  try { text = clipboard.readText(); } catch (e) {}
  if (!text || !String(text).trim()) return { ok: false, message: '剪贴板里没有文字' };
  const r = saveText(text);
  if (r.ok) notify('文字已发送');
  return r;
}

ipcMain.handle('add-binary', async (_e, name, data) => {
  try {
    const safe = String(name || '粘贴图片.png').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    let target = safe;
    let n = 1;
    const ext = path.posix.extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    while (fs.existsSync(path.join(folderPath, target))) { target = `${stem} (${n})${ext}`; n++; }
    fs.writeFileSync(path.join(folderPath, target), Buffer.from(data));
    return { ok: true, name: target };
  } catch (e) { return { ok: false, message: e.message }; }
});

ipcMain.handle('send-text', (_e, text) => saveText(text));
ipcMain.handle('web-url', () => ({ url: webUrl(), port: webPort }));
ipcMain.handle('send-clipboard', () => sendClipboard());
ipcMain.on('ball:menu', () => {
  if (!ballWin) return;
  Menu.buildFromTemplate([
    { label: '发送剪贴板文字  ⌘⌥S', click: () => sendClipboard() },
    { label: '打开共享夹', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '收起悬浮球', click: () => { setBallMode('idle'); hideBall(); } },
  ]).popup({ window: ballWin });
});
ipcMain.handle('list-texts', () => ({ items: listTextFiles() }));

// ---------------- 悬浮球 IPC ----------------
ipcMain.handle('ball:add-files', (_e, paths) => addFilesToFolder(paths));
ipcMain.on('ball:log', (_e, m) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'ball-debug.log'), new Date().toISOString() + ' ' + String(m) + '\n'); } catch (err) {}
});
let ballDragOrigin = null;
ipcMain.on('ball:drag-start', () => {
  if (!ballWin || ballWin.isDestroyed()) return;
  const b = ballWin.getBounds();
  ballDragOrigin = { x: b.x, y: b.y, w: b.width, h: b.height };
  ballDragging = true;
});
ipcMain.on('ball:drag-to', (_e, dx, dy) => {
  if (!ballWin || ballWin.isDestroyed() || !ballDragOrigin) return;
  ballWin.setBounds({
    x: Math.round(ballDragOrigin.x + dx),
    y: Math.round(ballDragOrigin.y + dy),
    width: ballDragOrigin.w,
    height: ballDragOrigin.h,
  });
});
ipcMain.on('ball:drag-end', () => {
  ballDragging = false;
  ballDragOrigin = null;
  scheduleSnap();
});

ipcMain.on('ball:drag-enter', () => { ballFileDrag = true; ballDragging = false; showBall(); });
ipcMain.on('ball:drag-leave', () => {
  ballFileDrag = false;
  if (ballMode !== 'idle') return;
  if (ballHideTimer) clearTimeout(ballHideTimer);
  ballHideTimer = setTimeout(() => { if (ballMode === 'idle') hideBall(); }, 700);
});
ipcMain.on('ball:start-drag', (e, rel) => {
  try {
    const abs = path.join(folderPath, String(rel).split('/').join(path.sep));
    logBall('start-drag ' + rel + ' exists=' + fs.existsSync(abs) + ' size=' + (fs.existsSync(abs) ? fs.statSync(abs).size : 0));
    if (!fs.existsSync(abs)) return;
    e.sender.startDrag({ file: abs, icon: dragIcon() });
  } catch (err) { logBall('start-drag err ' + err.message); }
});
ipcMain.handle('lan-list', () => [...lanPeers.values()]);
ipcMain.handle('lan-send', async (e, id) => {
  const peer = lanPeers.get(String(id || ''));
  if (!peer) return { ok: false, message: '设备已离线' };
  const r = await dialog.showOpenDialog(mainWindow || undefined, {
    title: '发送到 ' + peer.name, properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  let ok = 0;
  for (const f of r.filePaths) if (await sendFileToPeer(peer, f)) ok++;
  return { ok: ok === r.filePaths.length, sent: ok, total: r.filePaths.length };
});
ipcMain.handle('ball:open', () => { showMainWindow(); return { ok: true }; });
ipcMain.handle('ball:copy', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });
ipcMain.handle('ball:open-file', (_e, rel) => {
  const abs = path.join(folderPath, String(rel || '').split('/').join(path.sep));
  if (!fs.existsSync(abs)) return { ok: false, message: '文件不存在' };
  shell.openPath(abs);
  return { ok: true };
});
ipcMain.handle('ball:send-clipboard', () => sendClipboard());
ipcMain.handle('ball:toggle', () => {
  ballManualHidden = !ballManualHidden;
  if (ballManualHidden) {
    setBallMode('idle');
    hideBall();
  } else {
    ballSuppressUntil = 0;
    setBallMode('idle');
    showBall();
  }
  send('ball:state', { hidden: ballManualHidden, always: ballCfg.mode === 'always' });
  return { hidden: ballManualHidden };
});
ipcMain.handle('ball:state', () => ({ hidden: ballManualHidden, always: ballCfg.mode === 'always' }));
ipcMain.handle('ball:dismiss', () => {
  ballSuppressUntil = Date.now() + 6000;
  setBallMode('idle');
  hideBall();
  return { ok: true };
});
ipcMain.handle('ball:get-login', () => ({ on: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle('ball:set-login', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on });
  return { ok: true, on: app.getLoginItemSettings().openAtLogin };
});

// 回收站
ipcMain.handle('list-trash', () => ({ items: pm ? pm.listTrash() : [] }));
ipcMain.handle('restore-trash', (_e, id) => (pm ? pm.restoreTrash(id) : { ok: false }));
ipcMain.handle('delete-trash', (_e, id) => (pm ? pm.deleteTrash(id) : { ok: false }));
ipcMain.handle('empty-trash', () => (pm ? pm.emptyTrash() : { ok: false }));

// 版本历史
ipcMain.handle('list-versions', (_e, rel) => ({ items: pm ? pm.listVersions(rel) : [] }));
ipcMain.handle('restore-version', (_e, rel, id) => (pm ? pm.restoreVersion(rel, id) : { ok: false }));

// ---------------- 生命周期 ----------------
// 单实例锁：避免第二次启动抢不到发现端口，导致"永远发现不了设备"
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const openedAtLogin = !!app.getLoginItemSettings().wasOpenedAtLogin;
    initPeer();
    createWindow(openedAtLogin);   // 开机自启时只在托盘/悬浮球里待着，不弹窗
    createTray();
    createBallWindow();
    startBallWatcher();
    startWebServer();
    setTimeout(() => startLanDiscovery(), 800);
    try { globalShortcut.register('CommandOrControl+Alt+S', () => sendClipboard()); } catch (e) {}
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(false);
      else showMainWindow();
    });
  });

  app.on('window-all-closed', () => { /* 托盘常驻 */ });

  app.on('before-quit', () => {
    isQuitting = true;
    if (winClipHelper) { try { winClipHelper.kill(); } catch (e) {} }
    try { globalShortcut.unregisterAll(); } catch (e) {}
    if (pm) pm.stop();
  });
}
