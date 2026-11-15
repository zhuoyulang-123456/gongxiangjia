/* 共享夹 · 界面逻辑 v3 */

const api = window.gxj;
const $ = (id) => document.getElementById(id);

let state = {
  peers: [], discovered: [], pending: [], waiting: [],
  files: [], trashCount: 0, myCode: '', name: '', deviceId: '',
};
const transfers = new Map(); // path -> { dir, sent, total, speed, lastAt, lastSent, at }
const rowMap = new Map();
let fileSignature = '';
let rafPending = false;
let toastTimer = null;

// ---------------- 格式化 ----------------
function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function formatSpeed(bps) {
  if (!bps || bps < 1) return '0 B/s';
  if (bps < 1024) return Math.round(bps) + ' B/s';
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  if (bps < 1024 * 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s';
  return (bps / 1024 / 1024 / 1024).toFixed(2) + ' GB/s';
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortId(id) { return (id || '').slice(0, 6).toUpperCase(); }
function basename(p) { return String(p).split('/').pop(); }

function fileType(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(ext)) return 'music';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'archive';
  if (['doc', 'docx', 'pdf', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'].includes(ext)) return 'doc';
  return 'file';
}
function iconFor(name) {
  return icon(fileType(name));
}

// ---------------- 提示 ----------------
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  // 重新触发入场动画
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ---------------- 弹层 ----------------
function openDialog(title, html) {
  $('dialog-title').textContent = title;
  $('dialog-body').innerHTML = html;
  $('mask').classList.remove('hidden');
}
function closeDialog() {
  $('mask').classList.add('hidden');
  $('dialog-body').innerHTML = '';
}

// ---------------- 设备渲染 ----------------
function deviceRow({ dotClass, name, sub, subClass = '', right, avatarClass = '' }) {
  const row = document.createElement('div');
  row.className = 'dev-row';
  row.innerHTML = `
    <span class="dev-avatar ${avatarClass}">${icon('monitor')}<span class="dev-dot ${dotClass}"></span></span>
    <div class="dev-main">
      <div class="dev-name">${escapeHtml(name)}</div>
      <div class="dev-sub ${subClass}">${escapeHtml(sub)}</div>
    </div>
    ${right || ''}
  `;
  return row;
}

function renderDevices() {
  const pending = state.pending || [];
  const paired = state.peers || [];
  const nearby = state.discovered || [];

  // 配对请求
  const pendingList = $('pending-list');
  pendingList.innerHTML = '';
  pendingList.classList.toggle('hidden', pending.length === 0);
  for (const d of pending) {
    const row = deviceRow({
      dotClass: 'pending',
      avatarClass: 'pending',
      name: d.name || '设备',
      sub: '想和你连接 · 同意后开始同步',
      right: `<button class="btn btn-small btn-primary" data-accept>接受</button>
              <button class="btn btn-small btn-ghost" data-reject>拒绝</button>`,
    });
    row.querySelector('[data-accept]').addEventListener('click', () => acceptPair(d.deviceId, d.name));
    row.querySelector('[data-reject]').addEventListener('click', () => rejectPair(d.deviceId));
    pendingList.appendChild(row);
  }

  // 已配对
  const pairedList = $('paired-list');
  pairedList.innerHTML = '';
  for (const p of paired) {
    const waiting = !p.online && (state.waiting || []).includes(p.deviceId);
    const sub = p.online ? '在线 · 已加密' : waiting ? '等待对方确认' : '离线';
    const row = deviceRow({
      dotClass: p.online ? 'online' : '',
      avatarClass: p.online ? 'on' : '',
      name: p.name || '设备',
      sub,
      subClass: p.online ? 'online' : '',
      right: `
        <div class="seg" role="group" aria-label="权限">
          <button class="seg-btn ${p.perm !== 'ro' ? 'active' : ''}" data-perm="rw">可读写</button>
          <button class="seg-btn ${p.perm === 'ro' ? 'active' : ''}" data-perm="ro">只读</button>
        </div>
        <button class="icon-btn" data-scope title="同步范围">${icon('sliders')}</button>
        <button class="icon-btn danger" data-unpair title="取消配对">${icon('unlink')}</button>
      `,
    });
    row.querySelectorAll('[data-perm]').forEach((b) =>
      b.addEventListener('click', () => setPerm(p.deviceId, b.dataset.perm)));
    row.querySelector('[data-scope]').addEventListener('click', () => openScope(p));
    row.querySelector('[data-unpair]').addEventListener('click', () => unpair(p.deviceId, p.name));
    pairedList.appendChild(row);
  }

  // 附近
  const nearbyList = $('nearby-list');
  nearbyList.innerHTML = '';

  // 同一网络里的手机/平板（它们连不上 P2P 时，也能直接发文件给他们）
  for (const d of (state.lanDevices || [])) {
    const row = deviceRow({
      dotClass: 'online',
      avatarClass: 'on',
      name: d.name || '手机',
      sub: (d.kind === 'phone' ? '手机 · ' : '设备 · ') + '同一网络，可直接发送',
      subClass: 'online',
      right: `<button class="btn btn-small btn-soft" data-lan-send>发送文件</button>`,
    });
    row.querySelector('[data-lan-send]').addEventListener('click', async () => {
      const r = await api.lanSend(d.id);
      if (!r || r.canceled) return;
      toast(r.ok ? '已发送 ' + r.total + ' 个文件' : `发送了 ${r.sent || 0}/${r.total || 0}`);
    });
    nearbyList.appendChild(row);
  }
  for (const d of nearby) {
    const row = deviceRow({
      dotClass: '',
      name: d.name || '设备',
      sub: '同一网络 · 点击发起连接请求',
      right: `<button class="btn btn-small btn-primary" data-pair>连接</button>`,
    });
    row.querySelector('[data-pair]').addEventListener('click', () => pair(d.deviceId));
    nearbyList.appendChild(row);
  }
  $('nearby-empty').classList.toggle('hidden', nearby.length > 0 || paired.length > 0 || pending.length > 0);

  const online = paired.filter((p) => p.online).length;
  $('device-summary').textContent = paired.length
    ? `${online}/${paired.length} 在线`
    : nearby.length ? `${nearby.length} 台可配对` : '未配对';
}

// ---------------- 文件渲染 ----------------
function fileSignatureOf(files, pendingPaths) {
  return files.map((f) => `${f.path}|${f.size}|${f.mtime}|${f.hasVersions ? 1 : 0}|${f.conflict ? 1 : 0}`).join('~')
    + '#' + pendingPaths.join(',');
}

function renderFiles(force = false) {
  // 文字走「文字」面板展示，不在文件列表里重复出现
  const visibleFiles = (state.files || []).filter((f) => !f.path.startsWith('文字/'));
  // 传输中但还没有落地的新文件，也要能看到
  const pendingPaths = [...transfers.keys()].filter((p) => !visibleFiles.some((f) => f.path === p));
  const sig = fileSignatureOf(visibleFiles, pendingPaths);
  if (!force && sig === fileSignature) {
    applyTransfers();
    return;
  }
  fileSignature = sig;

  const list = $('file-list');
  list.innerHTML = '';
  rowMap.clear();

  const items = [];
  for (const p of pendingPaths) {
    const t = transfers.get(p);
    items.push({ path: p, name: basename(p), dir: '', size: t.total || 0, mtime: 0, incoming: true });
  }
  items.push(...visibleFiles);

  $('file-count').textContent = visibleFiles.length ? `${visibleFiles.length} 个文件` : '';
  $('empty-state').classList.toggle('hidden', items.length > 0);

  for (const f of items) {
    const t = fileType(f.name);
    const badges = [];
    if (f.conflict) badges.push('<span class="badge warn">冲突副本</span>');
    if (f.hasVersions) badges.push('<span class="badge">有历史版本</span>');

    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.path = f.path;
    row.draggable = !f.incoming;
    row.innerHTML = `
      <div class="file-icon ${['image', 'video', 'music', 'archive'].includes(t) ? 'type-' + t : ''}">${iconFor(f.name)}</div>
      <div class="file-main">
        <div class="file-name" title="${escapeHtml(f.path)}">${escapeHtml(f.name)}</div>
        <div class="file-meta">
          ${f.incoming ? '<span>接收中…</span>' : `<span>${formatSize(f.size)}</span><span>·</span><span>${formatTime(f.mtime)}</span>`}
          ${f.dir ? `<span>·</span><span>${escapeHtml(f.dir)}</span>` : ''}
          ${badges.join('')}
        </div>
        <div class="file-progress hidden">
          <div class="progress-track"><div class="progress-fill"></div></div>
          <span class="progress-text"></span>
        </div>
      </div>
      <div class="file-actions">
        ${f.incoming ? '' : `
          <button class="icon-btn" data-act="open" title="打开">${icon('open')}</button>
          <button class="icon-btn" data-act="save" title="保存副本到…">${icon('save')}</button>
          ${f.hasVersions ? `<button class="icon-btn" data-act="history" title="历史版本">${icon('history')}</button>` : ''}
          <button class="icon-btn" data-act="reveal" title="在文件夹中显示">${icon('folderOpen')}</button>
          <button class="icon-btn danger" data-act="delete" title="删除">${icon('trash')}</button>
        `}
      </div>
    `;
    list.appendChild(row);
    rowMap.set(f.path, row);
  }
  applyTransfers();
}

function applyTransfers() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const [path, t] of transfers) {
      const row = rowMap.get(path);
      if (!row) continue;
      const box = row.querySelector('.file-progress');
      if (!box) continue;
      box.classList.remove('hidden');
      const pct = t.total ? Math.max(0, Math.min(100, Math.round((t.sent / t.total) * 100))) : 0;
      row.querySelector('.progress-fill').style.width = pct + '%';
      row.querySelector('.progress-fill').classList.toggle('out', t.dir === 'out');
      row.querySelector('.progress-track').classList.toggle('out', t.dir === 'out');
      const txt = row.querySelector('.progress-text');
      txt.classList.toggle('out', t.dir === 'out');
      txt.textContent = `${t.dir === 'out' ? '发送' : '接收'} ${pct}% · ${formatSpeed(t.speed)}`;
    }
    updateSpeedChip();
  });
}

function updateSpeedChip() {
  const chip = $('speed-chip');
  let up = 0, down = 0;
  for (const t of transfers.values()) {
    if (t.dir === 'out') up += t.speed || 0; else down += t.speed || 0;
  }
  const parts = [];
  if (down > 1) parts.push(icon('arrowDown') + formatSpeed(down));
  if (up > 1) parts.push(icon('arrowUp') + formatSpeed(up));
  if (!parts.length) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  chip.innerHTML = parts.join('<span style="opacity:.35">·</span>');
}

// ---------------- 状态 ----------------
function updateStatus() {
  const peers = state.peers || [];
  const online = peers.filter((p) => p.online).length;
  const waiting = (state.waiting || []).length;
  const pending = (state.pending || []).length;
  const active = transfers.size;
  const dot = $('status-dot');
  let text = '';
  let cls = '';

  if (active > 0) {
    text = `正在传输 ${active} 个文件`;
    cls = 'ok';
  } else if (pending > 0) {
    text = `${pending} 台设备请求配对，请在上方点「接受」`;
    cls = 'bad';
  } else if (!peers.length) {
    text = '正在发现附近设备…';
  } else if (!online) {
    text = waiting ? `已配对 ${peers.length} 台，等待对方确认…` : `已配对 ${peers.length} 台，等待连接…`;
  } else {
    text = `已连接 ${online} 台设备，实时加密同步中`;
    cls = 'ok';
  }
  dot.className = 'dot ' + cls;
  $('status-text').textContent = text;
}

// ---------------- 数据刷新 ----------------
async function refreshPeers() {
  const r = await api.getPeers();
  state.peers = r.peers || [];
  state.discovered = r.discovered || [];
  state.pending = r.pending || [];
  state.waiting = r.waiting || [];
  try { state.lanDevices = await api.lanList() || []; } catch (e) { state.lanDevices = []; }
  renderDevices();
  updateStatus();
}
async function refreshFiles() {
  const r = await api.getFiles();
  if (r.ok) { state.files = r.files || []; renderFiles(); }
}
async function refreshTrashCount() {
  const r = await api.listTrash();
  state.trashCount = (r.items || []).length;
  const el = $('trash-count');
  el.textContent = state.trashCount;
  el.classList.toggle('hidden', state.trashCount === 0);
}
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshFiles(); refreshPeers(); }, 220);
}
let refreshTimer = null;

// ---------------- 动作 ----------------
async function pair(deviceId) {
  const r = await api.pair(deviceId);
  if (!r.ok) return toast(r.message || '配对失败');
  toast('已发送配对请求，请在对方设备上点「接受」');
  refreshPeers();
}
async function acceptPair(deviceId, name) {
  const r = await api.acceptPair(deviceId);
  if (!r.ok) return toast(r.message || '接受失败');
  toast(`已和「${name || '设备'}」配对`);
  refreshPeers();
}
async function rejectPair(deviceId) { await api.rejectPair(deviceId); refreshPeers(); }
async function unpair(deviceId, name) {
  if (!confirm(`取消和「${name || '这台设备'}」的配对？之后不再同步文件。`)) return;
  await api.unpair(deviceId);
  refreshPeers();
}
async function setPerm(deviceId, perm) {
  const r = await api.setPerm(deviceId, perm);
  if (!r.ok) { toast('设置失败'); return refreshPeers(); }
  toast(perm === 'ro' ? '已设为只读：对方只能取文件' : '已设为可读写');
  refreshPeers();
}
async function openFile(rel) {
  const r = await api.openFile(rel);
  if (!r.ok) toast(r.message || '打开失败');
}
async function saveFile(rel) {
  const r = await api.saveFile(rel);
  if (r.canceled) return;
  if (!r.ok) return toast(r.message || '保存失败');
  toast('已保存到：' + r.path);
}
async function removeFile(rel) {
  if (!confirm(`删除「${basename(rel)}」？\n会先进回收站（保留 30 天），配对的设备也会同步移除。`)) return;
  const r = await api.deleteFile(rel);
  if (!r.ok) return toast(r.message || '删除失败');
  toast('已移到回收站');
  refreshFiles();
  refreshTrashCount();
}

// ---------------- 弹层内容 ----------------
async function openTrash() {
  const r = await api.listTrash();
  const items = r.items || [];
  const rows = items.map((t) => `
    <div class="row-item">
      <div class="row-main">
        <div class="row-title">${escapeHtml(t.path)}</div>
        <div class="row-sub">${formatTime(t.ts)} · ${formatSize(t.size)}</div>
      </div>
      <button class="btn btn-small btn-soft" data-restore="${escapeHtml(t.id)}">恢复</button>
      <button class="btn btn-small btn-danger" data-drop="${escapeHtml(t.id)}">彻底删除</button>
    </div>`).join('');
  openDialog('回收站', items.length
    ? `<div class="row-list">${rows}</div>
       <div class="dialog-foot"><button class="btn btn-small btn-ghost" id="trash-empty">清空回收站</button></div>`
    : '<p class="dialog-empty">回收站是空的<br />删除的文件会在这里保留 30 天</p>');

  $('dialog-body').querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api.restoreTrash(b.dataset.restore);
    if (!res.ok) return toast(res.message || '恢复失败');
    toast('已恢复：' + res.path);
    closeDialog(); refreshFiles(); refreshTrashCount();
  }));
  $('dialog-body').querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', async () => {
    await api.deleteTrash(b.dataset.drop);
    openTrash(); refreshTrashCount();
  }));
  const emptyBtn = $('trash-empty');
  if (emptyBtn) emptyBtn.addEventListener('click', async () => {
    if (!confirm('彻底删除回收站里的全部文件？无法恢复。')) return;
    await api.emptyTrash();
    closeDialog(); refreshTrashCount(); toast('回收站已清空');
  });
}

async function openVersions(rel) {
  const r = await api.listVersions(rel);
  const items = r.items || [];
  const rows = items.map((v) => `
    <div class="row-item">
      <div class="row-main">
        <div class="row-title">${formatTime(v.at)}</div>
        <div class="row-sub">${formatSize(v.size)}</div>
      </div>
      <button class="btn btn-small btn-soft" data-ver="${escapeHtml(v.id)}">恢复此版本</button>
    </div>`).join('');
  openDialog('历史版本 · ' + basename(rel), items.length
    ? `<p class="dialog-hint">每次覆盖都会自动留一份，最多保留 10 个版本。</p><div class="row-list">${rows}</div>`
    : '<p class="dialog-empty">这个文件还没有历史版本</p>');
  $('dialog-body').querySelectorAll('[data-ver]').forEach((b) => b.addEventListener('click', async () => {
    const res = await api.restoreVersion(rel, b.dataset.ver);
    if (!res.ok) return toast(res.message || '恢复失败');
    toast('已恢复到该版本');
    closeDialog(); refreshFiles();
  }));
}

async function openScope(peer) {
  const { entries } = await api.topEntries();
  const scope = peer.scope || [];
  const all = scope.length === 0;
  const rows = entries.map((e) => `
    <label class="check-row">
      <input type="checkbox" value="${escapeHtml(e)}" ${all || scope.includes(e) ? 'checked' : ''} />
      <span>${escapeHtml(e)}</span>
    </label>`).join('');
  openDialog('同步范围 · ' + (peer.name || '设备'), entries.length
    ? `<p class="dialog-hint">勾选「${escapeHtml(peer.name || '这台设备')}」可以同步的顶层文件夹。全部勾选 = 全部同步。</p>
       <div class="check-list">${rows}</div>
       <div class="dialog-foot"><button class="btn btn-small btn-primary" id="scope-save">保存</button></div>`
    : '<p class="dialog-empty">共享夹里还没有子文件夹<br />把文件分到子文件夹里，就能按文件夹控制范围</p>');

  const save = $('scope-save');
  if (save) save.addEventListener('click', async () => {
    const checked = [...$('dialog-body').querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    const next = checked.length === entries.length ? [] : checked;
    await api.setScope(peer.deviceId, next);
    closeDialog(); refreshPeers();
    toast(next.length ? '同步范围已更新' : '已恢复为全部同步');
  });
}

let textRefreshTimer = null;
function refreshTextsSoon() {
  if (textRefreshTimer) clearTimeout(textRefreshTimer);
  textRefreshTimer = setTimeout(refreshTexts, 300);
}

async function refreshTexts() {
  const r = await api.listTexts();
  const items = (r.items || []).slice(0, 6);
  const list = $('text-list');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="text-empty">还没有文字。发一段试试，其他设备马上能收到。</div>';
    return;
  }
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'text-item';
    const preview = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    el.innerHTML = `
      <div class="text-main" title="点击复制">
        <div class="text-preview">${escapeHtml(preview || '（空）')}</div>
        <div class="text-meta">${formatTime(it.mtime)} · ${String(it.text || '').length} 字</div>
      </div>
      <button class="icon-btn" data-copy title="复制">${icon('copy')}</button>
      <button class="icon-btn danger" data-del title="删除">${icon('trash')}</button>
    `;
    el.querySelector('.text-main').addEventListener('click', () => { api.copyText(it.text); toast('已复制'); });
    el.querySelector('[data-copy]').addEventListener('click', () => { api.copyText(it.text); toast('已复制'); });
    el.querySelector('[data-del]').addEventListener('click', async () => {
      await api.deleteFile(it.path);
      refreshTexts(); refreshFiles();
    });
    list.appendChild(el);
  }
}

async function sendTextNow() {
  const el = $('text-input');
  const t = el.value.trim();
  if (!t) { el.focus(); return; }
  const r = await api.sendText(t);
  if (!r.ok) return toast(r.message || '发送失败');
  el.value = '';
  toast('文字已发送');
  refreshTexts();
  refreshFiles();
}

async function openMobile() {
  const r = await api.getWebUrl();
  const url = r && r.url ? r.url : '';
  openDialog('手机访问', `
    <p class="dialog-hint">手机和电脑连同一个 WiFi，用浏览器打开下面这个地址，就能收发共享夹里的文件。也可以「添加到主屏幕」，当成 App 用。</p>
    <textarea class="link-box" id="web-url" readonly style="min-height:54px">${escapeHtml(url)}</textarea>
    <div class="dialog-foot">
      <button class="btn btn-small btn-primary" id="copy-web">复制地址</button>
    </div>
    <hr class="sep" />
    <div class="tip-list">
      <div class="tip-item"><span class="tip-num">1</span><div>安卓 / 鸿蒙：浏览器菜单 →「添加到主屏幕」</div></div>
      <div class="tip-item"><span class="tip-num">2</span><div>iPhone / iPad：Safari → 分享 →「添加到主屏幕」</div></div>
      <div class="tip-item"><span class="tip-num">3</span><div>地址里带访问令牌，别发给别人</div></div>
    </div>
  `);
  $('copy-web').addEventListener('click', () => {
    api.copyText(url);
    toast('地址已复制');
  });
}

async function openSpeedGuide() {
  const fresh = await api.getState();
  const link = fresh.linkSpeed ? `${fresh.linkSpeed.toFixed(1)} MB/s` : '还没测过（传一次文件后自动记录）';
  const rows = [
    ['网线直连（千兆）', '80–110 MB/s', '约 10 秒', 'fast'],
    ['家用 WiFi · 5GHz', '15–50 MB/s', '20–70 秒', 'fast'],
    ['便携路由器 · 5GHz', '10–30 MB/s', '35–100 秒', 'fast'],
    ['手机热点 · 5GHz', '5–15 MB/s', '1–3 分钟', 'mid'],
    ['家用 WiFi · 2.4GHz', '2–6 MB/s', '3–8 分钟', 'slow'],
    ['手机热点 · 2.4GHz', '2–3 MB/s', '6–9 分钟', 'slowest'],
  ];
  const table = rows.map(([name, speed, time, cls]) => `
    <div class="speed-row ${cls}"><span>${name}</span><span class="v">${speed}</span><span class="t">${time}</span></div>
  `).join('');

  openDialog('传输速度与加速', `
    <div class="link-now">
      <span class="link-now-label">当前链路实测</span>
      <b>${link}</b>
    </div>
    <p class="dialog-hint">速度取决于两台设备之间的网络。传 1GB 文件的参考时间：</p>
    <div class="speed-table">
      <div class="speed-row head"><span>场景</span><span>速度</span><span>1GB</span></div>
      ${table}
    </div>
    <p class="dialog-hint">想更快，按这个顺序试：</p>
    <div class="tip-list">
      <div class="tip-item"><span class="tip-num">1</span><div><b>换 5GHz WiFi。</b>2.4GHz 和 5GHz 差 5–10 倍。手机热点切 5GHz：iPhone 关掉「最大兼容性」；安卓在热点设置里选「AP 频段 → 5GHz」。</div></div>
      <div class="tip-item"><span class="tip-num">2</span><div><b>别用手机热点传大文件。</b>手机只有一块射频，数据要在空中走两遍，天生打对折。几十块的便携路由器会好很多。</div></div>
      <div class="tip-item"><span class="tip-num">3</span><div><b>靠近一点、别有墙。</b>5GHz 穿墙差，两台设备离路由器/手机越近越快。</div></div>
      <div class="tip-item"><span class="tip-num">4</span><div><b>有条件就插网线。</b>千兆网线稳定 80–110 MB/s，1GB 十秒传完。</div></div>
    </div>
    <p class="dialog-hint" style="margin-top:14px">共享夹会自动适配：慢链路自动优化分片，快链路自动退回单连接；加密、断点续传、进度显示都是自动的。</p>
  `);
}

async function openLink() {
  const r = await api.makeLink();
  openDialog('配对链接', `
    <p class="dialog-hint">把这条链接发给对方（微信、邮件都行），对方粘贴后就能配对——不依赖自动发现。</p>
    <textarea class="link-box" id="my-link" readonly>${r.ok ? escapeHtml(r.link) : ''}</textarea>
    <div class="dialog-foot"><button class="btn btn-small btn-primary" id="copy-link">复制链接</button></div>
    <hr class="sep" />
    <p class="dialog-hint">或粘贴对方发来的链接：</p>
    <textarea class="link-box" id="peer-link" placeholder="GXJ1:..."></textarea>
    <div class="dialog-foot"><button class="btn btn-small btn-soft" id="do-pair">用这个链接配对</button></div>
  `);
  $('copy-link').addEventListener('click', () => {
    const ta = $('my-link');
    api.copyText(ta.value);
    toast('链接已复制');
  });
  $('do-pair').addEventListener('click', async () => {
    const text = $('peer-link').value.trim();
    if (!text) return toast('先粘贴链接');
    const res = await api.pairLink(text);
    if (!res.ok) return toast(res.message || '配对失败');
    closeDialog(); refreshPeers();
    toast(`已向「${res.name}」发送配对请求`);
  });
}

// ---------------- 传输 ----------------
function onTransfer(ev) {
  if (!ev || !ev.path) return;
  const now = performance.now();
  let t = transfers.get(ev.path);
  if (!t || t.dir !== ev.direction || ev.sent < t.sent) {
    t = { dir: ev.direction, sent: 0, total: ev.total || 0, speed: 0, lastAt: now, lastSent: 0 };
  }
  const dt = (now - t.lastAt) / 1000;
  if (dt > 0.08) {
    const inst = Math.max(0, (ev.sent - t.lastSent) / dt);
    t.speed = t.speed ? t.speed * 0.62 + inst * 0.38 : inst;
    t.lastAt = now;
    t.lastSent = ev.sent;
  }
  t.sent = ev.sent;
  t.total = ev.total || t.total;
  t.at = Date.now();
  transfers.set(ev.path, t);
  renderFiles();
  updateStatus();
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [path, t] of transfers) {
    const finished = t.total > 0 && t.sent >= t.total;
    if ((finished && now - t.at > 1200) || now - t.at > 4000) {
      transfers.delete(path);
      changed = true;
    }
  }
  if (changed) { renderFiles(); updateStatus(); }
  else applyTransfers();
}, 1000);

// ---------------- 事件 ----------------
function handlePeerEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'discovered':
      state.discovered = ev.list || [];
      renderDevices();
      break;
    case 'pending':
      state.pending = ev.list || [];
      renderDevices();
      refreshPeers();
      break;
    case 'pair-request':
      toast(`「${ev.name || '有设备'}」想和你配对`);
      refreshPeers();
      break;
    case 'pair-waiting':
      refreshPeers();
      break;
    case 'pair-rejected':
      toast(ev.reason === 'unpaired' ? '对方已取消配对' : '对方拒绝了配对请求');
      refreshPeers();
      break;
    case 'peers':
      refreshPeers();
      break;
    case 'peer-online':
      refreshPeers();
      toast(`「${ev.name || '设备'}」已连接`);
      break;
    case 'peer-offline':
      refreshPeers();
      break;
    case 'manifest':
      state.files = ev.list || [];
      renderFiles();
      if ((ev.list || []).some((f) => f.path && f.path.startsWith('文字/'))) refreshTextsSoon();
      break;
    case 'file-dup':
      toast('「' + basename(ev.path) + '」已在共享夹里');
      break;
    case 'file-added':
      if (ev.conflict) toast('发现冲突，已保留副本：' + basename(ev.path));
      if (ev.path && ev.path.startsWith('文字/')) {
        refreshTextsSoon();
        if (ev.from && ev.from !== '本机') toast('收到一条文字');
      }
      scheduleRefresh();
      refreshTrashCount();
      break;
    case 'transfer':
      if (ev.instant) {
        $('status-text').textContent = `秒传「${basename(ev.path)}」`;
        setTimeout(updateStatus, 1200);
      } else {
        onTransfer(ev);
      }
      break;
    case 'scan':
      $('status-text').textContent = ev.phase === 'start' ? '正在扫描共享文件夹…' : '扫描完成';
      break;
    case 'error':
      toast(ev.message || '出错了');
      break;
    default:
      break;
  }
}

// ---------------- 拖拽 ----------------
function setupDrop() {
  const zone = $('dropzone');
  const overlay = $('drop-overlay');
  let depth = 0;

  zone.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
      depth++;
      overlay.classList.remove('hidden');
    }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (!files.length) return;
    const paths = files.map((f) => api.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return toast('没能读取到文件');
    const r = await api.addFiles(paths);
    const res = r.results || [];
    const bad = res.filter((x) => !x.ok);
    const dup = res.filter((x) => x.ok && x.duplicate);
    const upd = res.filter((x) => x.ok && x.updated);
    if (bad.length) toast('没放进去：' + bad.map((b) => b.name).join('、'));
    else if (upd.length) toast('已更新为新版本，旧版本可在「历史」里找回');
    else if (dup.length) toast('文件已在共享夹里，已通知其他设备');
    else toast('已放进共享夹，正在同步…');
    refreshFiles();
  });

  // 从窗口把文件拖出去
  let rowDragging = false;
  $('file-list').addEventListener('dragstart', (e) => {
    const row = e.target.closest('.file-row');
    if (!row || !row.dataset.path) return;
    e.preventDefault();
    rowDragging = true;
    setTimeout(() => { rowDragging = false; }, 800);
    api.startDrag(row.dataset.path);
    row.classList.add('dragging');
    setTimeout(() => row.classList.remove('dragging'), 500);
  });

  // 单击 = 复制文件，双击 = 打开
  let rowClickTimer = null;
  $('file-list').addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row || !row.dataset.path) return;
    const path = row.dataset.path;
    const act = e.target.closest('[data-act]');
    if (act) {
      switch (act.dataset.act) {
        case 'open': openFile(path); return;
        case 'save': saveFile(path); return;
        case 'history': openVersions(path); return;
        case 'reveal': api.showInFolder(path); return;
        case 'delete': removeFile(path); return;
        default: return;
      }
    }
    if (rowDragging) return; // 拖出去之后不要误判成单击
    if (rowClickTimer) clearTimeout(rowClickTimer);
    rowClickTimer = setTimeout(() => {
      rowClickTimer = null;
      api.copyFile(path).then((r) => {
        toast(r && r.ok ? (r.mode === 'file' ? '文件已复制，可直接粘贴' : '路径已复制') : '复制失败');
      }).catch(() => toast('复制失败'));
    }, 220);
  });

  $('file-list').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.file-row');
    if (!row || !row.dataset.path) return;
    if (e.target.closest('[data-act]')) return;
    if (rowClickTimer) { clearTimeout(rowClickTimer); rowClickTimer = null; }
    openFile(row.dataset.path);
  });
}

// ---------------- 点击涟漪 ----------------
function setupRipple() {
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height);
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.left = e.clientX - r.left - size / 2 + 'px';
    span.style.top = e.clientY - r.top - size / 2 + 'px';
    btn.appendChild(span);
    setTimeout(() => span.remove(), 560);
  });
}

// ---------------- 初始化 ----------------
async function init() {
  const s = await api.getState();
  Object.assign(state, s);
  $('my-code').textContent = s.myCode || '----';
  $('device-name').textContent = s.name || '我的电脑';
  $('device-id').textContent = shortId(s.deviceId) || '—';

  renderDevices();
  renderFiles(true);
  updateStatus();
  refreshTrashCount();

  $('btn-open-folder').addEventListener('click', () => api.openFolder());
  $('btn-add').addEventListener('click', async () => {
    const r = await api.addFilesDialog();
    if (!r || r.canceled) return;
    const res = r.results || [];
    const bad = res.filter((x) => !x.ok);
    const upd = res.filter((x) => x.ok && x.updated);
    const dup = res.filter((x) => x.ok && x.duplicate);
    if (bad.length) toast('没放进去：' + bad.map((b) => b.name).join('、'));
    else if (upd.length) toast('已更新为新版本，旧版本可在「历史」里找回');
    else if (dup.length) toast('文件已在共享夹里，已通知其他设备');
    else toast('已放进共享夹，正在同步…');
    refreshFiles();
  });
  $('btn-ball').addEventListener('click', async () => {
    const r = await api.ballToggle();
    $('btn-ball').classList.toggle('active', !r.hidden);
    $('btn-ball').style.color = r.hidden ? '' : 'var(--primary)';
    toast(r.hidden ? '悬浮球已隐藏' : '悬浮球已显示');
  });
  api.onBallState((d) => {
    $('btn-ball').style.color = d && d.hidden ? '' : 'var(--primary)';
  });
  $('btn-trash').addEventListener('click', openTrash);
  $('btn-mobile').addEventListener('click', openMobile);
  $('btn-link').addEventListener('click', openLink);
  $('btn-speed').addEventListener('click', openSpeedGuide);
  $('text-send').addEventListener('click', sendTextNow);
  $('text-clip').addEventListener('click', async () => {
    const r = await api.sendClipboard();
    if (!r.ok) return toast(r.message || '剪贴板里没有文字');
    toast('已发送剪贴板文字');
    refreshTexts();
    refreshFiles();
  });
  $('text-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTextNow(); }
  });

  // 文本框里粘贴图片/文件：直接放进共享夹
  $('text-input').addEventListener('paste', async (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])];
    const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return; // 纯文字走默认粘贴
    e.preventDefault();
    let added = 0;
    for (const f of files) {
      const p = api.getPathForFile(f);
      if (p) {
        const r = await api.addFiles([p]);
        if (r && (r.results || []).some((x) => x.ok)) added++;
        continue;
      }
      try {
        const buf = await f.arrayBuffer();
        const ext = (String(f.type || 'image/png').split('/')[1] || 'png').replace('jpeg', 'jpg');
        const d = new Date();
        const p2 = (n) => String(n).padStart(2, '0');
        const name = `粘贴图片 ${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${ext}`;
        const r = await api.addBinary(name, new Uint8Array(buf));
        if (r && r.ok) added++;
      } catch (err) { /* ignore */ }
    }
    if (added) { toast('已把剪贴板里的图片放进共享夹'); refreshFiles(); }
    else toast('粘贴的内容没能放进共享夹');
  });
  refreshTexts();

  $('btn-code').addEventListener('click', () => {
    api.copyText(s.myCode || '');
    toast('设备码已复制：' + (s.myCode || ''));
  });

  $('dialog-close').addEventListener('click', closeDialog);
  $('mask').addEventListener('click', (e) => { if (e.target === $('mask')) closeDialog(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });

  // 文件操作（事件委托）

  setupDrop();
  setupRipple();
  api.onPeerEvent(handlePeerEvent);
}

init();
