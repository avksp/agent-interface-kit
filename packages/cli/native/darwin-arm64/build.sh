#!/bin/sh
set -eu

if [ "$(node -p 'process.platform + "/" + process.arch')" != darwin/arm64 ]; then
  printf '%s\n' 'secure-fs requires a darwin/arm64 Node.js process.' >&2
  exit 1
fi

source_dir=$(CDPATH= cd -- "${0%/*}" && pwd -P)
cli_dir=$(CDPATH= cd -- "$source_dir/../.." && pwd -P)
headers=$(node -p 'require("node:path").resolve(process.execPath, "../../include/node")')
compiler=$(/usr/bin/xcrun --find clang)
sdk=$(/usr/bin/xcrun --show-sdk-path)

if [ ! -f "$headers/node_api.h" ]; then
  printf '%s\n' 'Node-API headers are missing from the active Node.js installation.' >&2
  exit 1
fi

output="$cli_dir/dist/native/darwin-arm64"
mkdir -p -- "$output"
staging=$(mktemp -d "$output/.secure-fs-build.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
trap 'exit 1' HUP INT TERM

"$compiler" -isysroot "$sdk" -arch arm64 -std=c17 -O2 -Wall -Wextra -Werror \
  -fvisibility=hidden -bundle -undefined dynamic_lookup -I "$headers" \
  "$source_dir/secure-fs.c" -o "$staging/secure-fs.node"
mv -f -- "$staging/secure-fs.node" "$output/secure-fs.node"
