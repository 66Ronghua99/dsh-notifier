#!/usr/bin/env bash
# Render helper/AppIcon.icns from the plugin icon so banners show the bell
# instead of a generic app icon.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
target="$here/AppIcon.icns"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Quick Look renders SVG through the same path Finder uses; give it a square
# canvas so the 36-unit artwork fills the image instead of sitting in a corner.
sed 's/width="36" height="36"/width="1024" height="1024"/' "$root/icon.svg" > "$work/icon-1024.svg"
qlmanage -t -s 1024 -o "$work" "$work/icon-1024.svg" >/dev/null 2>&1
base="$work/icon-1024.svg.png"
if [ ! -f "$base" ]; then
  echo "icon render failed (qlmanage produced no image)" >&2
  exit 1
fi

iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 64 128 256 512 1024; do
  sips -z "$size" "$size" "$base" --out "$iconset/icon_${size}x${size}.png" >/dev/null
done
cp "$iconset/icon_16x16.png" "$iconset/icon_16x16@2x.png" 2>/dev/null || true
cp "$iconset/icon_32x32.png" "$iconset/icon_32x32@2x.png" 2>/dev/null || true
cp "$iconset/icon_128x128.png" "$iconset/icon_128x128@2x.png" 2>/dev/null || true
cp "$iconset/icon_256x256.png" "$iconset/icon_256x256@2x.png" 2>/dev/null || true
cp "$iconset/icon_512x512.png" "$iconset/icon_512x512@2x.png" 2>/dev/null || true

iconutil -c icns "$iconset" -o "$target"
echo "wrote $target"
