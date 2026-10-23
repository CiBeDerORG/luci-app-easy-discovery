#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# RPCD executable plugin; authentication and ACLs are enforced by RPCD/uhttpd.
case "$#:$1:${2-}" in
    1:list:) printf '%s\n' '{"list":{},"scan":{}}' ;;
    2:call:list) exec /usr/libexec/luci-easy-discovery-adb list ;;
    2:call:scan) exec /usr/libexec/luci-easy-discovery-adb scan ;;
    *) printf '%s\n' '{"status":"error","message":"不支持的接口方法"}'; exit 1 ;;
esac
