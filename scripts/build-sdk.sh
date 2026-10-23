#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Run from an extracted SDK matching the router firmware.
set -eu
[ "$#" -eq 1 ] || { echo '用法：在 SDK 根目录运行 sh /源码/scripts/build-sdk.sh /源码绝对路径' >&2; exit 2; }
[ -r rules.mk ] && [ -d include ] || { echo '请从解压后的 OpenWrt / ImmortalWrt SDK 根目录运行' >&2; exit 1; }
SOURCE_DIR=$(cd "$1" && pwd -P)
[ -f "$SOURCE_DIR/Makefile" ] && [ -f "$SOURCE_DIR/root/usr/libexec/luci-easy-discovery" ] || {
    echo '源码目录不完整' >&2; exit 1;
}
mkdir -p package
[ -r .config ] || : > .config
PACKAGE_PATH=package/luci-app-easy-discovery
if [ -e "$PACKAGE_PATH" ] || [ -L "$PACKAGE_PATH" ]; then
    [ "$(readlink -f "$PACKAGE_PATH")" = "$SOURCE_DIR" ] || {
        echo 'SDK 中已有同名包且不是当前源码，拒绝覆盖' >&2; exit 1;
    }
else
    ln -s "$SOURCE_DIR" "$PACKAGE_PATH"
fi
sed -i '/^CONFIG_PACKAGE_luci-app-easy-discovery=/d; /^# CONFIG_PACKAGE_luci-app-easy-discovery is not set/d' .config
printf '%s\n' 'CONFIG_PACKAGE_luci-app-easy-discovery=m' >> .config
make defconfig
make package/luci-app-easy-discovery/compile V=s
if grep -qx 'CONFIG_USE_APK=y' .config; then
    echo '已按当前 SDK 的 APK 格式构建：'
    find bin -type f -name 'luci-app-easy-discovery*.apk' -print
else
    echo '已按当前 SDK 的 IPK 格式构建：'
    find bin -type f -name 'luci-app-easy-discovery*.ipk' -print
fi
