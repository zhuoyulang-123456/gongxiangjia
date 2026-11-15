'use strict';
/**
 * 共享夹 - P2P 引擎 v2（Syncthing 风格）
 *
 * 能力：
 *   1. 设备身份 + 端到端加密（Ed25519 身份签名 + X25519 临时密钥 + AES-256-GCM）
 *   2. 局域网自动发现 / 配对握手 / 配对链接
 *   3. 分块传输 + 断点续传（按内容哈希保存未完成分片）
 *   4. 秒传（本机已有相同内容，直接复制，不走网络）
 *   5. 增量同步（大文件按 1MB 块比对，只传变化的块）
 *   6. 冲突检测与确定性解决（保留双方内容，旧版进历史）
 *   7. 版本历史 + 回收站
 *   8. 权限（只读 / 可读写）与选择性同步（按顶层文件夹）
 *
 * 所有文件路径在协议里用相对路径（'/' 分隔），落盘时再转换。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const dgram = require('dgram');
const http = require('http');
const EventEmitter = require('events');
const chokidar = require('chokidar');
const { WebSocketServer, WebSocket } = require('ws');

const PROTOCOL = 'gxj-p2p/2';
const DISCOVERY_PORT = 41234;
const CHUNK = 1024 * 1024;             // 传输分片（大一点更省开销）
const BLOCK = 1024 * 1024;             // 增量同步块
const DELTA_MIN = 2 * 1024 * 1024;     // 超过 2MB 才做块级增量
const DELTA_MAX = 4 * 1024 * 1024 * 1024;
const STRIPE_MIN = 16 * 1024 * 1024;   // 超过 16MB 才启用多连接分片
const STRIPE_RANGE = 8 * 1024 * 1024;  // 每个分片 8MB
const STRIPE_CONNS = 4;                // 1 条控制 + 3 条数据连接
const VERSION_KEEP = 10;               // 每个文件最多保留几个历史版本
const TRASH_DAYS = 30;                 // 回收站保留天数

const TRASH_DIR = '.gxj-trash';
const VERSION_DIR = '.gxj-versions';
const PARTIAL_DIR = '.gxj-partial';
const CACHE_FILE = '.gxj-cache.json';

// ---------------- 通用工具 ----------------
const NOP = () => {};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function isInternal(rel) {
  const first = String(rel).split('/')[0];
  return first.startsWith('.') || first.startsWith('._');
}

/** 校验并规范化相对路径；不合法返回 null */
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (parts.length > 12) return null;
  if (isInternal(norm)) return null;
  return parts.join('/');
}

function hashFile(file, blockSize) {
  return new Promise((resolve, reject) => {
    const whole = crypto.createHash('sha256');
    const blocks = [];
    let blk = blockSize ? crypto.createHash('sha256') : null;
    let blkLen = 0;
    let size = 0;
    const s = fs.createReadStream(file, { highWaterMark: 512 * 1024 });
    s.on('data', (d) => {
      whole.update(d);
      size += d.length;
      if (!blockSize) return;
      let off = 0;
      while (off < d.length) {
        const take = Math.min(blockSize - blkLen, d.length - off);
        blk.update(d.subarray(off, off + take));
        blkLen += take;
        off += take;
        if (blkLen === blockSize) {
          blocks.push(blk.digest('hex').slice(0, 16));
          blk = crypto.createHash('sha256');
          blkLen = 0;
        }
      }
    });
    s.on('end', () => {
      if (blockSize && blkLen > 0) blocks.push(blk.digest('hex').slice(0, 16));
      resolve({ hash: whole.digest('hex'), size, blocks });
    });
    s.on('error', reject);
  });
}

function hashBuffer(buf) { return sha256(buf); }

// X25519 / Ed25519 裸公钥 <-> KeyObject
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function rawToKeyObject(rawB64, prefix) {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('公钥长度不对');
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
}
function keyObjectToRaw(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// ---------------- 引擎 ----------------
class PeerManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dataDir = opts.dataDir;
    this.folder = opts.folder;
    this.name = opts.name || os.hostname();
    this.port = opts.port || 0;
    this.discovery = opts.discovery !== false;
    this.discoveryPort = opts.discoveryPort || DISCOVERY_PORT;

    this.deviceId = null;
    this.identity = null;          // { signPub, signPriv }
    this.peers = new Map();        // deviceId -> {deviceId,address,port,name,signPub,perm,scope}
    this.discovered = new Map();
    this.conns = new Map();        // deviceId -> ws
    this.pending = new Map();
    this.waitingConfirm = new Set();
    this.rejected = new Map();

    this.manifest = new Map();     // relPath -> {relPath,size,hash,mtime,blocks,blockSize}
    this.deleted = new Map();      // relPath -> ts（墓碑，防止删除后又被传回来）
    this.conflicts = new Map();    // relPath -> {path, at, peer}
    this.receiving = new Map();    // ws -> transfer state
    this.sendQueues = new Map();   // ws -> []
    this.wanted = new Set();       // 正在请求的路径，防重复
    this.inflightHashes = new Set(); // 正在传输的内容哈希（同内容只传一份）
    this.dataConns = new Map();      // deviceId -> Map(slot -> ws) 额外的数据连接
    this.inBytes = new Map();        // path -> 已接收字节（多流汇总进度）
    this.outBytes = new Map();       // path -> Map(index -> 已发送字节)
    this.activePulls = new Map();    // path -> { peerId, at } 卡住时重试用
    this.peerSpeed = new Map();      // deviceId -> 每条连接实测 MB/s（自适应决定多流条数）
    this.recentlyWritten = new Set();
    this.hashCache = new Map();    // relPath -> {size,mtimeMs,hash,blocks}
    this.versionPaths = new Set();  // 有历史版本的文件

    this.watcher = null;
    this.server = null;
    this.wss = null;
    this.udp = null;
    this.announceTimer = null;
    this.reconnectTimer = null;
    this.started = false;
  }

  // ---------------- 身份 ----------------
  _idPath() { return path.join(this.dataDir, 'device.json'); }
  _peersPath() { return path.join(this.dataDir, 'peers.json'); }
  _cachePath() { return path.join(this.folder, CACHE_FILE); }

  loadIdentity() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let saved = {};
    try { if (fs.existsSync(this._idPath())) saved = JSON.parse(fs.readFileSync(this._idPath(), 'utf8')); } catch (e) {}

    if (!saved.deviceId) saved.deviceId = crypto.randomBytes(16).toString('hex');
    if (!saved.signPriv) {
      const kp = crypto.generateKeyPairSync('ed25519');
      saved.signPriv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
      saved.signPub = keyObjectToRaw(kp.publicKey);
    }
    this.deviceId = saved.deviceId;
    const priv = crypto.createPrivateKey(saved.signPriv);
    const pub = crypto.createPublicKey(priv);
    this.identity = { signPriv: priv, signPub: keyObjectToRaw(pub) };
    saved.name = this.name;
    fs.writeFileSync(this._idPath(), JSON.stringify(saved, null, 2));

    try {
      if (fs.existsSync(this._peersPath())) {
        for (const p of JSON.parse(fs.readFileSync(this._peersPath(), 'utf8'))) {
          this.peers.set(p.deviceId, { perm: 'rw', scope: [], ...p });
        }
      }
    } catch (e) {}
  }

  savePeers() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this._peersPath(), JSON.stringify([...this.peers.values()], null, 2));
  }

  myCode() { return this.deviceId.slice(0, 6).toUpperCase(); }
  shortId(id) { return (id || '').slice(0, 6).toUpperCase(); }

  /** 本机在局域网里的地址（配对链接用） */
  lanAddress() {
    const ifs = os.networkInterfaces();
    for (const list of Object.values(ifs)) {
      for (const it of list || []) {
        if (it.family === 'IPv4' && !it.internal) return it.address;
      }
    }
    return '127.0.0.1';
  }

  /** 生成配对链接：把地址和公钥一起给对方，绕过自动发现 */
  makeLink() {
    const payload = { d: this.deviceId, a: this.lanAddress(), p: this.port, n: this.name, k: this.identity.signPub };
    return 'GXJ1:' + b64url(JSON.stringify(payload));
  }

  parseLink(text) {
    const m = String(text || '').trim().match(/^GXJ1:([A-Za-z0-9_-]+)$/);
    if (!m) return null;
    try {
      const o = JSON.parse(b64urlDecode(m[1]).toString('utf8'));
      if (!o.d || !o.a || !o.p) return null;
      return { deviceId: o.d, address: o.a, port: Number(o.p), name: o.n || '设备 ' + this.shortId(o.d), signPub: o.k || '' };
    } catch (e) { return null; }
  }

  // ---------------- 生命周期 ----------------
  async start() {
    this.loadIdentity();
    fs.mkdirSync(this.folder, { recursive: true });
    for (const d of [TRASH_DIR, VERSION_DIR, PARTIAL_DIR]) fs.mkdirSync(path.join(this.folder, d), { recursive: true });
    this._loadVersions();
    this._loadCache();
    this.emit('scan', { phase: 'start' });
    await this.scanFolder();
    this.emit('scan', { phase: 'done' });
    await this.startServer();
    if (this.discovery) this.startDiscovery();
    this.startWatcher();
    this.startReconnect();
    this.startStripeWatchdog();
    this._pruneTrash();
    this.started = true;
    this.emit('ready', { deviceId: this.deviceId, port: this.port });
    return { deviceId: this.deviceId, port: this.port };
  }

  async startServer() {
    this.server = http.createServer((req, res) => { res.writeHead(200); res.end('gxj peer'); });
    this.wss = new WebSocketServer({ server: this.server, maxPayload: 4 * 1024 * 1024 });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    await new Promise((resolve) => {
      this.server.listen(this.port, () => { this.port = this.server.address().port; resolve(); });
    });
  }

  stop() {
    this.started = false;
    this._stopping = true;
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this._bindRetry) clearTimeout(this._bindRetry);
    if (this._watchTimer) clearInterval(this._watchTimer);
    if (this.reconnectTimer) clearInterval(this.reconnectTimer);
    if (this.watcher) this.watcher.close();
    if (this.udp) { try { this.udp.close(); } catch (e) {} this.udp = null; }
    for (const ws of this.conns.values()) { try { ws.close(); } catch (e) {} }
    this.conns.clear();
    if (this.wss) { try { this.wss.close(); } catch (e) {} }
    if (this.server) { try { this.server.close(); } catch (e) {} }
  }

  // ---------------- 发现 ----------------
  startDiscovery() {
    if (!this.started && this._stopping) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;

    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString());
        if (m.magic !== 'GXJ' || m.deviceId === this.deviceId) return;
        const old = this.discovered.get(m.deviceId);
        this.discovered.set(m.deviceId, { deviceId: m.deviceId, name: m.name, address: rinfo.address, port: m.port, lastSeen: Date.now() });
        if (!old || old.address !== rinfo.address || old.port !== m.port) this.emit('discovered', this.listDiscovered());

        // 已配对的设备：端口每次启动都会变，靠广播把新地址补上，否则会一直连旧端口
        const peer = this.peers.get(m.deviceId);
        if (peer) {
          if (peer.address !== rinfo.address || peer.port !== m.port) {
            peer.address = rinfo.address;
            peer.port = m.port;
            this.savePeers();
          }
          if (!this.conns.has(m.deviceId)) this.connectTo(m.deviceId, true);
        }
      } catch (e) {}
    });

    // 端口被别的实例占用时不要"静默失明"：关掉重来，每 3 秒重试
    sock.on('error', () => {
      try { sock.close(); } catch (e) {}
      if (this.udp === sock) this.udp = null;
      if (this._bindRetry) clearTimeout(this._bindRetry);
      this._bindRetry = setTimeout(() => {
        this._bindRetry = null;
        if (this.started) this.startDiscovery();
      }, 3000);
    });

    sock.bind(this.discoveryPort, () => {
      try { sock.setBroadcast(true); } catch (e) {}
      this.emit('discovery-ready', { port: this.discoveryPort });
      this._announce();
      if (this.announceTimer) clearInterval(this.announceTimer);
      this.announceTimer = setInterval(() => this._announce(), 3000);
    });
  }

  /** 子网定向广播地址（有些路由器会丢掉 255.255.255.255） */
  _broadcastAddress() {
    const ifs = os.networkInterfaces();
    for (const list of Object.values(ifs)) {
      for (const it of list || []) {
        if (it.family !== 'IPv4' || it.internal || !it.netmask) continue;
        const ip = it.address.split('.').map(Number);
        const mask = it.netmask.split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;
        return ip.map((n, i) => (n & mask[i]) | (255 ^ mask[i])).join('.');
      }
    }
    return null;
  }

  _announce() {
    if (!this.udp) return;
    const m = JSON.stringify({ magic: 'GXJ', deviceId: this.deviceId, name: this.name, port: this.port });
    const targets = new Set(['255.255.255.255']);
    const directed = this._broadcastAddress();
    if (directed) targets.add(directed);
    for (const t of targets) {
      try { this.udp.send(m, 0, m.length, this.discoveryPort, t); } catch (e) {}
    }
  }

  listDiscovered() {
    const paired = new Set(this.peers.keys());
    const now = Date.now();
    return [...this.discovered.values()]
      .filter((d) => !paired.has(d.deviceId) && d.deviceId !== this.deviceId && now - d.lastSeen < 30000);
  }

  // ---------------- 配对 ----------------
  pair(deviceId, address, port, opts = {}) {
    if (!deviceId || deviceId === this.deviceId) return false;
    const info = this.discovered.get(deviceId) || this.pending.get(deviceId) || {};
    const old = this.peers.get(deviceId) || {};
    this.peers.set(deviceId, {
      deviceId,
      address: address || info.address || old.address,
      port: port || info.port || old.port,
      name: info.name || old.name || '设备 ' + this.shortId(deviceId),
      signPub: opts.signPub || info.signPub || old.signPub || '',
      perm: old.perm || 'rw',
      scope: old.scope || [],
    });
    this.pending.delete(deviceId);
    this.rejected.delete(deviceId);
    this.savePeers();
    this.connectTo(deviceId, opts.force !== false);
    this.emit('peers-changed', this.statusList());
    this.emit('pending-changed', this.listPending());
    return true;
  }

  unpair(deviceId) {
    const ws = this.conns.get(deviceId);
    if (ws) { try { ws.close(); } catch (e) {} this.conns.delete(deviceId); }
    this.peers.delete(deviceId);
    this.peerSpeed.delete(deviceId);
    this.waitingConfirm.delete(deviceId);
    this.pending.delete(deviceId);
    this.rejected.set(deviceId, 'unpaired');
    this.savePeers();
    this.emit('peers-changed', this.statusList());
  }

  acceptPair(deviceId) {
    const p = this.pending.get(deviceId);
    if (!p) return false;
    return this.pair(deviceId, p.address, p.port, { signPub: p.signPub, force: true });
  }

  rejectPair(deviceId) {
    this.pending.delete(deviceId);
    this.rejected.set(deviceId, 'rejected');
    this.emit('pending-changed', this.listPending());
  }

  setPerm(deviceId, perm) {
    const p = this.peers.get(deviceId);
    if (!p) return false;
    p.perm = perm === 'ro' ? 'ro' : 'rw';
    this.savePeers();
    this.emit('peers-changed', this.statusList());
    try { const ws = this.conns.get(deviceId); if (ws) this._sendManifest(ws); } catch (e) {}
    return true;
  }

  setScope(deviceId, scope) {
    const p = this.peers.get(deviceId);
    if (!p) return false;
    p.scope = Array.isArray(scope) ? scope.filter((s) => typeof s === 'string' && s && !s.includes('..')) : [];
    this.savePeers();
    this.emit('peers-changed', this.statusList());
    const ws = this.conns.get(deviceId);
    if (ws) this._sendManifest(ws);
    return true;
  }

  /** 当前实测最快链路速率（MB/s），用于界面显示与自适应策略 */
  bestSpeed() {
    let max = 0;
    for (const v of this.peerSpeed.values()) if (v > max) max = v;
    return Math.round(max * 10) / 10;
  }

  /** 用外部文件替换共享夹里的同名文件，旧内容先存成历史版本 */
  replaceFile(rel, srcAbs) {
    const safe = safeRel(rel);
    if (!safe) return false;
    try {
      const dest = this._disk(safe);
      if (fs.existsSync(dest)) this._archiveVersion(safe); // 先把旧内容存一份
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcAbs, dest);
      return true;
    } catch (e) { return false; }
  }

  /** 手动通知对端「这个文件我发过了」，对方已有同内容时会给出反馈 */
  advertise(rel) {
    const safe = safeRel(rel);
    const e = safe && this.manifest.get(safe);
    if (!e) return false;
    this._broadcast({ type: 'file-advert', path: safe, hash: e.hash, size: e.size, name: this.name });
    return true;
  }

  listPending() { return [...this.pending.values()]; }
  isWaiting(deviceId) { return this.waitingConfirm.has(deviceId); }
  listPeers() { return [...this.peers.values()]; }
  statusList() {
    return [...this.peers.values()].map((p) => ({ ...p, online: this.conns.has(p.deviceId) }));
  }

  /** 顶层目录/文件列表，给「选择性同步」勾选用 */
  topEntries() {
    const set = new Set();
    for (const rel of this.manifest.keys()) set.add(rel.split('/')[0]);
    return [...set].sort();
  }

  _allowed(peer, rel) {
    if (!peer || !peer.scope || !peer.scope.length) return true;
    return peer.scope.includes(rel.split('/')[0]);
  }

  // ---------------- 连接 ----------------
  connectTo(deviceId, force = false, opts = {}) {
    const peer = this.peers.get(deviceId);
    if (!peer || !peer.address) return;
    const slot = opts.slot || 0;
    const key = slot ? `${deviceId}#d${slot}` : deviceId;
    if (slot) {
      const set = this.dataConns.get(deviceId);
      const existing = set && set.get(slot);
      if (existing && existing.readyState !== WebSocket.CLOSED) return;
    } else if (this.conns.has(deviceId)) {
      return;
    }
    if (!force && this.deviceId < peer.deviceId) return;
    if (!this.dialing) this.dialing = new Set();
    if (this.dialing.has(key)) return;
    let ws;
    try {
      const query = slot ? `/?role=data&slot=${slot}` : '/';
      ws = new WebSocket('ws://' + peer.address + ':' + peer.port + query);
    } catch (e) { return; }
    this.dialing.add(key);
    const done = () => this.dialing.delete(key);
    ws.on('open', () => {
      done();
      try { ws._socket.setNoDelay(true); } catch (e) {}
      this._sendHello(ws, force, slot ? 'data' : 'main', slot);
    });
    ws.on('message', (data, isBinary) => this._onRaw(ws, data, isBinary));
    ws.on('error', () => done());
    ws.on('close', () => { done(); this._cleanupConn(deviceId, ws); });
  }

  /** 需要几条数据连接就补齐几条（最多 STRIPE_CONNS-1） */
  async _ensureDataConns(peerId, want = STRIPE_CONNS - 1) {
    if (!this.peers.has(peerId)) return [];
    for (let slot = 1; slot <= want; slot++) this.connectTo(peerId, true, { slot });
    const secure = () => [...((this.dataConns.get(peerId) || new Map()).values())]
      .filter((w) => w.readyState === WebSocket.OPEN && w._secure);
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      if (secure().length >= want) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return secure();
  }

  _onConnection(ws, req) {
    try { ws._socket.setNoDelay(true); } catch (e) {}
    // 角色通过 URL 传给服务端，服务端回包时原样带回，双方才知道这是数据连接
    const url = (req && req.url) || '/';
    const m = url.match(/[?&]role=data(?:&slot=(\d+))?/);
    const isData = !!m;
    const slot = isData ? (Number(m[1]) || 1) : 0;
    ws.on('message', (data, isBinary) => this._onRaw(ws, data, isBinary));
    ws.on('close', () => { if (ws._peerId) this._cleanupConn(ws._peerId, ws); });
    ws.on('error', NOP);
    this._sendHello(ws, false, isData ? 'data' : 'main', slot);
  }

  _sendHello(ws, pairing, role, slot) {
    try {
      const eph = crypto.generateKeyPairSync('x25519');
      const ephPub = keyObjectToRaw(eph.publicKey);
      const ts = Date.now();
      const signBuf = Buffer.from(`${PROTOCOL}|${this.deviceId}|${ephPub}|${ts}|${pairing ? 1 : 0}`);
      const sig = crypto.sign(null, signBuf, this.identity.signPriv).toString('base64');
      ws._eph = eph.privateKey;
      ws._ephPub = ephPub;
      ws._helloSent = ts;
      ws.send(JSON.stringify({
        type: 'hello', protocol: PROTOCOL, deviceId: this.deviceId, name: this.name,
        port: this.port, pairing: !!pairing, ts, eph: ephPub,
        role: role || 'main', slot: slot || 0,
        signPub: this.identity.signPub, sig,
      }));
    } catch (e) { try { ws.close(); } catch (_) {} }
  }

  _cleanupConn(deviceId, ws) {
    const st = this.receiving.get(ws);
    if (st) {
      this.inflightHashes.delete(st.hash);
      this.receiving.delete(ws);
    }
    this.sendQueues.delete(ws);
    if (ws._activeStream) {
      try { ws._activeStream.destroy(); } catch (e) {}
      ws._activeStream = null;
    }
    ws._sending = false;

    if (ws._isData) {
      const set = this.dataConns.get(deviceId);
      if (set && set.get(ws._dataSlot) === ws) {
        set.delete(ws._dataSlot);
        if (!set.size) this.dataConns.delete(deviceId);
      }
      return;
    }

    if (this.conns.get(deviceId) === ws) {
      this.conns.delete(deviceId);
      const set = this.dataConns.get(deviceId);
      if (set) {
        for (const w of set.values()) { try { w.close(); } catch (e) {} }
        this.dataConns.delete(deviceId);
      }
      this.emit('peer-offline', deviceId);
      this.emit('peers-status', this.statusList());
    }
  }

  /** 多流传输卡住（连接抖动/断开）时，自动补拉没完成的分片 */
  startStripeWatchdog() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = setInterval(() => {
      const now = Date.now();
      for (const [path, ap] of this.activePulls) {
        if (now - ap.at < 12000) continue;
        if (this.manifest.has(path)) { this.activePulls.delete(path); continue; }
        const ws = this.conns.get(ap.peerId);
        if (!ws || !ws._secure) continue;
        const remote = (ws._remoteFiles || []).find((f) => f.path === path);
        if (!remote || !remote.hash || !(remote.size >= STRIPE_MIN)) { this.activePulls.delete(path); continue; }
        const total = Math.ceil(remote.size / STRIPE_RANGE);
        const done = new Set(this._readParts(remote.hash).done);
        const missing = [];
        for (let i = 0; i < total; i++) if (!done.has(i)) missing.push(i);
        if (!missing.length) continue;
        ap.at = now;
        this.wanted.add(path);
        this._sendJSON(ws, { type: 'request', path, ranges: missing });
      }
    }, 5000);
  }

  startReconnect() {
    this.reconnectTimer = setInterval(() => {
      for (const id of this.peers.keys()) if (!this.conns.has(id)) this.connectTo(id, this.waitingConfirm.has(id));
    }, 3000);
  }

  // ---------------- 握手 & 加解密 ----------------
  async _onRaw(ws, data, isBinary) {
    try {
      if (!ws._secure) {
        if (isBinary) { ws.close(); return; }
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'hello') { ws.close(); return; }
        await this._onHello(ws, msg);
        return;
      }
      const { kind, payload } = this._decrypt(ws, data, isBinary);
      if (kind === 1) this._onMessage(ws, JSON.parse(payload.toString()));
      else this._onChunk(ws, payload);
    } catch (e) {
      try { ws.close(); } catch (_) {}
    }
  }

  async _onHello(ws, msg) {
    if (msg.protocol !== PROTOCOL) return ws.close();
    if (!msg.deviceId || msg.deviceId === this.deviceId || !msg.eph || !msg.signPub || !msg.sig) return ws.close();

    // 1) 验证身份签名
    let pubKey;
    try { pubKey = rawToKeyObject(msg.signPub, SPKI_ED25519); } catch (e) { return ws.close(); }
    const signBuf = Buffer.from(`${PROTOCOL}|${msg.deviceId}|${msg.eph}|${msg.ts}|${msg.pairing ? 1 : 0}`);
    const ok = crypto.verify(null, signBuf, pubKey, Buffer.from(msg.sig, 'base64'));
    if (!ok) return ws.close();

    const peer = this.peers.get(msg.deviceId);

    // 2) 已配对设备：公钥必须一致（防中间人 / 冒充）
    if (peer && peer.signPub && peer.signPub !== msg.signPub) return ws.close(4003, 'identity');

    // 顺手用这次连接的真实来源修正地址/端口（对方重启后端口会变）
    if (peer) {
      const remoteAddr = ((ws._socket && ws._socket.remoteAddress) || '').replace(/^::ffff:/, '');
      let dirty = false;
      if (msg.port && peer.port !== msg.port) { peer.port = msg.port; dirty = true; }
      if (remoteAddr && peer.address !== remoteAddr) { peer.address = remoteAddr; dirty = true; }
      if (dirty) this.savePeers();
    }

    // 3) 建立会话密钥
    let shared;
    try {
      shared = crypto.diffieHellman({ privateKey: ws._eph, publicKey: rawToKeyObject(msg.eph, SPKI_X25519) });
    } catch (e) { return ws.close(); }
    const salt = crypto.createHash('sha256').update([ws._ephPub, msg.eph].sort().join('|')).digest();
    const mk = (from, to) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(`${PROTOCOL}|${from}|${to}`), 32));
    ws._sendKey = mk(this.deviceId, msg.deviceId);
    ws._recvKey = mk(msg.deviceId, this.deviceId);
    ws._secure = true;
    ws._peerId = msg.deviceId;
    ws._peerName = msg.name;
    ws._signPub = msg.signPub;

    // 3.5) 数据连接：只参与传文件，不发清单、不触发上线下线
    if (msg.role === 'data') {
      if (!peer) return ws.close(4003, 'unpaired');
      const slot = Number(msg.slot) || 0;
      if (!slot) return ws.close();
      let set = this.dataConns.get(msg.deviceId);
      if (!set) { set = new Map(); this.dataConns.set(msg.deviceId, set); }
      const old = set.get(slot);
      if (old && old !== ws) { try { old.close(); } catch (e) {} }
      set.set(slot, ws);
      ws._isData = true;
      ws._dataSlot = slot;
      return;
    }

    // 4) 未配对：走配对请求
    if (!peer) {
      if (msg.pairing) this.rejected.delete(msg.deviceId);
      if (this.rejected.has(msg.deviceId)) {
        this._sendJSON(ws, { type: 'pair-rejected', deviceId: this.deviceId, reason: this.rejected.get(msg.deviceId) || 'rejected' });
        return ws.close(4003, 'rejected');
      }
      const rawAddr = (ws._socket && ws._socket.remoteAddress) || '';
      const known = this.discovered.get(msg.deviceId);
      const isNew = !this.pending.has(msg.deviceId);
      this.pending.set(msg.deviceId, {
        deviceId: msg.deviceId,
        name: msg.name || '设备 ' + this.shortId(msg.deviceId),
        address: (known && known.address) || rawAddr.replace(/^::ffff:/, ''),
        port: (known && known.port) || msg.port,
        signPub: msg.signPub,
        at: Date.now(),
      });
      this._sendJSON(ws, { type: 'pair-request', deviceId: this.deviceId });
      if (isNew) {
        this.emit('pending-changed', this.listPending());
        this.emit('pair-request', this.pending.get(msg.deviceId));
      }
      return ws.close(4003, 'unpaired');
    }

    // 5) 已配对：登记连接
    const wasOnline = this.conns.has(msg.deviceId);
    const old = this.conns.get(msg.deviceId);
    this.conns.set(msg.deviceId, ws);
    if (old && old !== ws) { try { old.close(); } catch (e) {} }
    this.waitingConfirm.delete(msg.deviceId);
    if (!peer.signPub) { peer.signPub = msg.signPub; this.savePeers(); }
    if (!wasOnline) this.emit('peer-online', { deviceId: msg.deviceId, name: msg.name });
    this.emit('peers-status', this.statusList());
    this._sendManifest(ws);
  }

  _encrypt(ws, kind, payload) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ws._sendKey, nonce);
    const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([Buffer.from([kind]), nonce, cipher.getAuthTag(), ct]);
  }

  _decrypt(ws, data, isBinary) {
    if (data.length < 1 + 12 + 16) throw new Error('帧太短');
    const kind = data[0];
    const nonce = data.subarray(1, 13);
    const tag = data.subarray(13, 29);
    const ct = data.subarray(29);
    const d = crypto.createDecipheriv('aes-256-gcm', ws._recvKey, nonce);
    d.setAuthTag(tag);
    return { kind, payload: Buffer.concat([d.update(ct), d.final()]) };
  }

  _sendJSON(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      const payload = Buffer.from(JSON.stringify(obj));
      if (!ws._secure) { ws.send(payload.toString()); return; }
      ws.send(this._encrypt(ws, 1, payload), { binary: true });
    } catch (e) {}
  }

  _sendBinary(ws, buf) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws._secure) return;
    try { ws.send(this._encrypt(ws, 2, buf), { binary: true }); } catch (e) {}
  }

  // ---------------- 消息 ----------------
  _onMessage(ws, msg) {
    const peerId = ws._peerId;
    if (!msg || !msg.type) return;

    if (msg.type === 'pair-request') {
      const isNew = !this.waitingConfirm.has(peerId);
      this.waitingConfirm.add(peerId);
      if (this.conns.get(peerId) === ws) {
        this.conns.delete(peerId);
        this.emit('peer-offline', peerId);
        this.emit('peers-status', this.statusList());
      }
      try { ws.close(); } catch (e) {}
      if (isNew) this.emit('pair-waiting', { deviceId: peerId });
      return;
    }

    if (msg.type === 'pair-rejected') {
      this.waitingConfirm.delete(peerId);
      if (this.conns.get(peerId) === ws) { this.conns.delete(peerId); this.emit('peer-offline', peerId); }
      try { ws.close(); } catch (e) {}
      if (this.peers.delete(peerId)) this.savePeers();
      this.emit('peers-changed', this.statusList());
      this.emit('peers-status', this.statusList());
      this.emit('pair-rejected', { deviceId: peerId, reason: msg.reason || 'rejected' });
      return;
    }

    const peer = this.peers.get(peerId);
    if (!peer) return;

    switch (msg.type) {
      case 'manifest': this._onManifest(ws, peer, msg.files || []); break;
      case 'request': this._dispatch(ws, msg); break;
      case 'file_begin': this._onFileBegin(ws, peer, msg); break;
      case 'block': this._onBlockHeader(ws, msg); break;
      case 'file_end': this._onFileEnd(ws, msg); break;
      case 'delete': this._onRemoteDelete(ws, peer, msg); break;
      case 'file-advert': this._onAdvert(ws, peer, msg); break;
      case 'error': this.emit('transfer-error', { message: msg.message }); break;
      default: break;
    }
  }

  // ---------------- 清单 ----------------
  _manifestFor(peer) {
    const out = [];
    let blockBudget = 2 * 1024 * 1024; // 清单里块哈希总量上限，超了就退回整文件传输
    for (const [rel, v] of this.manifest) {
      if (!this._allowed(peer, rel)) continue;
      const item = { path: rel, size: v.size, hash: v.hash, mtime: v.mtime };
      if (v.blocks && blockBudget > 0 && v.blocks.length * 17 < blockBudget) {
        item.blocks = v.blocks;
        item.blockSize = v.blockSize || BLOCK;
        blockBudget -= v.blocks.length * 17;
      }
      out.push(item);
    }
    return out;
  }

  _sendManifest(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws._secure) return;
    const peer = this.peers.get(ws._peerId);
    if (!peer) return;
    this._sendJSON(ws, { type: 'manifest', files: this._manifestFor(peer) });
  }

  _broadcastManifest() {
    for (const ws of this.conns.values()) this._sendManifest(ws);
  }

  _onManifest(ws, peer, files) {
    ws._remoteFiles = files;
    if (peer.perm === 'ro') return; // 只读设备：不接受它推来的文件
    let needOurManifest = false;
    for (const r of files) {
      const rel = safeRel(r.path || '');
      if (!rel || !this._allowed(peer, rel)) continue;
      if (this.wanted.has(rel)) continue;
      const tomb = this.deleted.get(rel);
      if (tomb && tomb >= (r.mtime || 0)) continue;

      const local = this.manifest.get(rel);
      if (!local) {
        // 秒传：本机已有相同内容
        const dup = this._findByHash(r.hash);
        if (dup && dup !== rel) { this._materialize(dup, rel, r, peer); continue; }
        this._want(ws, rel, r);
      } else if (local.hash !== r.hash) {
        if (this._remoteWins(local, r)) this._want(ws, rel, r);
        else needOurManifest = true;
      }
    }
    if (needOurManifest) this._sendManifest(ws);
  }

  /** 冲突判定（双方用同一规则，保证收敛） */
  _remoteWins(local, remote) {
    const lm = local.mtime || 0;
    const rm = remote.mtime || 0;
    if (rm !== lm) return rm > lm;
    return String(remote.hash) > String(local.hash);
  }

  _findByHash(hash) {
    if (!hash) return null;
    for (const [rel, v] of this.manifest) if (v.hash === hash) return rel;
    return null;
  }

  // ---------------- 请求文件 ----------------
  _want(ws, rel, remote) {
    if (this.wanted.has(rel)) return;
    // 同内容已经在传（或已存在）就不重复拉取，等它落地后走秒传
    if (remote.hash && this.inflightHashes.has(remote.hash)) return;
    if (remote.hash && this._findByHash(remote.hash)) { this._materialize(this._findByHash(remote.hash), rel, remote, this.peers.get(ws._peerId)); return; }
    if (remote.hash) this.inflightHashes.add(remote.hash);
    this.wanted.add(rel);
    try {
      const local = this.manifest.get(rel);
      const canDelta = remote.blocks && remote.blocks.length && local && local.blocks &&
        local.blocks.length && remote.size >= DELTA_MIN && remote.size <= DELTA_MAX && this._exists(rel);

      if (canDelta) {
        const missing = [];
        for (let i = 0; i < remote.blocks.length; i++) if (local.blocks[i] !== remote.blocks[i]) missing.push(i);
        if (missing.length && missing.length < remote.blocks.length) {
          this._seedPartial(rel, remote);
          this.emit('transfer', { direction: 'in', path: rel, sent: 0, total: remote.size, delta: missing.length, blocks: remote.blocks.length });
          this._sendJSON(ws, { type: 'request', path: rel, blocks: missing });
          return;
        }
      }
      // 大文件：多连接分片；按已完成的分片续传
      if (remote.size >= STRIPE_MIN) {
        const total = Math.ceil(remote.size / STRIPE_RANGE);
        const parts = this._readParts(remote.hash);
        const done = new Set(parts.done.filter((i) => Number.isInteger(i) && i >= 0 && i < total));
        const missing = [];
        for (let i = 0; i < total; i++) if (!done.has(i)) missing.push(i);
        this.inBytes.set(rel, Math.min(remote.size, done.size * STRIPE_RANGE));
        this.activePulls.set(rel, { peerId: ws._peerId, at: Date.now() });
        this._sendJSON(ws, { type: 'request', path: rel, ranges: missing });
        return;
      }
      const partial = this._partialPath(remote.hash);
      let offset = 0;
      try { if (fs.existsSync(partial)) offset = Math.min(fs.statSync(partial).size, remote.size); } catch (e) {}
      this._sendJSON(ws, { type: 'request', path: rel, offset });
    } finally {
      setTimeout(() => this.wanted.delete(rel), 30000);
    }
  }

  _partialPath(hash) { return path.join(this.folder, PARTIAL_DIR, hash + '.part'); }
  _partsPath(hash) { return path.join(this.folder, PARTIAL_DIR, hash + '.parts.json'); }

  _readParts(hash) {
    try {
      const o = JSON.parse(fs.readFileSync(this._partsPath(hash), 'utf8'));
      return { total: Number(o.total) || 0, done: Array.isArray(o.done) ? o.done : [] };
    } catch (e) { return { total: 0, done: [] }; }
  }

  _writeParts(hash, obj) {
    try {
      fs.mkdirSync(path.join(this.folder, PARTIAL_DIR), { recursive: true });
      fs.writeFileSync(this._partsPath(hash), JSON.stringify(obj));
    } catch (e) {}
  }

  _clearParts(hash) { try { fs.unlinkSync(this._partsPath(hash)); } catch (e) {} }
  _disk(rel) { return path.join(this.folder, rel.split('/').join(path.sep)); }
  _exists(rel) { try { return fs.statSync(this._disk(rel)).isFile(); } catch (e) { return false; } }

  /** 增量同步前，把本地旧内容铺进临时文件，没变的块就不用传 */
  _seedPartial(rel, remote) {
    try {
      const partial = this._partialPath(remote.hash);
      fs.mkdirSync(path.dirname(partial), { recursive: true });
      fs.copyFileSync(this._disk(rel), partial);
      const st = fs.statSync(partial);
      if (st.size > remote.size) fs.truncateSync(partial, remote.size);
      else if (st.size < remote.size) fs.appendFileSync(partial, Buffer.alloc(0));
    } catch (e) {}
  }

  /** 秒传：复制本机同内容文件到目标路径 */
  _materialize(srcRel, destRel, remote, peer) {
    try {
      const dest = this._disk(destRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const existing = this.manifest.get(destRel);
      let targetRel = destRel;
      if (existing && existing.hash !== remote.hash) {
        const lm = existing.mtime || 0;
        const rm = remote.mtime || 0;
        if (rm > lm) this._archiveVersion(destRel);
        else if (rm < lm) return;
        else targetRel = this._conflictName(destRel, peer); // 同一时刻不同内容：留副本
      }
      const target = this._disk(targetRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.gxj-tmp-' + crypto.randomBytes(3).toString('hex');
      fs.copyFileSync(this._disk(srcRel), tmp);
      this._markWritten(targetRel);
      fs.renameSync(tmp, target);
      this.manifest.set(targetRel, { relPath: targetRel, size: remote.size, hash: remote.hash, mtime: remote.mtime || Date.now(), blocks: remote.blocks, blockSize: remote.blockSize });
      this.deleted.delete(targetRel);
      if (targetRel !== destRel) this.conflicts.set(targetRel, { path: targetRel, original: destRel, peer: peer ? peer.name : '', at: Date.now() });
      this.emit('file-added', { path: targetRel, size: remote.size, from: '秒传', conflict: targetRel !== destRel });
      this.emit('manifest', this.listFiles());
      this._saveCacheLater();
      this.emit('transfer', { direction: 'in', path: targetRel, sent: remote.size, total: remote.size, instant: true });
      this._sweepDuplicates(remote.hash);
    } catch (e) { this.emit('transfer-error', { message: '秒传失败：' + e.message }); }
  }

  // ---------------- 接收 ----------------
  _onFileBegin(ws, peer, msg) {
    if (peer.perm === 'ro') {
      this._sendJSON(ws, { type: 'error', message: '对方设备是只读的，不能接收它推送的文件' });
      ws._dropChunks = true;
      return;
    }
    const rel = safeRel(msg.path || '');
    if (!rel) { ws._dropChunks = true; return; }

    const isRange = Number.isInteger(msg.index) && msg.total > 0;
    if (isRange) {
      const parts = this._readParts(msg.hash);
      if (parts.done.includes(msg.index)) { ws._dropChunks = true; return; }
    }

    const partial = this._partialPath(msg.hash);
    let fd;
    try {
      fs.mkdirSync(path.dirname(partial), { recursive: true });
      fd = fs.openSync(partial, fs.existsSync(partial) ? 'r+' : 'w+');
      if (isRange && msg.end) {
        const cur = fs.fstatSync(fd).size;
        if (cur < msg.end) fs.ftruncateSync(fd, msg.end);
      }
    } catch (e) {
      this._sendJSON(ws, { type: 'error', message: '无法写入临时文件：' + e.message });
      ws._dropChunks = true;
      return;
    }

    let off = Number(msg.offset) || 0;
    if (!isRange) {
      try { off = Math.max(0, Math.min(off, fs.fstatSync(fd).size, msg.size || 0)); } catch (e) {}
    }

    ws._dropChunks = false;
    this.receiving.set(ws, {
      path: rel, size: msg.size, hash: msg.hash, mtime: Number(msg.mtime) || Date.now(),
      received: off, fd, mode: 'stream', blockOffset: 0, blockLen: 0,
      index: isRange ? msg.index : null, total: isRange ? msg.total : 0,
    });

    if (isRange) {
      if (!this.inBytes.has(rel)) this.inBytes.set(rel, this._doneBytes(msg.hash, msg.total, msg.size));
      this.activePulls.set(rel, { peerId: ws._peerId, at: Date.now() });
      this.emit('transfer', { direction: 'in', path: rel, sent: this.inBytes.get(rel), total: msg.size });
    } else if (off > 0) {
      this.emit('transfer', { direction: 'in', path: rel, sent: off, total: msg.size, resumed: true });
    }
  }

  _doneBytes(hash, total, size) {
    const parts = this._readParts(hash);
    let n = 0;
    for (const i of parts.done) {
      if (!Number.isInteger(i) || i < 0 || i >= total) continue;
      n += Math.min(STRIPE_RANGE, Math.max(0, size - i * STRIPE_RANGE));
    }
    return n;
  }

  _onBlockHeader(ws, msg) {
    const st = this.receiving.get(ws);
    if (!st) return;
    st.mode = 'blocks';
    st.blockOffset = (msg.index || 0) * (msg.blockSize || BLOCK);
    st.blockLen = 0;
    st.path = safeRel(msg.path || '') || st.path;
  }

  _onChunk(ws, chunk) {
    if (ws._dropChunks) return;
    const st = this.receiving.get(ws);
    if (!st) return;
    try {
      if (st.mode === 'blocks') {
        fs.writeSync(st.fd, chunk, 0, chunk.length, st.blockOffset + st.blockLen);
        st.blockLen += chunk.length;
        this.emit('transfer', { direction: 'in', path: st.path, sent: st.blockOffset + st.blockLen, total: st.size });
        return;
      }
      fs.writeSync(st.fd, chunk, 0, chunk.length, st.received);
      st.received += chunk.length;
      if (st.index !== null) {
        const cur = Math.min(st.size, (this.inBytes.get(st.path) || 0) + chunk.length);
        this.inBytes.set(st.path, cur);
        const ap = this.activePulls.get(st.path);
        if (ap) ap.at = Date.now();
        this.emit('transfer', { direction: 'in', path: st.path, sent: cur, total: st.size });
      } else {
        this.emit('transfer', { direction: 'in', path: st.path, sent: st.received, total: st.size });
      }
    } catch (e) {
      this.emit('transfer-error', { message: '写入失败：' + e.message });
    }
  }

  async _onFileEnd(ws, msg) {
    const st = this.receiving.get(ws);
    if (!st) return;
    this.receiving.delete(ws);
    try { fs.closeSync(st.fd); } catch (e) {}
    if (ws._dropChunks) { ws._dropChunks = false; return; }

    if (st.index !== null) {
      const parts = this._readParts(st.hash);
      if (!parts.done.includes(st.index)) {
        parts.done.push(st.index);
        this._writeParts(st.hash, { total: st.total, done: parts.done });
      }
      if (parts.done.length < st.total) {
        const ap = this.activePulls.get(st.path);
        if (ap) ap.at = Date.now();
        this.emit('transfer', { direction: 'in', path: st.path, sent: Math.min(st.size, this.inBytes.get(st.path) || 0), total: st.size });
        return;
      }
    }
    await this._finishFile(st, ws);
  }

  /** 分片齐了：校验 + 落地 */
  async _finishFile(st, ws) {
    const partial = this._partialPath(st.hash);
    try {
      const got = await hashFile(partial, st.size >= DELTA_MIN ? BLOCK : 0);
      if (got.hash !== st.hash) {
        try { fs.unlinkSync(partial); } catch (e) {}
        this._clearParts(st.hash);
        this.wanted.delete(st.path);
        this.inflightHashes.delete(st.hash);
        this.inBytes.delete(st.path);
        const peer = this.peers.get(ws._peerId);
        if (peer) {
          if (st.size >= STRIPE_MIN) {
            const total = Math.ceil(st.size / STRIPE_RANGE);
            this._sendJSON(ws, { type: 'request', path: st.path, ranges: [...Array(total).keys()] });
          } else {
            this._sendJSON(ws, { type: 'request', path: st.path, offset: 0 });
          }
        }
        this.emit('transfer-error', { message: '校验失败，正在重新传输：' + st.path });
        return;
      }
      this._place(st.path, partial, { size: got.size, hash: st.hash, blocks: got.blocks, blockSize: BLOCK, mtime: st.mtime || Date.now() }, this.peers.get(ws._peerId));
      this._clearParts(st.hash);
    } catch (e) {
      this.emit('transfer-error', { message: '接收失败：' + e.message });
    } finally {
      this.wanted.delete(st.path);
      this.inflightHashes.delete(st.hash);
      this.inBytes.delete(st.path);
      this.activePulls.delete(st.path);
    }
  }

  /** 把临时文件放到最终位置，处理版本 / 冲突 */
  _place(rel, partial, meta, peer) {
    const dest = this._disk(rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const existing = this.manifest.get(rel);
    let conflict = false;

    if (existing && existing.hash !== meta.hash) {
      const lm = existing.mtime || 0;
      const rm = meta.mtime || 0;
      if (rm > lm) {
        this._archiveVersion(rel);
      } else if (rm < lm) {
        // 对方那份更旧：直接丢掉，保留本机（对方之后会来拉我们的新版本）
        try { fs.unlinkSync(partial); } catch (e) {}
        return;
      } else {
        const copyRel = this._conflictName(rel, peer);
        try {
          fs.mkdirSync(path.dirname(this._disk(copyRel)), { recursive: true });
          fs.renameSync(partial, this._disk(copyRel));
          this._markWritten(copyRel);
          const st = fs.statSync(this._disk(copyRel));
          this.manifest.set(copyRel, { relPath: copyRel, size: st.size, hash: meta.hash, mtime: st.mtimeMs, blocks: meta.blocks, blockSize: meta.blockSize });
          this.conflicts.set(copyRel, { path: copyRel, original: rel, peer: peer ? peer.name : '', at: Date.now() });
          this.emit('conflict', { path: copyRel, original: rel, peer: peer ? peer.name : '' });
          this.emit('file-added', { path: copyRel, size: st.size, from: peer ? peer.name : '对方设备', conflict: true });
          this.emit('manifest', this.listFiles());
          this._saveCacheLater();
        } catch (e) { this.emit('transfer-error', { message: '保存冲突副本失败：' + e.message }); }
        return;
      }
      conflict = true;
    }

    const has = fs.existsSync(dest);
    if (has) { try { fs.unlinkSync(dest); } catch (e) {} }
    this._markWritten(rel);
    fs.renameSync(partial, dest);
    const st = fs.statSync(dest);
    this.manifest.set(rel, { relPath: rel, size: st.size, hash: meta.hash, mtime: st.mtimeMs, blocks: meta.blocks, blockSize: meta.blockSize });
    this.deleted.delete(rel);
    this.emit('file-added', { path: rel, size: st.size, from: peer ? peer.name : '对方设备', conflict });
    this.emit('manifest', this.listFiles());
    this._saveCacheLater();
    this._sweepDuplicates(meta.hash);
  }

  /** 内容落地后，把其它「同哈希但还没到」的文件直接秒传过来 */
  _sweepDuplicates(hash) {
    if (!hash || this._sweeping) return;
    const src = this._findByHash(hash);
    if (!src) return;
    this._sweeping = true;
    try {
      for (const [peerId, ws] of this.conns) {
        const peer = this.peers.get(peerId);
        if (!peer) continue;
        for (const r of ws._remoteFiles || []) {
          const rel = safeRel(r.path || '');
          if (!rel || !this._allowed(peer, rel)) continue;
          if (this.manifest.has(rel) || r.hash !== hash) continue;
          this._materialize(src, rel, r, peer);
        }
      }
    } finally { this._sweeping = false; }
  }

  _conflictName(rel, peer) {
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    const ext = path.posix.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const tag = `冲突副本 ${this.shortId(peer ? peer.deviceId : '')}`;
    let name = `${stem} (${tag})${ext}`;
    let n = 2;
    while (fs.existsSync(this._disk(dir === '.' ? name : dir + '/' + name))) {
      name = `${stem} (${tag} ${n})${ext}`;
      n++;
    }
    return dir === '.' ? name : dir + '/' + name;
  }

  // ---------------- 发送 ----------------
  _enqueue(ws, task) {
    if (!this.sendQueues.has(ws)) this.sendQueues.set(ws, []);
    this.sendQueues.get(ws).push(task);
    if (!ws._sending) this._pump(ws);
  }

  _pump(ws) {
    const q = this.sendQueues.get(ws);
    if (!q || !q.length) { ws._sending = false; return; }
    ws._sending = true;
    const task = q.shift();
    this._sendTask(ws, task, () => this._pump(ws));
  }

  async _sendTask(ws, task, done) {
    const HIGH_WATER = 4 * 1024 * 1024;
    const LOW_WATER = 1024 * 1024;
    const entry = this.manifest.get(task.path);
    const full = this._disk(task.path);
    if (!entry || !fs.existsSync(full)) {
      this._sendJSON(ws, { type: 'error', message: '文件不存在：' + task.path });
      return done();
    }

    const speedT0 = Date.now();
    const isRange = Number.isInteger(task.index) && task.total > 0;
    const start = isRange
      ? Math.max(0, Math.min(task.start, entry.size))
      : Math.max(0, Math.min(task.offset || 0, entry.size));
    const end = isRange ? Math.max(start, Math.min(task.end, entry.size)) : entry.size;
    const sendEnd = () => this._sendJSON(ws, {
      type: 'file_end', path: task.path, hash: entry.hash,
      index: isRange ? task.index : undefined,
    });

    try {
      this._sendJSON(ws, {
        type: 'file_begin', path: task.path, size: entry.size, hash: entry.hash, mtime: entry.mtime,
        offset: start, end,
        index: isRange ? task.index : undefined,
        total: isRange ? task.total : undefined,
      });

      if (task.blocks && task.blocks.length) {
        const fd = fs.openSync(full, 'r');
        const blockSize = entry.blockSize || BLOCK;
        for (const idx of task.blocks) {
          const bStart = idx * blockSize;
          const len = Math.max(0, Math.min(blockSize, entry.size - bStart));
          if (!len) continue;
          const buf = Buffer.allocUnsafe(len);
          fs.readSync(fd, buf, 0, len, bStart);
          this._sendJSON(ws, { type: 'block', index: idx, path: task.path, blockSize });
          this._sendBinary(ws, buf);
          this.emit('transfer', { direction: 'out', path: task.path, sent: bStart + len, total: entry.size, delta: true });
        }
        fs.closeSync(fd);
        sendEnd();
        return done();
      }

      if (start >= end) { sendEnd(); return done(); }

      await new Promise((resolve) => {
        const stream = fs.createReadStream(full, { start, end: Math.max(start, end - 1), highWaterMark: CHUNK });
        ws._activeStream = stream;
        let sent = start;
        let lastData = Date.now();
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearInterval(stallTimer);
          if (ws._activeStream === stream) ws._activeStream = null;
          resolve();
        };
        // 连接抖动时流可能永远等不到 drain：15 秒没有新数据就放弃这一段，交给对端重试
        const stallTimer = setInterval(() => {
          if (Date.now() - lastData > 15000) {
            try { stream.destroy(); } catch (e) {}
            finish();
          }
        }, 5000);
        stream.on('close', finish);
        stream.on('data', (chunk) => {
          lastData = Date.now();
          this._sendBinary(ws, chunk);
          sent += chunk.length;
          if (isRange) this._emitOutProgress(entry, task, sent - start);
          else this.emit('transfer', { direction: 'out', path: task.path, sent, total: entry.size });
          // 背压：对方消化不过来时先别读盘，否则 GB 级文件会把内存堆爆
          if (ws.bufferedAmount > HIGH_WATER) {
            stream.pause();
            const resumeWhenDrained = () => {
              if (ws.readyState !== WebSocket.OPEN) { try { stream.destroy(); } catch (e) {} finish(); return; }
              if (ws.bufferedAmount < LOW_WATER) stream.resume();
              else setTimeout(resumeWhenDrained, 15);
            };
            setTimeout(resumeWhenDrained, 15);
          }
        });
        stream.on('end', finish);
        stream.on('error', finish);
      });
      sendEnd();
    } catch (e) {
      this._sendJSON(ws, { type: 'error', message: '发送失败：' + e.message });
    }

    // 统计这条连接的真实速率，用来决定下次要不要多流
    if (entry.size >= STRIPE_MIN && ws._peerId) {
      const ms = Date.now() - speedT0;
      const bytes = Math.max(0, end - start);
      if (ms > 400 && bytes > 0) {
        const mbs = bytes / 1048576 / (ms / 1000);
        const prev = this.peerSpeed.get(ws._peerId) || 0;
        this.peerSpeed.set(ws._peerId, prev ? prev * 0.6 + mbs * 0.4 : mbs);
      }
    }
    done();
  }

  /** 多流时把各分片的发送量汇总成一条进度 */
  _emitOutProgress(entry, task, bytes) {
    let m = this.outBytes.get(task.path);
    if (!m) { m = new Map(); this.outBytes.set(task.path, m); }
    m.set(task.index, bytes);
    let sum = 0;
    for (const v of m.values()) sum += v;
    this.emit('transfer', { direction: 'out', path: task.path, sent: Math.min(entry.size, sum), total: entry.size });
    if (m.size >= task.total) setTimeout(() => this.outBytes.delete(task.path), 3000);
  }

  /** 收到请求：小文件单流，大文件多连接分片 */
  async _dispatch(ws, msg) {
    const peerId = ws._peerId;
    const entry = this.manifest.get(msg.path);
    if (!entry) { this._sendJSON(ws, { type: 'error', message: '文件不存在：' + msg.path }); return; }
    if (msg.blocks && msg.blocks.length) { this._enqueue(ws, { path: msg.path, blocks: msg.blocks }); return; }

    // 实测：2.4G 手机热点上多流反而慢（单射频转发会互相抢空口）。
    // 所以默认单流，只有「实测速率低于 1.2MB/s 的极慢链路」才自动开多流。
    // 需要强制时设置环境变量 GXJ_STRIPE=1。
    const measured = this.peerSpeed.get(peerId) || 0;
    const wantStripe = process.env.GXJ_STRIPE === '1' || (measured > 0 && measured < 1.2);
    const total = entry.size >= STRIPE_MIN && wantStripe ? Math.ceil(entry.size / STRIPE_RANGE) : 0;
    if (!total) { this._enqueue(ws, { path: msg.path, offset: msg.offset || 0 }); return; }

    const extra = await this._ensureDataConns(peerId);
    const conns = [this.conns.get(peerId), ...extra]
      .filter((w) => w && w.readyState === WebSocket.OPEN && w._secure);
    if (!conns.length) return;

    let list = Array.isArray(msg.ranges) && msg.ranges.length
      ? msg.ranges.filter((i) => Number.isInteger(i) && i >= 0 && i < total)
      : [...Array(total).keys()];
    if (!list.length) list = [...Array(total).keys()];

    list.forEach((idx, i) => {
      const conn = conns[i % conns.length];
      this._enqueue(conn, {
        path: msg.path,
        start: idx * STRIPE_RANGE,
        end: Math.min(entry.size, (idx + 1) * STRIPE_RANGE),
        index: idx,
        total,
      });
    });
  }

  // ---------------- 删除 ----------------
  deleteFile(rel) {
    const safe = safeRel(rel);
    if (!safe) return false;
    const abs = this._disk(safe);
    if (!fs.existsSync(abs)) return false;
    try { this._trashFile(abs, safe); } catch (e) { return false; }
    this.manifest.delete(safe);
    this.deleted.set(safe, Date.now());
    this.emit('manifest', this.listFiles());
    this._broadcast({ type: 'delete', path: safe, ts: this.deleted.get(safe) });
    this._saveCacheLater();
    return true;
  }

  _onAdvert(ws, peer, msg) {
    const rel = safeRel(msg.path || '');
    if (!rel || !msg.hash) return;
    const local = this.manifest.get(rel);
    if (local && local.hash === msg.hash) {
      // 对方发来的文件，本机已经有了
      this.emit('file-dup', { path: rel, peer: peer ? peer.name : '', size: local.size });
      return;
    }
    const dup = this._findByHash(msg.hash);
    if (dup && dup !== rel) {
      this._materialize(dup, rel, { size: msg.size, hash: msg.hash, mtime: Date.now() }, peer);
    }
  }

  _onRemoteDelete(ws, peer, msg) {
    const rel = safeRel(msg.path || '');
    if (!rel) return;
    const local = this.manifest.get(rel);
    if (local && (local.mtime || 0) > (msg.ts || 0)) return; // 本地更新，忽略删除
    const abs = this._disk(rel);
    if (fs.existsSync(abs)) { try { this._trashFile(abs, rel); } catch (e) {} }
    this.manifest.delete(rel);
    this.deleted.set(rel, msg.ts || Date.now());
    this.emit('manifest', this.listFiles());
    this._saveCacheLater();
  }

  _broadcast(obj) { for (const ws of this.conns.values()) this._sendJSON(ws, obj); }

  // ---------------- 回收站 / 版本 ----------------
  _trashFile(abs, rel) {
    const ts = Date.now();
    const id = `${ts}-${crypto.randomBytes(3).toString('hex')}`;
    const dest = path.join(this.folder, TRASH_DIR, id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(abs, dest); } catch (e) { fs.copyFileSync(abs, dest); fs.unlinkSync(abs); }
    const idxPath = path.join(this.folder, TRASH_DIR, 'index.json');
    let idx = {};
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
    idx[id] = { id, path: rel, ts, size: (() => { try { return fs.statSync(dest).size; } catch (e) { return 0; } })() };
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
    return id;
  }

  listTrash() {
    const idxPath = path.join(this.folder, TRASH_DIR, 'index.json');
    let idx = {};
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
    return Object.values(idx).sort((a, b) => b.ts - a.ts);
  }

  restoreTrash(id) {
    const idxPath = path.join(this.folder, TRASH_DIR, 'index.json');
    let idx = {};
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
    const item = idx[id];
    if (!item) return { ok: false, message: '回收站里没有这一项' };
    const src = path.join(this.folder, TRASH_DIR, id);
    if (!fs.existsSync(src)) { delete idx[id]; fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2)); return { ok: false, message: '文件已不存在' }; }
    let target = safeRel(item.path) || path.basename(item.path);
    let n = 2;
    while (fs.existsSync(this._disk(target))) {
      const ext = path.posix.extname(target);
      target = `${target.slice(0, target.length - ext.length)} (恢复 ${n})${ext}`;
      n++;
    }
    const dest = this._disk(target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(src, dest); } catch (e) { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
    delete idx[id];
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
    try { const now = new Date(); fs.utimesSync(dest, now, now); } catch (e) {}
    this.deleted.delete(target);
    this._noteFile(target).then(() => {
      this.emit('manifest', this.listFiles());
      this._broadcastManifest();
    });
    return { ok: true, path: target };
  }

  deleteTrash(id) {
    const src = path.join(this.folder, TRASH_DIR, id);
    try { fs.rmSync(src, { force: true }); } catch (e) {}
    const idxPath = path.join(this.folder, TRASH_DIR, 'index.json');
    let idx = {};
    try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (e) {}
    delete idx[id];
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
    return { ok: true };
  }

  emptyTrash() {
    for (const item of this.listTrash()) this.deleteTrash(item.id);
    return { ok: true };
  }

  _pruneTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    for (const item of this.listTrash()) if (item.ts < cutoff) this.deleteTrash(item.id);
  }

  /**
   * 存一份版本快照。
   * 外部编辑器是就地覆盖的，等 watcher 发现时旧内容已经没了，
   * 所以策略是「每看到一个新状态就存一份」，列表里再过滤掉当前版本。
   */
  _archiveVersion(rel, maxSize = 20 * 1024 * 1024) {
    try {
      const abs = this._disk(rel);
      if (!fs.existsSync(abs)) return;
      const st = fs.statSync(abs);
      if (st.size > maxSize) return;
      const cur = this.manifest.get(rel);
      const hash8 = cur && cur.hash ? String(cur.hash).slice(0, 8) : 'x';
      const dir = path.join(this.folder, VERSION_DIR, encodeURIComponent(rel));
      fs.mkdirSync(dir, { recursive: true });
      const names = fs.readdirSync(dir);
      if (names.some((n) => n.endsWith('-' + hash8))) return; // 这个状态已经存过
      fs.copyFileSync(abs, path.join(dir, `${Date.now()}-${hash8}`));
      this.versionPaths.add(rel);
      const sorted = fs.readdirSync(dir).sort();
      while (sorted.length > VERSION_KEEP) {
        const oldName = sorted.shift();
        try { fs.unlinkSync(path.join(dir, oldName)); } catch (e) {}
      }
      this._syncVersionFlag(rel);
    } catch (e) {}
  }

  /** 只有存在「和当前内容不同」的旧版本，才在界面上标记有历史 */
  _syncVersionFlag(rel) {
    try {
      const dir = path.join(this.folder, VERSION_DIR, encodeURIComponent(rel));
      const names = fs.readdirSync(dir);
      const cur = this.manifest.get(rel);
      const cur8 = cur && cur.hash ? String(cur.hash).slice(0, 8) : '';
      if (cur8 && names.some((n) => !n.endsWith('-' + cur8))) this.versionPaths.add(rel);
      else this.versionPaths.delete(rel);
    } catch (e) { this.versionPaths.delete(rel); }
  }

  listVersions(rel) {
    const safe = safeRel(rel);
    if (!safe) return [];
    const dir = path.join(this.folder, VERSION_DIR, encodeURIComponent(safe));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const cur = this.manifest.get(safe);
    const curHash8 = cur && cur.hash ? String(cur.hash).slice(0, 8) : '';
    return names
      .filter((n) => !curHash8 || !n.endsWith('-' + curHash8))
      .sort()
      .reverse()
      .map((n) => {
        const ts = Number(n.split('-')[0]) || 0;
        let size = 0;
        try { size = fs.statSync(path.join(dir, n)).size; } catch (e) {}
        return { id: n, at: ts, size };
      });
  }

  restoreVersion(rel, id) {
    const safe = safeRel(rel);
    if (!safe) return { ok: false, message: '路径不合法' };
    const src = path.join(this.folder, VERSION_DIR, encodeURIComponent(safe), String(id).replace(/[^0-9a-zA-Z-]/g, ''));
    if (!fs.existsSync(src)) return { ok: false, message: '版本不存在' };
    this._archiveVersion(safe);
    const dest = this._disk(safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    try { const now = new Date(); fs.utimesSync(dest, now, now); } catch (e) {}
    this._markWritten(safe);
    this._noteFile(safe).then(() => {
      this.emit('manifest', this.listFiles());
      this._broadcastManifest();
    });
    return { ok: true };
  }

  // ---------------- 本地扫描 ----------------
  _loadVersions() {
    try {
      for (const name of fs.readdirSync(path.join(this.folder, VERSION_DIR))) {
        try { this.versionPaths.add(decodeURIComponent(name)); } catch (e) {}
      }
    } catch (e) {}
  }

  _loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._cachePath(), 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.hashCache.set(k, v);
    } catch (e) {}
  }

  _saveCacheLater() {
    if (this._cacheTimer) return;
    this._cacheTimer = setTimeout(() => {
      this._cacheTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this.hashCache) obj[k] = v;
        fs.writeFileSync(this._cachePath(), JSON.stringify(obj));
      } catch (e) {}
    }, 1500);
  }

  _walk(dir, base = '') {
    const out = [];
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const d of list) {
      const rel = base ? base + '/' + d.name : d.name;
      if (isInternal(rel)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) out.push(...this._walk(full, rel));
      else if (d.isFile()) out.push(rel);
    }
    return out;
  }

  async _hashRel(rel) {
    const abs = this._disk(rel);
    const st = fs.statSync(abs);
    const cached = this.hashCache.get(rel);
    const needBlocks = st.size >= DELTA_MIN && st.size <= DELTA_MAX;
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && (!!cached.blocks === needBlocks || !needBlocks)) {
      return cached;
    }
    const got = await hashFile(abs, needBlocks ? BLOCK : 0);
    const entry = { size: got.size, mtimeMs: st.mtimeMs, hash: got.hash, blocks: needBlocks ? got.blocks : undefined };
    this.hashCache.set(rel, entry);
    return entry;
  }

  async scanFolder() {
    this.manifest.clear();
    const rels = this._walk(this.folder);
    for (const rel of rels) {
      try {
        const h = await this._hashRel(rel);
        this.manifest.set(rel, { relPath: rel, size: h.size, hash: h.hash, mtime: h.mtimeMs, blocks: h.blocks, blockSize: BLOCK });
        if (h.size <= 5 * 1024 * 1024) this._archiveVersion(rel, 5 * 1024 * 1024);
        else this._syncVersionFlag(rel);
      } catch (e) {}
    }
    // 清理已经不存在的缓存项
    for (const rel of [...this.hashCache.keys()]) if (!this.manifest.has(rel)) this.hashCache.delete(rel);
    this._saveCacheLater();
    this.emit('manifest', this.listFiles());
  }

  async _noteFile(rel) {
    try {
      const h = await this._hashRel(rel);
      this.manifest.set(rel, { relPath: rel, size: h.size, hash: h.hash, mtime: h.mtimeMs, blocks: h.blocks, blockSize: BLOCK });
      this._archiveVersion(rel);
      this._syncVersionFlag(rel);
      this.deleted.delete(rel);
      this.emit('manifest', this.listFiles());
      this._broadcastManifest();
    } catch (e) {}
  }

  listFiles() {
    return [...this.manifest.entries()]
      .map(([rel, v]) => {
        const parts = rel.split('/');
        return {
          path: rel,
          name: parts[parts.length - 1],
          dir: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
          size: v.size,
          mtime: v.mtime,
          hash: v.hash,
          hasVersions: this.versionPaths.has(rel),
          conflict: this.conflicts.has(rel),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  _markWritten(rel) {
    this.recentlyWritten.add(rel);
    setTimeout(() => this.recentlyWritten.delete(rel), 6000);
  }

  startWatcher() {
    if (this.watcher) this.watcher.close();
    this.watcher = chokidar.watch(this.folder, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p) => {
        const rel = path.relative(this.folder, p);
        if (!rel || rel === '') return false;
        const seg = rel.split(path.sep);
        return seg.some((s) => s.startsWith('.'));
      },
    });
    const onChange = async (p) => {
      const rel = path.relative(this.folder, p).split(path.sep).join('/');
      if (!rel || isInternal(rel) || this.recentlyWritten.has(rel)) return;
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return;
        const h = await this._hashRel(rel);
        const old = this.manifest.get(rel);
        if (old && old.hash === h.hash) return;
        this.manifest.set(rel, { relPath: rel, size: h.size, hash: h.hash, mtime: h.mtimeMs, blocks: h.blocks, blockSize: BLOCK });
        this._archiveVersion(rel); // 记录新状态（首次发现也存，保证第一次修改前的版本还在）
        this._syncVersionFlag(rel);
        this.deleted.delete(rel);
        this.emit('file-added', { path: rel, size: h.size, from: '本机' });
        this.emit('manifest', this.listFiles());
        this._broadcastManifest();
        // 告诉对端「我发了这个文件」：即使对方已有同内容，也能给出反馈
        this._broadcast({ type: 'file-advert', path: rel, hash: h.hash, size: h.size, name: this.name });
        this._saveCacheLater();
      } catch (e) {}
    };
    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('unlink', (p) => {
      const rel = path.relative(this.folder, p).split(path.sep).join('/');
      if (!rel || isInternal(rel) || this.recentlyWritten.has(rel)) return;
      const entry = this.manifest.get(rel);
      if (!entry) return;
      this.manifest.delete(rel);
      this.deleted.set(rel, Date.now());
      this.hashCache.delete(rel);
      this.emit('manifest', this.listFiles());
      this._broadcast({ type: 'delete', path: rel, ts: this.deleted.get(rel) });
      this._saveCacheLater();
    });
  }
}

module.exports = { PeerManager, sha256, hashFile, safeRel };
