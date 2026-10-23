#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Prepare an isolated host ucode + fs runtime for tests. Nothing is installed
# globally and no router service or user configuration is touched.
set -eu

[ "$#" -eq 1 ] || {
    echo '用法：sh scripts/prepare-test-runtime.sh /测试运行时输出目录' >&2
    exit 2
}

ED_UCODE_REPOSITORY=https://github.com/ucode-lang/ucode.git
ED_UCODE_REVISION=6cfc97fbfe1f3a5226245e62fdf8e3b150d70859

for ED_REQUIRED_TOOL in git cmake cc pkg-config; do
    command -v "$ED_REQUIRED_TOOL" >/dev/null 2>&1 || {
        echo "缺少构建工具：$ED_REQUIRED_TOOL；Ubuntu 请安装 build-essential cmake pkg-config libjson-c-dev" >&2
        exit 1
    }
done
pkg-config --exists json-c || {
    echo '缺少 json-c 开发依赖；Ubuntu 请安装 libjson-c-dev' >&2
    exit 1
}

mkdir -p "$1"
ED_RUNTIME_DIR=$(cd "$1" && pwd -P)
ED_UCODE_SOURCE=$ED_RUNTIME_DIR/ucode-src
ED_UCODE_BUILD=$ED_RUNTIME_DIR/ucode-build

if [ -e "$ED_UCODE_SOURCE" ] || [ -L "$ED_UCODE_SOURCE" ]; then
    [ -d "$ED_UCODE_SOURCE/.git" ] && [ ! -L "$ED_UCODE_SOURCE" ] || {
        echo '运行时源码目录已存在且不是本脚本的 Git 工作区，拒绝覆盖' >&2
        exit 1
    }
    [ "$(git -C "$ED_UCODE_SOURCE" rev-parse HEAD)" = "$ED_UCODE_REVISION" ] &&
        [ -z "$(git -C "$ED_UCODE_SOURCE" status --porcelain)" ] || {
            echo '运行时源码版本或内容发生变化，请使用新的输出目录' >&2
            exit 1
        }
else
    git init --quiet "$ED_UCODE_SOURCE"
    git -C "$ED_UCODE_SOURCE" fetch --quiet --depth=1 "$ED_UCODE_REPOSITORY" "$ED_UCODE_REVISION"
    git -C "$ED_UCODE_SOURCE" checkout --quiet --detach FETCH_HEAD
fi

# Limit the host build to the interpreter and filesystem module. RPCD/ubus/UCI
# helpers are exercised separately against explicit isolated test adapters.
cmake -S "$ED_UCODE_SOURCE" -B "$ED_UCODE_BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    "-DLIB_SEARCH_PATH=$ED_UCODE_BUILD/*.so" \
    -DFS_SUPPORT=ON \
    -DDEBUG_SUPPORT=OFF \
    -DFFI_SUPPORT=OFF \
    -DDIGEST_SUPPORT=OFF \
    -DUBUS_SUPPORT=OFF \
    -DUCI_SUPPORT=OFF \
    -DULOOP_SUPPORT=OFF \
    -DRTNL_SUPPORT=OFF \
    -DNL80211_SUPPORT=OFF
cmake --build "$ED_UCODE_BUILD" --parallel 2 --target ucode fs_lib

"$ED_UCODE_BUILD/ucode" -e 'import { readfile } from "fs"; if (type(readfile(ARGV[0])) != "string") exit(1);' "$ED_UCODE_SOURCE/CMakeLists.txt"
printf 'UCODE_REVISION=%s\nUCODE_EXECUTABLE=%s\n' "$ED_UCODE_REVISION" "$ED_UCODE_BUILD/ucode"
