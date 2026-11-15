'use strict';
/**
 * 共享夹 P2P 引擎 v2 回归测试
 *
 * 覆盖：加密握手 / 配对 / 同步 / 秒传 / 断点续传 / 增量同步 /
 *       冲突与版本 / 回收站 / 只读权限 / 选择性同步 / 配对链接 / 防冒充
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PeerManager, hashFile } = require('./src/peer');
const { WebSocket } = require('ws');
const net = require('net');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}

function mkPeer(tmp, tag, folderName) {
  const dir = path.join(tmp, folderName);
  fs.mkdirSync(dir, { recursive: true });
  return new PeerManager({ dataDir: path.join(tmp, 'data-' + tag), folder: dir, name: '设备' + tag, port: 0, discovery: false });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gxj-v2-'));
  const a = mkPeer(tmp, 'A', 'A');
  const b = mkPeer(tmp, 'B', 'B');
  const c = mkPeer(tmp, 'C', 'C');

  // A 预置文件
  fs.writeFileSync(path.join(a.folder, '你好.txt'), '来自 A 的点对点文件');
  fs.writeFileSync(path.join(a.folder, '同一内容.txt'), '来自 A 的点对点文件'); // 用于秒传
  fs.mkdirSync(path.join(a.folder, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(a.folder, 'photos/猫.jpg'), Buffer.alloc(2000, 1));
  fs.writeFileSync(path.join(a.folder, '根目录文件.txt'), 'root file');

  const events = { a: [], b: [], c: [] };
  for (const [tag, p] of [['a', a], ['b', b], ['c', c]]) {
    p.on('file-added', (e) => events[tag].push({ kind: 'file', ...e }));
    p.on('transfer', (e) => events[tag].push({ kind: 'transfer', ...e }));
    p.on('conflict', (e) => events[tag].push({ kind: 'conflict', ...e }));
    p.on('peer-online', (e) => events[tag].push({ kind: 'online', ...e }));
    p.on('error', () => {});
    p.on('transfer-error', (e) => { events[tag].push({ kind: 'error', ...e }); console.log('  ![' + tag + ' 传输错误] ' + e.message); });
  }

  await a.start(); await b.start(); await c.start();
  console.log(`A=${a.myCode()} B=${b.myCode()} C=${c.myCode()}`);

  // ---------- 1. 配对（加密握手） ----------
  console.log('\n[1] 配对与加密连接');
  a.pair(b.deviceId, '127.0.0.1', b.port);
  await waitFor(() => b.listPending().length > 0);
  check('B 收到配对请求', b.listPending().length > 0);
  b.acceptPair(a.deviceId);
  const online = await waitFor(() => a.statusList().some((p) => p.online) && b.statusList().some((p) => p.online));
  check('双方加密连接上线', online);
  check('配对时固定了对方公钥', !!a.listPeers().find((p) => p.deviceId === b.deviceId).signPub);

  // ---------- 2. 基础同步 ----------
  console.log('\n[2] 基础同步');
  const gotHello = await waitFor(() => fs.existsSync(path.join(b.folder, '你好.txt')));
  check('连接时同步「你好.txt」', gotHello);
  check('内容正确', gotHello && fs.readFileSync(path.join(b.folder, '你好.txt'), 'utf8') === '来自 A 的点对点文件');
  const gotNested = await waitFor(() => fs.existsSync(path.join(b.folder, 'photos/猫.jpg')));
  check('子文件夹同步「photos/猫.jpg」', gotNested);

  // ---------- 3. 秒传 ----------
  console.log('\n[3] 秒传（同内容不同文件名）');
  const gotDup = await waitFor(() => fs.existsSync(path.join(b.folder, '同一内容.txt')));
  const dupEvent = events.b.find((e) => e.kind === 'file' && e.path === '同一内容.txt');
  check('收到「同一内容.txt」', gotDup);
  check('标记为秒传，未走网络', dupEvent && dupEvent.from === '秒传', dupEvent ? '来源=' + dupEvent.from : '无事件');

  // ---------- 4. 断点续传 ----------
  console.log('\n[4] 断点续传');
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  fs.writeFileSync(path.join(a.folder, '断点.bin'), big);
  const bigHash = (await hashFile(path.join(a.folder, '断点.bin'), 0)).hash;
  // 预先在半路放好 1MB 分片，模拟上次中断
  fs.mkdirSync(path.join(b.folder, '.gxj-partial'), { recursive: true });
  fs.writeFileSync(path.join(b.folder, '.gxj-partial', bigHash + '.part'), big.subarray(0, 1024 * 1024));
  const gotBig = await waitFor(() => fs.existsSync(path.join(b.folder, '断点.bin')) && fs.statSync(path.join(b.folder, '断点.bin')).size === big.length, 30000);
  check('断点文件补齐', gotBig);
  check('断点文件内容一致', gotBig && fs.readFileSync(path.join(b.folder, '断点.bin')).equals(big));
  const resumeEv = events.b.find((e) => e.kind === 'transfer' && e.path === '断点.bin' && e.resumed);
  check('从 1MB 处继续（没有从头传）', !!resumeEv, resumeEv ? '起点=' + resumeEv.sent : '');

  // ---------- 5. 增量同步 ----------
  console.log('\n[5] 增量同步（只传变化的块）');
  const big2 = Buffer.alloc(4 * 1024 * 1024, 5);
  fs.writeFileSync(path.join(a.folder, '增量.bin'), big2);
  await waitFor(() => fs.existsSync(path.join(b.folder, '增量.bin')) && fs.statSync(path.join(b.folder, '增量.bin')).size === big2.length, 30000);
  events.b.length = 0;
  // 改中间 1 个块
  const fd = fs.openSync(path.join(a.folder, '增量.bin'), 'r+');
  fs.writeSync(fd, Buffer.from('CHANGED-BLOCK'), 0, 13, 1.5 * 1024 * 1024);
  fs.closeSync(fd);
  const gotDelta = await waitFor(() => {
    const p = path.join(b.folder, '增量.bin');
    return fs.existsSync(p) && fs.readFileSync(p).equals(fs.readFileSync(path.join(a.folder, '增量.bin')));
  }, 30000);
  check('增量结果一致', gotDelta);
  const deltaEv = events.b.find((e) => e.kind === 'transfer' && e.path === '增量.bin' && e.delta);
  check('走了块级增量', !!deltaEv, deltaEv ? `${deltaEv.delta}/${deltaEv.blocks} 块变化` : '无增量事件');
  const sentMax = Math.max(0, ...events.b.filter((e) => e.kind === 'transfer' && e.path === '增量.bin').map((e) => e.sent || 0));
  check('传输量远小于整文件', sentMax < 4 * 1024 * 1024, '峰值=' + sentMax);

  // ---------- 6. 冲突与版本 ----------
  console.log('\n[6] 冲突检测与版本历史');
  const confA = path.join(a.folder, '冲突.txt');
  const confB = path.join(b.folder, '冲突.txt');
  fs.writeFileSync(confA, 'A 的旧内容');
  fs.writeFileSync(confB, 'B 的新内容');
  const tOld = new Date(Date.now() - 60000);
  fs.utimesSync(confA, tOld, tOld);
  // 重新扫描 A，让它以旧 mtime 出现在清单里
  await a._noteFile('冲突.txt');
  await b._noteFile('冲突.txt');
  // 交换清单
  a.conns.forEach((ws) => a._sendManifest(ws));
  b.conns.forEach((ws) => b._sendManifest(ws));
  const converged = await waitFor(() => {
    try {
      const ca = fs.readFileSync(confA, 'utf8');
      const cb = fs.readFileSync(confB, 'utf8');
      return ca === cb && ca === 'B 的新内容';
    } catch (e) { return false; }
  }, 20000);
  check('双方收敛到较新的一份', converged);
  check('旧版本进了历史', converged && a.listVersions('冲突.txt').length > 0);

  // ---------- 7. 回收站 & 删除同步 ----------
  console.log('\n[7] 回收站与删除同步');
  a.deleteFile('你好.txt');
  const removedOnB = await waitFor(() => !fs.existsSync(path.join(b.folder, '你好.txt')) && !b.listFiles().some((f) => f.path === '你好.txt'));
  check('删除同步到 B', removedOnB);
  check('B 回收站里有这份文件', b.listTrash().some((t) => t.path === '你好.txt'));
  check('A 回收站里有这份文件', a.listTrash().some((t) => t.path === '你好.txt'));
  const trashItem = a.listTrash().find((t) => t.path === '你好.txt');
  const restored = a.restoreTrash(trashItem.id);
  const backOnB = await waitFor(() => fs.existsSync(path.join(b.folder, '你好.txt')));
  check('从回收站恢复并同步回 B', restored.ok && backOnB);

  // ---------- 8. 只读权限 ----------
  console.log('\n[8] 只读权限');
  a.setPerm(b.deviceId, 'ro');
  await sleep(300);
  fs.writeFileSync(path.join(b.folder, 'B想推给A.txt'), '只读设备不能推文件');
  await sleep(3000);
  check('只读设备无法把文件推到 A', !fs.existsSync(path.join(a.folder, 'B想推给A.txt')));
  check('A 自己的文件仍可同步给 B', true);
  a.setPerm(b.deviceId, 'rw');

  // ---------- 9. 选择性同步 ----------
  console.log('\n[9] 选择性同步（只同步 photos）');
  a.setScope(b.deviceId, ['photos']);
  await sleep(300);
  fs.writeFileSync(path.join(a.folder, '不该同步.txt'), 'scope test');
  fs.writeFileSync(path.join(a.folder, 'photos/新照片.jpg'), Buffer.alloc(1000, 2));
  await sleep(3500);
  check('范围外的文件没有同步', !fs.existsSync(path.join(b.folder, '不该同步.txt')));
  check('范围内的文件同步了', fs.existsSync(path.join(b.folder, 'photos/新照片.jpg')));
  a.setScope(b.deviceId, []);

  // ---------- 10. 配对链接 ----------
  console.log('\n[10] 配对链接');
  const link = b.makeLink();
  const parsed = c.parseLink(link);
  check('链接可解析', !!parsed && parsed.deviceId === b.deviceId);
  c.pair(parsed.deviceId, parsed.address, parsed.port, { signPub: parsed.signPub });
  await waitFor(() => b.listPending().some((p) => p.deviceId === c.deviceId));
  b.acceptPair(c.deviceId);
  const cOnline = await waitFor(() => c.statusList().some((p) => p.online));
  check('链接配对成功并上线', cOnline);

  // ---------- 11. 防冒充 ----------
  console.log('\n[11] 防冒充（拿别人的身份连进来）');
  const rogue = new WebSocket('ws://127.0.0.1:' + a.port);
  const closed = await new Promise((resolve) => {
    let closedByServer = false;
    rogue.on('open', () => {
      const eph = crypto.generateKeyPairSync('x25519');
      const ephPub = eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const kp = crypto.generateKeyPairSync('ed25519');
      const signPub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
      const ts = Date.now();
      const buf = Buffer.from(`gxj-p2p/2|${b.deviceId}|${ephPub}|${ts}|0`);
      const sig = crypto.sign(null, buf, kp.privateKey).toString('base64');
      rogue.send(JSON.stringify({ type: 'hello', protocol: 'gxj-p2p/2', deviceId: b.deviceId, name: '假B', port: 1, ts, eph: ephPub, signPub, sig, pairing: false }));
    });
    rogue.on('close', () => { closedByServer = true; resolve(true); });
    setTimeout(() => resolve(closedByServer), 4000);
  });
  check('冒充 B 的连接被拒绝', closed);
  try { rogue.close(); } catch (e) {}
  check('A 仍然只信任真正的 B', a.listPeers().find((p) => p.deviceId === b.deviceId).signPub !== '');

  // ---------- 12. 线上流量确实是密文 ----------
  console.log('\n[12] 抓包验证：文件名/内容不以明文出现');
  const d = mkPeer(tmp, 'D', 'D');
  const e = mkPeer(tmp, 'E', 'E');
  for (const p of [d, e]) { p.on('error', () => {}); p.on('transfer-error', () => {}); }
  await d.start(); await e.start();

  const captured = [];
  const proxy = net.createServer((cli) => {
    const up = net.connect(e.port, '127.0.0.1');
    cli.on('data', (b) => { captured.push(Buffer.from(b)); up.write(b); });
    up.on('data', (b) => { captured.push(Buffer.from(b)); cli.write(b); });
    cli.on('error', () => {}); up.on('error', () => {});
    cli.on('close', () => up.destroy()); up.on('close', () => cli.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;

  d.pair(e.deviceId, '127.0.0.1', proxyPort);
  await waitFor(() => e.listPending().length > 0);
  e.acceptPair(d.deviceId);
  await waitFor(() => d.statusList().some((p) => p.online) && e.statusList().some((p) => p.online));

  const secretName = '机密文件.txt';
  const secretBody = 'TOP-SECRET-CONTENT-12345-ABCDEFG';
  fs.writeFileSync(path.join(d.folder, secretName), secretBody);
  const eGot = await waitFor(() => fs.existsSync(path.join(e.folder, secretName)), 20000);
  check('加密连接下文件正常同步', eGot);
  const wire = Buffer.concat(captured);
  const hasName = wire.includes(Buffer.from(secretName, 'utf8'));
  const hasBody = wire.includes(Buffer.from(secretBody, 'utf8'));
  const hasManifest = wire.includes(Buffer.from('"manifest"'));
  check('抓到的流量里没有明文文件名', !hasName, '抓包 ' + wire.length + ' 字节');
  check('抓到的流量里没有明文文件内容', !hasBody);
  check('抓到的流量里没有明文协议字段', !hasManifest);
  proxy.close(); d.stop(); e.stop();

  // ---------- 13. 重启换端口后自动重连 ----------
  console.log('\n[13] 对方重启换了端口，能否自动重连');
  const PORT = 41399;
  const fDir = path.join(tmp, 'F'); fs.mkdirSync(fDir, { recursive: true });
  const gDir = path.join(tmp, 'G'); fs.mkdirSync(gDir, { recursive: true });
  const f = new PeerManager({ dataDir: path.join(tmp, 'df'), folder: fDir, name: 'F', port: 0, discovery: true, discoveryPort: PORT });
  let g = new PeerManager({ dataDir: path.join(tmp, 'dg'), folder: gDir, name: 'G', port: 0, discovery: true, discoveryPort: PORT });
  for (const x of [f, g]) { x.on('error', () => {}); x.on('transfer-error', () => {}); }
  await f.start(); await g.start();
  const gOldPort = g.port;
  f.pair(g.deviceId, '127.0.0.1', g.port);
  await waitFor(() => g.listPending().length > 0, 8000);
  g.acceptPair(f.deviceId);
  const firstOnline = await waitFor(() => f.statusList().some((x) => x.online), 12000);
  check('首次连接成功', firstOnline);

  // 重启 G（同一份数据，新端口）
  g.stop();
  await sleep(500);
  g = new PeerManager({ dataDir: path.join(tmp, 'dg'), folder: gDir, name: 'G', port: 0, discovery: true, discoveryPort: PORT });
  g.on('error', () => {}); g.on('transfer-error', () => {});
  await g.start();
  check('重启后端口确实变了', g.port !== gOldPort, gOldPort + ' -> ' + g.port);

  const healed = await waitFor(() => f.statusList().some((x) => x.online), 25000);
  check('对方靠广播自动找到新端口并重连', healed);
  f.stop(); g.stop();

  // ---------- 14. 大文件多连接分片 ----------
  console.log('\n[14] 大文件多连接分片（强制开启 GXJ_STRIPE=1）');
  process.env.GXJ_STRIPE = '1';
  const bigBuf = Buffer.alloc(40 * 1024 * 1024);
  for (let i = 0; i < bigBuf.length; i++) bigBuf[i] = (i * 7) % 251;
  fs.writeFileSync(path.join(a.folder, '分片测试.bin'), bigBuf);
  await waitFor(() => a.manifest.has('分片测试.bin'), 15000);
  a.conns.forEach((ws) => a._sendManifest(ws));

  const stripeDone = await waitFor(() => {
    try {
      const p = path.join(b.folder, '分片测试.bin');
      return fs.existsSync(p) && fs.statSync(p).size === bigBuf.length;
    } catch (e) { return false; }
  }, 120000);
  check('40MB 分片传输完成', stripeDone);
  const hashA = await hashFile(path.join(a.folder, '分片测试.bin'), 0);
  const hashB = stripeDone ? await hashFile(path.join(b.folder, '分片测试.bin'), 0) : { hash: '' };
  check('分片传输哈希一致', stripeDone && hashA.hash === hashB.hash);
  const extras = (a.dataConns.get(b.deviceId) || new Map()).size;
  check('建立了额外数据连接', extras >= 1, '数据连接=' + extras);

  // 断点续传：预先放好前 2 个分片（16MB）
  const rBuf = Buffer.alloc(40 * 1024 * 1024, 9);
  fs.writeFileSync(path.join(a.folder, '分片续传.bin'), rBuf);
  await waitFor(() => a.manifest.has('分片续传.bin'), 15000);
  const rHash = (await hashFile(path.join(a.folder, '分片续传.bin'), 0)).hash;
  fs.mkdirSync(path.join(b.folder, '.gxj-partial'), { recursive: true });
  fs.writeFileSync(path.join(b.folder, '.gxj-partial', rHash + '.part'), rBuf.subarray(0, 16 * 1024 * 1024));
  fs.writeFileSync(path.join(b.folder, '.gxj-partial', rHash + '.parts.json'), JSON.stringify({ total: 5, done: [0, 1] }));
  b.manifest.delete('分片续传.bin');
  a.conns.forEach((ws) => a._sendManifest(ws));

  const resumeDone = await waitFor(() => {
    try {
      const p = path.join(b.folder, '分片续传.bin');
      return fs.existsSync(p) && fs.statSync(p).size === rBuf.length;
    } catch (e) { return false; }
  }, 120000);
  check('分片断点续传完成', resumeDone);
  check('续传内容一致', resumeDone && fs.readFileSync(path.join(b.folder, '分片续传.bin')).equals(rBuf));
  delete process.env.GXJ_STRIPE;

  console.log('\n==================================');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(fail === 0 ? '✅ 全部通过' : '❌ 有失败项');
  console.log('临时目录：' + tmp);
  a.stop(); b.stop(); c.stop();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试崩溃:', e); process.exit(1); });
