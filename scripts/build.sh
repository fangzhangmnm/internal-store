#!/usr/bin/env bash
# 构建：tsc 发射 dist/（.js + .d.ts）。tsc 本身就是类型门——不过不出货。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "[build] tsc → dist/"
rm -rf dist
npx tsc -p tsconfig.json
echo "[build] done: $(find dist -name '*.js' | wc -l) js / $(find dist -name '*.d.ts' | wc -l) d.ts"
