#!/usr/bin/env bash
# dsh-turn-notify 版本管理 —— 三阶段发版规则的状态机实现
#
# 规则（详见 docs/VERSIONING.md）：
#   开发版  X.Y.Z-dev.n   （预览；同一周期可任意多轮 dev.n）
#   测试版  X.Y.Z-beta    （预览；无序号）
#   正式版  X.Y.Z         （无后缀）
#   递进必须走完 dev -> beta -> 正式；正式版的版本号 = 起始 dev 周期号。
#   例：上个正式版 1.0.1，做新特性 -> 1.0.2-dev.1 -> 1.0.2-dev.2 ->
#       1.0.2-beta -> （测出问题可回）1.0.2-dev.3 -> 1.0.2-beta -> 1.0.2
#
# 用法：
#   scripts/version.sh current                  显示当前版本与阶段
#   scripts/version.sh dev [--minor|--major]    进入/迭代开发版
#       正式版上调用  = 开启新周期（默认 patch：X.Y.(Z+1)-dev.1；
#                       --minor -> X.(Y+1).0-dev.1；--major -> (X+1).0.0-dev.1）
#       dev.n 上调用  = 同周期迭代 -> dev.(n+1)；若同时给了 --minor/--major，
#                       则放弃当前周期、以最近正式版为基点重开新周期
#                       （周期号在开启那一刻锁定，此后普通 dev 不再变号）
#       beta 上调用   = 回炉修复 -> dev.(n+1)（n 从 git 标签历史推断）
#   scripts/version.sh beta                     dev.n -> beta（同周期号）
#   scripts/version.sh stable                   beta -> 正式版（去掉后缀）
#   scripts/version.sh check                    校验 package.json 版本格式
#
# 选项（放子命令后）：
#   --dry-run   只打印将执行的动作，不落盘
#   --no-git    只改 package.json，不 commit / 不打 tag
#   --push      commit + tag 后推送（main 与标签）
set -euo pipefail

cd "$(dirname "$0")/.."
PKG=package.json

die() { echo "version.sh: $*" >&2; exit 1; }
info() { echo "version.sh: $*"; }

VERSION="$(node -p "require('./$PKG').version")"

# ---- 解析当前版本与阶段 ----
MAJOR=; MINOR=; PATCH=; DEVN=
if [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  STAGE=stable; MAJOR=${BASH_REMATCH[1]}; MINOR=${BASH_REMATCH[2]}; PATCH=${BASH_REMATCH[3]}
elif [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-dev\.([0-9]+)$ ]]; then
  STAGE=dev; MAJOR=${BASH_REMATCH[1]}; MINOR=${BASH_REMATCH[2]}; PATCH=${BASH_REMATCH[3]}; DEVN=${BASH_REMATCH[4]}
elif [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-beta$ ]]; then
  STAGE=beta; MAJOR=${BASH_REMATCH[1]}; MINOR=${BASH_REMATCH[2]}; PATCH=${BASH_REMATCH[3]}
else
  die "package.json 版本 \"$VERSION\" 不符合三阶段格式（X.Y.Z[-dev.n|-beta]）"
fi

CMD="${1:-}"; shift || true

DRY=0; NOGIT=0; PUSH=0; SCOPE=patch
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --no-git) NOGIT=1 ;;
    --push) PUSH=1 ;;
    --minor) SCOPE=minor ;;
    --major) SCOPE=major ;;
    *) die "未知参数: $a" ;;
  esac
done

# 某周期 X.Y.Z 已用过的最大 dev 序号（从 git 标签历史推断）
max_dev_n() {
  local base="v$1.$2.$3-dev."
  git tag -l "${base}*" | sed "s/^${base}//" | grep -E '^[0-9]+$' | sort -n | tail -1 || true
}

last_stable() { # 最近正式版号（无则回 0.0.0）
  git tag -l 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^v//' | sort -V | tail -1 || true
}

bump_scope() { # 以最近正式版为基点输出新周期 X.Y.Z
  local base="$(last_stable)"; base="${base:-0.0.0}"
  local b=(${base//./ })
  case "$SCOPE" in
    patch) echo "${b[0]}.${b[1]}.$((b[2]+1))" ;;
    minor) echo "${b[0]}.$((b[1]+1)).0" ;;
    major) echo "$((b[0]+1)).0.0" ;;
  esac
}

apply_new_version() { # $1 = 新版本
  local v="$1"
  info "package.json: $VERSION -> $v"
  if [[ $DRY -eq 1 ]]; then info "(dry-run) 不落盘"; return; fi
  # 匹配 "version":"X"（紧凑）与 "version": "X"（npm 格式）两种形态
  sed -i.bak "s/\"version\": *\"$VERSION\"/\"version\": \"$v\"/" "$PKG" && rm -f "$PKG.bak"
  git diff --quiet -- "$PKG" && die "版本写入失败（内容未变化？）"
  if [[ $NOGIT -eq 1 ]]; then
    info "--no-git：仅修改 package.json"
  else
    git add "$PKG"
    git commit -q -m "chore(release): $v"
    git tag "v$v"
    info "committed + tagged v$v"
    if [[ $PUSH -eq 1 ]]; then
      git push origin HEAD "v$v"
      info "pushed main + tag v$v"
    fi
  fi
}

case "$CMD" in
  current)
    info "当前版本 $VERSION（阶段: $STAGE）"
    ;;

  check)
    info "版本格式合法: $VERSION（阶段: $STAGE）"
    if git rev-parse --git-dir >/dev/null 2>&1; then
      if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
        local_head="$(git rev-parse --short HEAD)"
        tag_head="$(git rev-parse --short "v$VERSION")"
        if [[ "$local_head" == "$tag_head" ]]; then
          info "标签 v$VERSION 与 HEAD 一致（$local_head）"
        else
          info "标签 v$VERSION 存在于历史提交（$tag_head；HEAD=$local_head）——正常"
        fi
      else
        info "标签 v$VERSION 尚不存在（发版时由脚本创建）"
      fi
    fi
    ;;

  dev)
    # dev/beta 阶段带显式 scope = 放弃当前周期，以最近正式版为基点重开
    RESCOPE=0
    [[ "$STAGE" != stable && ( "$SCOPE" == minor || "$SCOPE" == major ) ]] && RESCOPE=1
    if [[ $RESCOPE -eq 1 ]]; then
      info "放弃当前周期 $VERSION，以最近正式版为基点重开（$SCOPE）"
      NEW="$(bump_scope)"
      N=1
      while git rev-parse -q --verify "refs/tags/v$NEW-dev.$N" >/dev/null 2>&1; do N=$((N+1)); done
      apply_new_version "$NEW-dev.$N"
    elif [[ "$STAGE" == stable ]]; then
      NEW="$(bump_scope)"
      N=1
      while git rev-parse -q --verify "refs/tags/v$NEW-dev.$N" >/dev/null 2>&1; do N=$((N+1)); done
      apply_new_version "$NEW-dev.$N"
    elif [[ "$STAGE" == dev ]]; then
      apply_new_version "$MAJOR.$MINOR.$PATCH-dev.$((DEVN+1))"
    else # beta 回炉：从标签历史续号
      LASTN="$(max_dev_n "$MAJOR" "$MINOR" "$PATCH")"
      [[ -n "$LASTN" ]] || die "beta 回炉失败：找不到 v$MAJOR.$MINOR.$PATCH-dev.* 标签历史"
      apply_new_version "$MAJOR.$MINOR.$PATCH-dev.$((LASTN+1))"
    fi
    ;;

  beta)
    [[ "$STAGE" == dev ]] || die "当前 $VERSION（$STAGE）不能直接进 beta：仅 dev.n -> beta 合法（规则见 docs/VERSIONING.md）"
    apply_new_version "$MAJOR.$MINOR.$PATCH-beta"
    ;;

  stable)
    [[ "$STAGE" == beta ]] || die "当前 $VERSION（$STAGE）不能直接发布正式版：必须先经过 beta（规则见 docs/VERSIONING.md）"
    apply_new_version "$MAJOR.$MINOR.$PATCH"
    ;;

  *) die "未知子命令: ${CMD:-（空）}。用法见 scripts/version.sh 头部注释" ;;
esac
