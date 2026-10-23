#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Native test tools only. Nothing is installed into the host /etc or /usr.
set -eu
[ "$#" -eq 1 ] || { echo '用法：sh tests/backend/prepare-runtime.sh /临时运行时目录' >&2; exit 2; }
mkdir -p "$1"
TEST_PREFIX=$(cd "$1" && pwd -P)
case "$TEST_PREFIX" in *[!A-Za-z0-9_./-]*) echo '测试运行时路径含不支持字符' >&2; exit 2 ;; esac
UBOX_REV=da2d205a5cf3e877c45a2eec488218cbaf452e7d
UCI_REV=74f6277aabffc943d026f406df57c22595134c42
mkdir -p "$TEST_PREFIX/sources"
fetch_source() {
    name=$1; revision=$2
    [ ! -e "$TEST_PREFIX/sources/$name" ] || { echo "源码目录已经存在：$name" >&2; exit 1; }
    curl --proto '=https' --proto-redir '=https' --fail --location --retry 2 --connect-timeout 20 \
        "https://github.com/openwrt/$name/archive/$revision.tar.gz" -o "$TEST_PREFIX/sources/$name.tar.gz"
    mkdir "$TEST_PREFIX/sources/$name"
    tar -xzf "$TEST_PREFIX/sources/$name.tar.gz" --strip-components=1 -C "$TEST_PREFIX/sources/$name"
}
fetch_source libubox "$UBOX_REV"
fetch_source uci "$UCI_REV"
cmake -S "$TEST_PREFIX/sources/libubox" -B "$TEST_PREFIX/ubox-build" \
    -DBUILD_LUA=OFF -DBUILD_EXAMPLES=OFF -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$TEST_PREFIX" -DCMAKE_INSTALL_RPATH="$TEST_PREFIX/lib"
cmake --build "$TEST_PREFIX/ubox-build" --parallel 2
cmake --install "$TEST_PREFIX/ubox-build"
# Keep UCI's default delta search path isolated as well as its explicit -c/-t
# arguments. The parser/transaction code is unchanged.
python3 - "$TEST_PREFIX" <<'PY'
from pathlib import Path
import sys
prefix = Path(sys.argv[1])
header = prefix / 'sources/uci/uci.h'
source = header.read_text()
for name, old, new in [('UCI_CONFDIR', '/etc/config', prefix / 'defaults/config'),
                       ('UCI_SAVEDIR', '/tmp/.uci', prefix / 'defaults/delta')]:
    previous = f'#define {name} "{old}"'
    if source.count(previous) != 1:
        raise SystemExit(f'Unexpected upstream definition: {name}')
    source = source.replace(previous, f'#define {name} "{new}"')
    new.mkdir(parents=True, exist_ok=True)
header.write_text(source)
PY
cmake -S "$TEST_PREFIX/sources/uci" -B "$TEST_PREFIX/uci-build" \
    -DBUILD_LUA=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="$TEST_PREFIX" \
    -DCMAKE_INSTALL_PREFIX="$TEST_PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_INSTALL_RPATH="$TEST_PREFIX/lib"
cmake --build "$TEST_PREFIX/uci-build" --parallel 2
cmake --install "$TEST_PREFIX/uci-build"
printf '%s\n' "后端测试运行时已生成：$TEST_PREFIX"
