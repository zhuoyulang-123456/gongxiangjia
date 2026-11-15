#!/bin/bash
# 共享夹 · 一条命令打两个平台
# 用法：bash build/build-all.sh
set -e
cd "$(dirname "$0")/.."

VER=$(node -p "require('./package.json').version")
echo "▶ 打包版本 $VER"

export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rm -rf ../dist

echo "▶ macOS（universal，Intel + Apple Silicon）"
./node_modules/.bin/electron-packager . "共享夹" \
  --platform=darwin --arch=universal --out=../dist \
  --icon=build/icon.icns --overwrite \
  --app-bundle-id=com.gongxiangjia.desktop --app-version="$VER" \
  --ignore="^/(build|p2p-test\.js|\.npmrc)" | tail -2

APP="../dist/共享夹-darwin-universal/共享夹.app"
cp build/icon.icns "$APP/Contents/Resources/app.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile app.icns" "$APP/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string app.icns" "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP" 2>&1 | tail -1

echo "▶ Windows x64"
./node_modules/.bin/electron-packager . "共享夹" \
  --platform=win32 --arch=x64 --out=../dist \
  --icon=build/icon.ico --overwrite --app-version="$VER" \
  --ignore="^/(build|p2p-test\.js|\.npmrc)" \
  --win32metadata.CompanyName="共享夹" \
  --win32metadata.ProductName="共享夹" \
  --win32metadata.FileDescription="共享夹 - 点对点文件同步" | tail -1

echo "▶ 压缩 Windows 包"
cd ../dist
python3 - <<'PY'
import os, zipfile
root = '共享夹-win32-x64'
out = '共享夹-Windows-x64.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort(); filenames.sort()
        for name in filenames:
            full = os.path.join(dirpath, name)
            z.write(full, os.path.relpath(full, root))
print('  zip ok')
PY

echo "✅ 完成：dist/共享夹-darwin-universal/共享夹.app  与  dist/共享夹-Windows-x64.zip"
