// 用 1024 PNG 生成 Windows .ico（PNG 压缩帧，Vista+ 支持）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const src = path.join(dir, 'icon-1024.png');
const sizes = [16, 24, 32, 48, 64, 128, 256];

const pngs = sizes.map((s) => {
  const out = path.join(dir, `tmp-${s}.png`);
  execFileSync('sips', ['-z', String(s), String(s), src, '--out', out], { stdio: 'ignore' });
  return { size: s, data: fs.readFileSync(out) };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);

let offset = 6 + 16 * pngs.length;
const entries = [];
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(p.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += p.data.length;
}

const out = Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
fs.writeFileSync(path.join(dir, 'icon.ico'), out);
for (const p of pngs) fs.unlinkSync(path.join(dir, `tmp-${p.size}.png`));
console.log('icon.ico', out.length, 'bytes', sizes.join('/'));
