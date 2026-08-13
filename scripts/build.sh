#!/usr/bin/env bash
# 构建：tsc 发射 dist/（.js + .d.ts）。tsc 本身就是类型门——不过不出货。
set -euo pipefail
cd "$(dirname "$0")/.."
echo "[build] tsc → dist/"
rm -rf dist
npx tsc -p tsconfig.json
echo "[build] done: $(find dist -name '*.js' | wc -l) js / $(find dist -name '*.d.ts' | wc -l) d.ts"
# 体重计：js 总重 + 最胖 3 件（涨重看得见，别静默发福）
js_total=$(find dist -name '*.js' -exec du -cb {} + | tail -1 | cut -f1)
echo "[体重] dist js 合计 $((js_total / 1024)) KB；最胖3件："
find dist -name '*.js' -exec du -b {} + | sort -rn | head -3 | awk '{printf "  %5.1f KB  %s\n", $1/1024, $2}'
# 户口刷新（api-extractor --local：公共面变了就重写 api/*.api.md，git diff 即审核面）
npx api-extractor run --local -c api-extractor.json
npx api-extractor run --local -c api-extractor-testing.json
echo "[户口] api/store.api.md + api/store-testing.api.md 已刷新"
