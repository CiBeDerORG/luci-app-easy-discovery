#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Run from an extracted SDK matching the router firmware.
set -eu
[ "$#" -eq 1 ] || { echo '用法：在 SDK 根目录运行 sh /源码/scripts/build-sdk.sh /源码绝对路径' >&2; exit 2; }
[ -r rules.mk ] && [ -d include ] || { echo '请从解压后的 OpenWrt / ImmortalWrt SDK 根目录运行' >&2; exit 1; }
SDK_ROOT=$(pwd -P)
SOURCE_DIR=$(cd "$1" && pwd -P)
assert_package_selected() {
    grep -Eq '^CONFIG_PACKAGE_luci-app-easy-discovery=(m|y)$' .config || {
        echo 'SDK 配置没有选中 Easy Discovery，请检查 SDK 软件源和依赖配置' >&2
        grep -E '^([# ]+)?CONFIG_PACKAGE_luci-app-easy-discovery([= ]|$)' .config >&2 || :
        exit 1
    }
}
case "${EASY_DISCOVERY_FULL_BUILD:-0}" in
    0|1) ;;
    *) echo 'EASY_DISCOVERY_FULL_BUILD 仅支持 0 或 1' >&2; exit 2 ;;
esac
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
assert_package_selected
# Only skip dependency compilation when the actual SDK metadata proves this
# remains a script-only package without direct ABI or host/build dependencies.
if [ "${EASY_DISCOVERY_FULL_BUILD:-0}" = 0 ] && grep -qx 'CONFIG_SDK=y' .config && \
    perl -I "$SDK_ROOT/scripts" "$SOURCE_DIR/scripts/check-package-only-abi.pl" \
        "$SDK_ROOT/tmp/.packageinfo" "$SOURCE_DIR/Makefile"; then
    if grep -qx 'CONFIG_USE_APK=y' .config; then
        # NO_DEPS also skips this SDK prerequisite: prepare it explicitly using
        # the SDK's own rule, which creates the private key before the public key.
        make "$SDK_ROOT/public-key.pem" V=s
        assert_package_selected
    fi
    echo '使用 SDK 原生打包，跳过不需要重复编译的运行依赖'
    make -j2 package/luci-app-easy-discovery/compile NO_DEPS=1 V=s
else
    echo '使用包含依赖编译的完整构建路径'
    make -j2 package/luci-app-easy-discovery/compile V=s
fi
if grep -qx 'CONFIG_USE_APK=y' .config; then
    PACKAGE_FORMAT=apk
else
    PACKAGE_FORMAT=ipk
fi
PACKAGE_FILES=$(find bin -type f -name "luci-app-easy-discovery*.$PACKAGE_FORMAT" -print)
[ -n "$PACKAGE_FILES" ] || { echo '构建命令结束但未生成应用安装包，请检查软件包选择和构建输出' >&2; exit 1; }
printf '已按当前 SDK 的 %s 格式构建：\n%s\n' "$PACKAGE_FORMAT" "$PACKAGE_FILES"
