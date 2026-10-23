#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Fixed-command collectors share private volatile storage, never user paths.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL
umask 077
ED_BASE=/tmp/easy-discovery
ED_STATE=$ED_BASE/discovery
ED_FORMAT=/usr/share/easy-discovery/discovery/format.uc
ED_WORK=
ED_LOCK=
ED_CHILDREN=

ed_fallback() {
    printf '%s\n' '{"status":"error","schema_version":1,"has_snapshot":false,"scanned_at":null,"devices":[],"count":0,"storage":"volatile","truncated":false,"errors":[{"source":"runtime","code":"runtime_unavailable","message":"发现组件缺失或临时目录不可用，请检查安装状态"}],"message":"发现组件缺失或临时目录不可用"}'
}

ed_directory() {
    _ed_path=$1
    [ ! -L "$_ed_path" ] || return 1
    if [ ! -e "$_ed_path" ]; then
        mkdir -m 0700 "$_ed_path" 2>/dev/null || [ -d "$_ed_path" ] || return 1
    fi
    [ -d "$_ed_path" ] && [ ! -L "$_ed_path" ] || return 1
    _ed_owner=$(stat -c '%u' "$_ed_path" 2>/dev/null || true)
    case "$_ed_owner" in ''|*[!0-9]*) _ed_owner=$(ls -ldn "$_ed_path" 2>/dev/null | awk '{print $3}') ;; esac
    [ "$_ed_owner" = "$(id -u)" ] || return 1
    chmod 0700 "$_ed_path"
}

ed_init() {
    # A missing optional marker is normal; an unreadable RPCD configuration is
    # not. Do not turn a UCI parse/read failure into permission to serve cache.
    if ! /sbin/uci -q show rpcd >/dev/null 2>&1; then
        printf '%s\n' '{"status":"error","schema_version":1,"has_snapshot":false,"scanned_at":null,"devices":[],"count":0,"storage":"volatile","truncated":false,"errors":[{"source":"auth","code":"auth_unavailable","message":"无法读取授权配置，请由管理员检查 RPCD 配置"}],"message":"无法确认发现接口的授权状态"}'
        exit 1
    fi
    # A credential transaction revokes cached sessions with this fail-closed
    # barrier in place. Never expose a prior snapshot through an old session
    # while the administrator is changing credentials or permissions.
    if [ "$(/sbin/uci -q get rpcd.easyadb.easy_discovery_suspended 2>/dev/null || true)" = 1 ]; then
        printf '%s\n' '{"status":"error","schema_version":1,"has_snapshot":false,"scanned_at":null,"devices":[],"count":0,"storage":"volatile","truncated":false,"errors":[{"source":"auth","code":"auth_suspended","message":"授权正在更新或需要恢复，请由管理员处理客户端授权"}],"message":"发现接口已暂时锁定，请检查客户端授权"}'
        exit 1
    fi
    command -v ucode >/dev/null 2>&1 && [ -r "$ED_FORMAT" ] || { ed_fallback; exit 1; }
    ed_directory "$ED_BASE" && ed_directory "$ED_STATE" || { ed_fallback; exit 1; }
    ED_SNAPSHOT=$ED_STATE/$ED_KIND.json
    [ ! -L "$ED_SNAPSHOT" ] || { ed_fallback; exit 1; }
    [ ! -e "$ED_SNAPSHOT" ] || [ -f "$ED_SNAPSHOT" ] || { ed_fallback; exit 1; }
}

ed_error() {
    ucode "$ED_FORMAT" error "$ED_SNAPSHOT" "$1" "$2" "$ED_KIND" 2>/dev/null || ed_fallback
    exit 1
}

ed_cleanup() {
    if [ -n "$ED_CHILDREN" ]; then
        # PIDs are created locally by this invocation, never provided by callers.
        for _ed_pid in $ED_CHILDREN; do kill "$_ed_pid" 2>/dev/null || true; done
        wait 2>/dev/null || true
    fi
    [ -z "$ED_WORK" ] || rm -rf "$ED_WORK"
    if [ -n "$ED_LOCK" ]; then
        rm -f "$ED_LOCK/pid"
        rmdir "$ED_LOCK" 2>/dev/null || true
    fi
}

ed_begin() {
    _ed_lock=$ED_STATE/$ED_KIND.lock
    # Do not reap a lock by PID: PID reuse and simultaneous reapers can remove
    # another caller's live lock. EXIT/HUP/INT/TERM clean up normal exits; after
    # SIGKILL an administrator may remove the directory once no scan is active.
    mkdir -m 0700 "$_ed_lock" 2>/dev/null || ed_error busy '同类发现任务正在运行，请稍后重试'
    ED_LOCK=$_ed_lock
    printf '%s\n' "$$" > "$ED_LOCK/pid"
    ED_WORK=$(mktemp -d "$ED_STATE/.${ED_KIND}.XXXXXX") || {
        rm -f "$ED_LOCK/pid"
        rmdir "$ED_LOCK" 2>/dev/null || true
        ED_LOCK=
        ed_error storage_error '无法创建发现工作目录'
    }
    trap 'ed_cleanup' EXIT
    trap 'exit 1' HUP INT TERM
}

ed_capture() {
    _ed_output=$1; shift
    _ed_rc=0
    # Limit hostile advertisements / oversized RPC responses on disk, not only
    # after loading them. Linux file-size units are 512 or 1024 bytes by shell.
    (ulimit -f 1024; exec "$@") > "$_ed_output" 2>"$_ed_output.stderr" || _ed_rc=$?
    printf '%s\n' "$_ed_rc" > "$_ed_output.rc"
}

# avahi-browse has no interface-selection option. Browse once and let format.uc
# reject records outside the validated interface/subnet allowlist. Do not use
# -t: the explicit window gives asynchronous resolvers time to return addresses.
ed_browse() (
    _ed_output=$1
    _ed_window=$2
    _ed_kind=$3
    case "$_ed_window" in 3|8) ;; *) return 2 ;; esac
    IFS='. ' read -r _ed_started _ed_rest < /proc/uptime
    case "$_ed_kind" in
        adb) ed_capture "$_ed_output" timeout "$_ed_window" avahi-browse -rp _adb-tls-connect._tcp ;;
        mdns) ed_capture "$_ed_output" timeout "$_ed_window" avahi-browse -arp ;;
        *) return 2 ;;
    esac
    _ed_rc=$(cat "$_ed_output.rc")
    # BusyBox timeout can return the terminated child's 128 + SIGTERM rather
    # than GNU timeout's 124. Only accept it after our full collection window;
    # an early signal, invalid option or D-Bus failure must remain an error.
    if [ "$_ed_rc" = 143 ]; then
        IFS='. ' read -r _ed_finished _ed_rest < /proc/uptime
        if [ "$((_ed_finished - _ed_started))" -ge "$_ed_window" ]; then
            printf '124\n' > "$_ed_output.rc"
        fi
    fi
)

ed_browse_error() {
    _ed_browse_rc=$(cat "$1.rc" 2>/dev/null || printf 'unknown')
    _ed_detail=$(head -c 384 "$1.stderr" 2>/dev/null | tr '\000-\037\177' ' ' || true)
    [ -n "$_ed_detail" ] || _ed_detail='请检查 Avahi、D-Bus 服务以及 avahi-utils 安装状态'
    ed_error browse_failed "Avahi ADB 发现失败（退出码 $_ed_browse_rc）：$_ed_detail。未覆盖上次成功快照。"
}

ed_scope() {
    uci -q get easy-discovery.settings.network > "$ED_WORK/networks" 2>/dev/null || printf 'lan\n' > "$ED_WORK/networks"
    uci -q get easy-discovery.settings.arp_scan > "$ED_WORK/arp-enabled" 2>/dev/null || printf '0\n' > "$ED_WORK/arp-enabled"
    ed_capture "$ED_WORK/interfaces" timeout 2 ubus -t 1 call network.interface dump
    ucode "$ED_FORMAT" scope "$ED_WORK" > "$ED_WORK/scope.json" 2>/dev/null ||
        ed_error scope_unavailable '无法确定允许发现的本地网络；请检查 network 配置与网络接口状态'
}

ed_publish() {
    _ed_output=$ED_WORK/result.json
    _ed_result=0
    ucode "$ED_FORMAT" "$ED_KIND" "$ED_WORK" "$ED_SNAPSHOT" > "$_ed_output" 2>/dev/null || _ed_result=$?
    if [ "$_ed_result" -eq 3 ] && [ -s "$_ed_output" ]; then
        cat "$_ed_output"
        exit 1
    fi
    [ "$_ed_result" -eq 0 ] || ed_error collection_failed '发现结果处理失败，已保留上次成功快照'
    chmod 0600 "$_ed_output" || ed_error storage_error '无法保护发现快照'
    mv -f "$_ed_output" "$ED_SNAPSHOT" || ed_error storage_error '无法写入发现快照'
    cat "$ED_SNAPSHOT"
}
