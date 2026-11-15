/* 共享夹 · 悬浮球（特效版） */

const api = window.gxj;
const body = document.body;
const $ = (id) => document.getElementById(id);

let current = { mode: 'idle', name: '', kind: 'file', text: '' };
let wasVisible = false;
function fmtSpeed(bps) {
  if (!bps || bps < 1) return '';
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
}

function apply(d) {
  if (!d) return;
  if (typeof d.win === 'boolean') body.dataset.win = d.win ? '1' : '0';
  if (typeof d.visible === 'boolean') {
    const shown = d.visible;
    body.dataset.visible = shown ? '1' : '0';
    if (shown && !wasVisible) ripple();
    wasVisible = shown;
  }
  if (d.mode) {
    current.mode = d.mode;
    body.dataset.mode = d.mode;
    if (d.mode === 'received' && typeof d.hint !== 'string') {
      const h = document.querySelector('.sheet-hint');
      if (h) h.textContent = '按住拖到桌面任意位置';
    }
  }
  if (d.edge) body.dataset.edge = d.edge;

  if (typeof d.progress === 'number') {
    const p = Math.max(0, Math.min(100, Math.round(d.progress)));
    $('ring').style.setProperty('--p', String(p));
    $('pct').textContent = p + '%';
  }
  if (typeof d.speed === 'number') {
    const s = fmtSpeed(d.speed);
    $('speed').textContent = s || '准备中…';
  }
  if (d.kind) {
    current.kind = d.kind;
    body.dataset.kind = d.kind;
  }
  if (typeof d.text === 'string') current.text = d.text;
  if (d.name) {
    current.name = d.name;
    $('sheet-name').textContent = d.name.split('/').pop();
  }
  if (typeof d.hint === 'string') {
    const h = document.querySelector('.sheet-hint');
    if (h) h.textContent = d.hint;
  }
}

api.onBallEvent(apply);

/* ---------------- 特效 ---------------- */
function ripple() {
  const core = $('core');
  const shock = document.createElement('span');
  shock.className = 'shock';
  core.appendChild(shock);
  setTimeout(() => shock.remove(), 720);
}

function burst() {
  const layer = $('burst');
  const n = 18;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'particle';
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const dist = 26 + Math.random() * 40;
    p.style.setProperty('--dx', Math.cos(a) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(a) * dist + 'px');
    p.style.animationDelay = Math.random() * 80 + 'ms';
    const size = 3 + Math.random() * 4;
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    layer.appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
}

let toastTimer = null;
function ballToast(text) {
  const el = document.getElementById('ball-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

function swallow() {
  body.dataset.swallow = '1';
  ripple();
  setTimeout(() => { delete body.dataset.swallow; }, 680);
  setTimeout(burst, 90);
}

/* ---------------- 拖放 ---------------- */
function log(m) { try { api.ballLog(m); } catch (e) {} }

let dragDepth = 0;
let overLogged = false;

function acceptance(e) {
  e.preventDefault();
  if (e.dataTransfer) {
    try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
  }
}

function pathsFromDrop(e) {
  const out = [];
  const dt = e.dataTransfer;
  if (!dt) return out;
  try {
    for (const f of dt.files || []) {
      const p = api.getPathForFile(f);
      if (p) out.push(p);
    }
  } catch (err) { log('getPathForFile err ' + err.message); }
  if (!out.length) {
    let uri = '';
    try { uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch (err) {}
    log('fallback uri len=' + uri.length);
    for (const line of uri.split(/\r?\n/)) {
      const t = line.trim();
      if (!t.startsWith('file://')) continue;
      try { out.push(decodeURIComponent(new URL(t).pathname)); } catch (err) {}
    }
  }
  return out;
}

async function handleDrop(e) {
  log('DROP files=' + ((e.dataTransfer && e.dataTransfer.files) ? e.dataTransfer.files.length : -1));
  acceptance(e);
  dragDepth = 0;
  overLogged = false;
  body.dataset.drag = '0';
  try { api.ballDragLeave(); } catch (err) {}
  let paths = [];
  try { paths = pathsFromDrop(e); } catch (err) { log('paths err ' + err.message); }
  log('paths=' + paths.length + ' ' + paths.slice(0, 3).join(' | '));

  if (paths.length) {
    try { swallow(); } catch (err) { log('swallow err ' + err.message); }
    try {
      const r = await api.ballAddFiles(paths);
      log('addFiles result=' + JSON.stringify(r).slice(0, 300));
    } catch (err) { log('addFiles err ' + err.message); }
    return;
  }

  // 没有文件，看看是不是拖过来的文字
  let text = '';
  try {
    const dt = e.dataTransfer;
    text = (dt.getData('text/plain') || '').trim();
    if (!text) {
      const html = dt.getData('text/html') || '';
      if (html) text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch (err) { log('text err ' + err.message); }
  log('text len=' + text.length);
  if (!text) { log('no paths/text, abort'); return; }
  try { swallow(); } catch (err) {}
  try {
    const r = await api.ballSendText(text);
    log('sendText result=' + JSON.stringify(r).slice(0, 200));
    ballToast(r && r.ok ? '已发送文字' : '发送失败');
  } catch (err) { log('sendText err ' + err.message); }
}

// 全部用捕获阶段，避免被内部元素截断
window.addEventListener('dragenter', (e) => {
  acceptance(e);           // 关键：取消 dragenter 才会成为合法投放目标
  const types = e.dataTransfer ? [...e.dataTransfer.types].join(',') : '';
  log('ENTER types=' + types);
  const hasFiles = types.includes('Files') || (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0);
  const hasText = types.includes('text/plain') || types.includes('text/html');
  if (hasFiles || hasText) {
    dragDepth++;
    body.dataset.drag = '1';
    body.dataset.kind = hasFiles ? 'file' : 'text';
    const tip = document.getElementById('drop-tip');
    if (tip) tip.textContent = hasFiles ? '松开，传进共享夹' : '松开，发送文字';
    log('dragenter types=' + types + ' kind=' + body.dataset.kind);
    try { api.ballDragEnter(); } catch (err) { log('enter err ' + err.message); }
  }
}, true);

window.addEventListener('dragover', (e) => {
  acceptance(e);
  if (!overLogged) { overLogged = true; log('dragover'); }
}, true);

window.addEventListener('dragleave', (e) => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) {
    body.dataset.drag = '0';
    overLogged = false;
    try { api.ballDragLeave(); } catch (err) {}
  }
}, true);

window.addEventListener('drop', (e) => { handleDrop(e); }, true);

/* ---------------- 交互 ---------------- */
let suppressClick = false;

function makeDraggable(el) {
  if (!el) return;
  let down = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { accX: 0, accY: 0, moved: false, pointerId: e.pointerId };
    // 注意：这里不要立刻 setPointerCapture，否则卡片里的「×」「复制」收不到 click
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    // 用相对位移累加：窗口跟着动的时候绝对坐标会跳，容易变成"一碰就拖"
    down.accX += e.movementX || 0;
    down.accY += e.movementY || 0;
    if (!down.moved && Math.hypot(down.accX, down.accY) > 10) {
      down.moved = true;
      suppressClick = true;
      body.dataset.drag = '1';
      try { el.setPointerCapture(down.pointerId); } catch (err) {}
      api.ballDragStart();
    }
    if (down.moved) api.ballDragTo(down.accX, down.accY);
  });
  const end = (e) => {
    if (!down) return;
    if (down.moved) {
      api.ballDragEnd();
      setTimeout(() => { suppressClick = false; }, 80);
      body.dataset.drag = '0';
    }
    const pid = down.pointerId;
    down = null;
    try { el.releasePointerCapture(pid); } catch (err) {}
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

makeDraggable($('core'));
makeDraggable(document.querySelector('.sheet'));

$('core').addEventListener('click', () => {
  if (suppressClick) { log('ball click suppressed'); return; }
  log('ball click open');
  if (body.dataset.visible === '1') api.ballOpen();
});

// 右键：直接把剪贴板内容发出去
window.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  try {
    const r = await api.ballSendClipboard();
    ballToast(r && r.ok ? '已发送剪贴板' : (r && r.message) || '剪贴板里没有文字');
  } catch (err) { ballToast('发送失败'); }
});

function beginDragOut(e) {
  if (!current.name) return;
  e.preventDefault();
  log('drag-out ' + current.name);
  api.ballStartDrag(current.name);
}
$('sheet-icon').addEventListener('dragstart', (e) => { if (current.kind === 'file') beginDragOut(e); });
$('sheet-main').addEventListener('dragstart', (e) => { if (current.kind === 'file') beginDragOut(e); });
$('sheet-icon').addEventListener('click', () => {
  if (current.kind === 'text') {
    api.ballCopy(current.text || '');
    ballToast('已复制文字');
  } else {
    api.ballCopyFile(current.name).then((r) => {
      ballToast(r && r.ok ? (r.mode === 'file' ? '文件已复制' : '路径已复制') : '复制失败');
    }).catch(() => ballToast('复制失败'));
  }
});
$('sheet-main').addEventListener('click', () => api.ballOpen());
$('sheet-icon').addEventListener('dblclick', () => {
  if (current.kind === 'file') api.ballOpenFile(current.name);
});
$('sheet-close').addEventListener('click', () => api.ballDismiss());
