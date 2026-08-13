#!/usr/bin/env bash
# 发版 ritual：build 绿 + 测试绿 + pnpm pack 出 tgz。
# 版本纪律（2026-08-13 user）：version=0.0.0（开发期）拒绝发版——
# 版本号只在人类过目真实 exports（dist/index.d.ts + pack 清单）通过后才写、才花掉。
set -euo pipefail
cd "$(dirname "$0")/.."
ver=$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")
if [ "$ver" = "0.0.0" ]; then
  echo "[release] 拒绝：version 还是 0.0.0（开发期）。过目通过、写好真实版本号再发版。" >&2
  exit 1
fi
bash scripts/build.sh
node test/run.mjs
pnpm pack
tgz="internal-store-$ver.tgz"
echo "[release] $tgz 就绪：$(du -h "$tgz" | cut -f1)（下一步：tgz 拷进消费方仓 vendor-pkgs/ 并 commit）"
