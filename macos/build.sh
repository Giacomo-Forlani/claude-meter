#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
out=../dist/macos
mkdir -p "$out"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bundle="$work/Claude Meter.app"
mkdir -p "$bundle/Contents/MacOS"
cp Info.plist "$bundle/Contents/Info.plist"
plutil -lint "$bundle/Contents/Info.plist"
for arch in arm64 x86_64; do
    xcrun --sdk macosx swiftc -swift-version 5 -O -parse-as-library \
        -target "$arch-apple-macosx13.0" Plan.swift TokenHistory.swift Meter.swift \
        -o "$work/ClaudeMeter-$arch"
done
binary="$bundle/Contents/MacOS/ClaudeMeter"
lipo -create "$work/ClaudeMeter-arm64" "$work/ClaudeMeter-x86_64" -output "$binary"
lipo "$binary" -verify_arch arm64 x86_64
codesign --force --sign - "$bundle"
codesign --verify --strict "$bundle"
ditto -c -k --keepParent "$bundle" "$work/Claude-Meter-macOS.zip"
mv "$work/Claude-Meter-macOS.zip" "$out/Claude-Meter-macOS.zip"
(cd "$out" && shasum -a 256 Claude-Meter-macOS.zip > SHA256SUMS.txt)
