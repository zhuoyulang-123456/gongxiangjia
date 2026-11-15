// 把任意 SVG 渲染成指定尺寸 PNG（用于安卓自适应图标前景）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();
const [, , inFile, outFile] = process.argv;
app.whenReady().then(async () => {
  const svg = fs.readFileSync(inFile, 'utf8');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body>${svg}</body></html>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 900));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(outFile, img.toPNG());
  console.log('written', outFile, img.getSize());
  app.quit();
});
