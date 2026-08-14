#!/usr/bin/env bash
# pull-package —— 消费方收货入口（宿主 pull，本库永不 push；对齐 Colors/SVG Icons 契约）。
#
# 在**消费方仓根**运行：
#   bash "../20260813 internal-store/scripts/pull-package.sh"          # 收最新已发版
#   bash "../20260813 internal-store/scripts/pull-package.sh" 0.2.0    # 收指定版本
#
# 干的事：已发版 tgz 落 vendor-pkgs/ → package.json 的 @internal/store 指到新版（file:）
#         → 清掉旧版本 tgz → npm install。
# 不干的事：不跑消费方测试、不 commit——那是宿主 session 的活
#         （Colors 契约同形：「库仓的活到 commit 交付物为止，宿主收货/测试/发版是宿主的活」）。
# 版本纪律：只认**已 tag** 的版本（v<ver> 必须存在于库仓 git）。开发期 0.0.0 无 tag 无 tgz，
#         天然被挡（见 release.sh；2026-08-13 user 拍板）。
# 取货来源：gh release 资产优先（发版正货字节）；离线 fallback = 库仓根 release.sh 产物（需同名 tag 存在）。
set -euo pipefail
LIB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$(pwd)"

die() { echo "[pull-package] ✗ $*" >&2; exit 1; }

[ -f "$APP_DIR/package.json" ] || die "当前目录没有 package.json——要在**消费方仓根**运行（cd 进 app 仓再调本脚本）。"
[ "$APP_DIR" != "$LIB_DIR" ] || die "在库仓自己里运行没有意义——cd 进消费方仓根再跑。"

# 版本：参数指定，或库仓最新 tag。
ver="${1:-}"
if [ -z "$ver" ]; then
  ver="$(git -C "$LIB_DIR" tag --list 'v*' --sort=-v:refname | head -1 | sed 's/^v//')"
  [ -n "$ver" ] || die "库仓没有任何 v* tag——还没发过版（release.sh + tag 先行）。"
fi
git -C "$LIB_DIR" rev-parse -q --verify "refs/tags/v$ver" >/dev/null \
  || die "v$ver 不是已发版本（库仓无此 tag）。只准收已发版——开发期字节不出库（版本纪律 2026-08-13）。"

tgz="internal-store-$ver.tgz"
mkdir -p "$APP_DIR/vendor-pkgs"

# 取货：gh release 正货优先；离线 fallback 用库仓根的 release.sh 产物。
repo_url="$(git -C "$LIB_DIR" remote get-url origin 2>/dev/null || true)"
src=""
if [ -n "$repo_url" ] && gh release download "v$ver" --repo "$repo_url" --pattern "$tgz" \
     -O "$APP_DIR/vendor-pkgs/$tgz" --clobber 2>/dev/null; then
  src="gh release v$ver（正货）"
elif [ -f "$LIB_DIR/$tgz" ]; then
  cp "$LIB_DIR/$tgz" "$APP_DIR/vendor-pkgs/$tgz"
  src="库仓本地 release 产物（离线 fallback——字节未经 gh release 对账，联网后建议重跑校验）"
else
  die "拿不到 $tgz：gh release 下载失败（离线/未装 gh？）且库仓根也没有该产物（跑过 release.sh 吗）。"
fi

# 验货：tgz 内 package.json 的 name/version 必须对得上。
pkg_json="$(tar -xzOf "$APP_DIR/vendor-pkgs/$tgz" package/package.json)"
pv="$(node -p 'const p=JSON.parse(process.argv[1]); p.name+"@"+p.version' "$pkg_json")"
[ "$pv" = "@internal/store@$ver" ] || die "验货失败：tgz 里是 $pv，期望 @internal/store@$ver。"

# 消费方 package.json 指针（无 dependencies/条目则新建——首次接线也走这脚本）。
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  (p.dependencies ??= {})["@internal/store"] = "file:./vendor-pkgs/" + process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
' "$tgz"

# 旧版本 tgz 清掉（历史在 git；vendor-pkgs 只留 pin 的这一份）。
find "$APP_DIR/vendor-pkgs" -maxdepth 1 -name 'internal-store-*.tgz' ! -name "$tgz" -delete

npm install --no-audit --no-fund

echo "[pull-package] ✓ @internal/store@$ver 已就位（来源：$src）"
echo "[pull-package] 宿主接下来的活："
echo "[pull-package]   1. 看库仓变更再决定要不要跟：git -C \"$LIB_DIR\" log <旧tag>..v$ver --oneline"
echo "[pull-package]   2. 跑自家测试 + build"
echo "[pull-package]   3. commit：package.json package-lock.json vendor-pkgs/$tgz（自包含不变量：tgz 必须进 git）"
