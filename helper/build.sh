#!/usr/bin/env bash
# Build the macOS notification helper into helper/build/DSHNotifier.app.
#
# The helper posts one notification per invocation and, on click, records the
# pending session for the DSH client half and brings DeepSeek Harness forward.
# It is ad-hoc signed, which is enough for local notifications on macOS; the
# system asks for notification permission the first time it runs.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="$here/build/DSHNotifier.app"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found: install the Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
mkdir -p "$here/../.build"
cp "$here/Info.plist" "$app/Contents/Info.plist"
# Banners use the app icon; render it from the plugin artwork when missing.
if [ ! -f "$here/AppIcon.icns" ]; then
  "$here/make-icon.sh" || echo "warning: could not render AppIcon.icns; using the generic app icon" >&2
fi
[ -f "$here/AppIcon.icns" ] && cp "$here/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"
# Keep compiler caches inside the package: sandboxed or read-only home caches
# otherwise fail with an unrelated "SDK is not supported by the compiler" error.
export SWIFT_MODULECACHE_PATH="$here/../.build/swift-module-cache"
export CLANG_MODULE_CACHE_PATH="$here/../.build/clang-module-cache"
swiftc -O -module-cache-path "$SWIFT_MODULECACHE_PATH" \
  -o "$app/Contents/MacOS/DSHNotifier" "$here/DSHNotifier.swift" \
  -framework Cocoa -framework UserNotifications

codesign --force --sign - "$app" >/dev/null 2>&1 || true

# Register the bundle with LaunchServices so the notification identity (and the
# permission prompt) names "DSH Notifier" instead of a bare binary.
launchservices="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$launchservices" ] && "$launchservices" -f "$app" || true

echo "built $app"
