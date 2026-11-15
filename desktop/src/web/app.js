/* 共享夹 · 手机网页版 */

const T = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
const api = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(T);

const state = { files: [], texts: [], first: true, busy: false };
let lastSig = '';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function typeOf(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) return 'music';
  if (['zip', 'rar', '7z', 'gz', 'tar', 'dmg', 'apk', 'exe'].includes(ext)) return 'archive';
  return 'doc';
}
const ICONS = {
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m22 8-6 4 6 4z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
};
function iconFor(name) {
  const t = typeOf(name);
  const cls = ['image', 'video', 'music', 'archive'].includes(t) ? ' type-' + t : '';
  return `<div class="ico${cls}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[t] || ICONS.doc}</svg></div>`;
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, ms = 1800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ---------------- 复制（网页 / 原生桥 / 兜底） ---------------- */
async function copyText(text) {
  const t = String(text == null ? '' : text);
  try {
    if (window.GXJ && typeof window.GXJ.copy === 'function') {
      const ok = window.GXJ.copy(t);
      if (ok !== false) return true;
    }
  } catch (e) {}
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ---------------- 数据 ---------------- */
async function load(silent) {
  try {
    const r = await fetch(api('/api/state'), { cache: 'no-store' });
    if (r.status === 401) {
      $('dot').className = 'dot bad';
      $('stat').textContent = '链接已失效';
      $('device').textContent = '请重新从电脑上复制链接';
      toast('链接已失效，请重新在电脑上复制', 2600);
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    state.files = s.files || [];
    state.texts = s.texts || [];
    $('device').textContent = `${s.name || '电脑'}${s.code ? ' · ' + s.code : ''}` + ((s.devices && s.devices.length) ? '  ▸ ' + s.devices.join('、') : '');
    $('dot').className = 'dot ok';
    const devs = 1 + (s.peers || 0);
    $('stat').textContent = `已连接 ${devs} 台设备 · ${state.files.length} 个文件 · 实时同步`;
    renderDevices(s);
    renderFiles();
    renderTexts();
    state.first = false;
  } catch (e) {
    $('dot').className = 'dot bad';
    $('stat').textContent = '连接断开，检查是否在同一 WiFi';
    $('device').textContent = '未连接';
    if (state.first) {
      state.first = false;
      $('file-list').innerHTML = '';
      $('file-empty').style.display = 'flex';
    }
    if (!silent) toast('连不上电脑，检查是否在同一 WiFi');
  }
}

function renderDevices(s) {
  const list = $('device-list');
  if (!list) return;
  const rows = [{ name: s.name || '电脑', tag: '电脑 · 本机', online: true }];
  for (const n of (s.devices || [])) rows.push({ name: n, tag: '电脑 · 已连接', online: true });
  $('device-count').textContent = rows.length + ' 台在线';
  list.innerHTML = rows.map((d) => `
    <div class="row">
      <div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div>
      <div class="main">
        <div class="name">${esc(d.name)}</div>
        <div class="meta">${esc(d.tag)}</div>
      </div>
      <span class="tap" style="background:rgba(16,185,129,.12);color:#10B981">在线</span>
    </div>`).join('');
}

function renderFiles() {
  const files = state.files;
  const sig = files.map((f) => f.path + '|' + f.mtime + '|' + f.size).join(',');
  $('file-count').textContent = files.length ? files.length + ' 个' : '';
  $('file-empty').style.display = files.length ? 'none' : 'flex';
  if (sig === lastSig) return;
  lastSig = sig;

  const list = $('file-list');
  list.innerHTML = '';
  for (const f of files) {
    const a = document.createElement('a');
    a.className = 'row';
    a.href = api('/api/file?p=' + encodeURIComponent(f.path));
    a.setAttribute('download', f.name);
    a.innerHTML = `
      ${iconFor(f.name)}
      <div class="main">
        <div class="name">${esc(f.name)}</div>
        <div class="meta">${f.dir ? esc(f.dir) + ' · ' : ''}${fmtSize(f.size)} · ${fmtTime(f.mtime)}</div>
      </div>
      <span class="tap">下载</span>
    `;
    list.appendChild(a);
  }
}

function renderTexts() {
  const texts = state.texts;
  const list = $('text-list');
  $('text-empty').style.display = texts.length ? 'none' : 'block';
  list.innerHTML = '';
  for (const t of texts.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'row';
    const body = String(t.text || '');
    row.innerHTML = `
      <div class="main">
        <div class="name clamp" style="font-weight:450;line-height:1.45">${esc(body.replace(/\s+/g, ' ').slice(0, 140))}</div>
        <div class="meta">${fmtTime(t.mtime)} · ${body.length} 字</div>
      </div>
      <button class="tap" data-copy>复制</button>
    `;
    const btn = row.querySelector('[data-copy]');
    const doCopy = async () => {
      const ok = await copyText(body);
      btn.textContent = ok ? '已复制' : '长按选择';
      if (ok && window.GXJ && window.GXJ.toast) { try { window.GXJ.toast('已复制'); } catch (e) {} }
      setTimeout(() => { btn.textContent = '复制'; }, 1400);
    };
    btn.addEventListener('click', doCopy);
    row.addEventListener('click', (e) => { if (e.target !== btn) doCopy(); });
    list.appendChild(row);
  }
}

/* ---------------- 上传 ---------------- */
function showProgress(text, pct) {
  const el = $('progress');
  el.classList.add('show');
  $('bar').style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  $('progress-text').textContent = text;
}
function hideProgress() {
  setTimeout(() => {
    $('progress').classList.remove('show');
    $('bar').style.width = '0';
  }, 500);
}

function uploadFile(file, idx, total) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api('/api/upload?name=' + encodeURIComponent(file.name)));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      showProgress(`${file.name} · ${idx + 1}/${total} · ${pct}%`, pct);
    };
    xhr.onload = () => resolve(xhr.status === 200);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

async function uploadAll(files) {
  const arr = [...files];
  if (!arr.length || state.busy) return;
  state.busy = true;
  let ok = 0;
  for (let i = 0; i < arr.length; i++) {
    showProgress(`${arr[i].name} · ${i + 1}/${arr.length} · 0%`, 0);
    if (await uploadFile(arr[i], i, arr.length)) ok++;
  }
  state.busy = false;
  hideProgress();
  if (ok) {
    toast(ok === arr.length ? `已上传 ${ok} 个文件` : `上传了 ${ok}/${arr.length} 个`);
    await load(true);
    setTimeout(() => load(true), 1200);
  } else {
    toast('上传失败，检查连接');
  }
}

$('pick').addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  await uploadAll(files);
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  await uploadAll((e.dataTransfer && e.dataTransfer.files) || []);
});

/* ---------------- 文字发送 ---------------- */
async function sendText() {
  const el = $('text-input');
  const t = el.value.trim();
  if (!t) { toast('先写点什么'); return; }
  const btn = $('text-send');
  btn.disabled = true;
  try {
    const r = await fetch(api('/api/text'), { method: 'POST', body: t });
    if (r.ok) {
      el.value = '';
      toast('已发送到电脑');
      await load(true);
    } else {
      toast('发送失败');
    }
  } catch (e) {
    toast('发送失败，检查连接');
  } finally {
    btn.disabled = false;
  }
}
$('text-send').addEventListener('click', sendText);
$('text-input').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendText();
});

/* ---------------- Tab ---------------- */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === btn));
    const tab = btn.dataset.tab;
    $('view-files').classList.toggle('hidden', tab !== 'files');
    $('view-text').classList.toggle('hidden', tab !== 'text');
    $('view-settings').classList.toggle('hidden', tab !== 'settings');
    $('pick').classList.toggle('hidden', tab !== 'files');
    if (tab === 'settings') refreshBallSwitch();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

/* ---------------- 刷新 / 下拉刷新 ---------------- */
$('refresh').addEventListener('click', async () => {
  const b = $('refresh');
  b.classList.add('spin');
  await load();
  setTimeout(() => b.classList.remove('spin'), 500);
});

let touchStartY = 0;
let pulling = false;
document.addEventListener('touchstart', (e) => {
  if (window.scrollY <= 0 && e.touches.length === 1) {
    touchStartY = e.touches[0].clientY;
    pulling = true;
  }
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!pulling) return;
  const dy = e.touches[0].clientY - touchStartY;
  if (dy > 70 && window.scrollY <= 0) $('pulldown').classList.add('show');
}, { passive: true });
document.addEventListener('touchend', async () => {
  if (!pulling) return;
  pulling = false;
  if ($('pulldown').classList.contains('show')) {
    await load(true);
    setTimeout(() => $('pulldown').classList.remove('show'), 320);
  }
}, { passive: true });

document.addEventListener('scroll', () => {
  document.body.classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });

/* ---------------- 设置页 ---------------- */
function refreshBallSwitch() {
  const btn = $('ball-toggle');
  if (!btn) return;
  let on = false;
  try { on = !!(window.GXJ && window.GXJ.ballOn && window.GXJ.ballOn()); } catch (e) {}
  btn.textContent = on ? '已开启' : '开启';
  btn.style.background = on ? 'rgba(16,185,129,.12)' : '';
  btn.style.color = on ? '#10B981' : '';
}

$('ball-toggle').addEventListener('click', () => {
  try {
    if (!window.GXJ || !window.GXJ.setBall) { toast('只能在共享夹 App 里切换'); return; }
    const on = !!window.GXJ.ballOn();
    window.GXJ.setBall(!on);
    setTimeout(refreshBallSwitch, 300);
  } catch (e) { toast('切换失败'); }
});

$('row-addr').addEventListener('click', () => {
  if (window.GXJ && window.GXJ.settings) { try { window.GXJ.settings(); return; } catch (e) {} }
  toast('在电脑上点「手机访问」，把新链接粘贴到 App 的输入框');
});

/* ---------------- 启动 ---------------- */
(function boot() {
  // 首屏骨架，避免白屏
  $('file-list').innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  load().then(() => {
    if (state.first) $('file-list').innerHTML = '';
  });
  setInterval(() => { if (!document.hidden) load(true); }, 2500);

  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = '/m/manifest.json?t=' + encodeURIComponent(T);
  document.head.appendChild(link);

  // 原生壳里禁用长按选择菜单之外的默认行为
  if (window.GXJ && window.GXJ.isApp) {
    document.documentElement.classList.add('native');
  }
})();
