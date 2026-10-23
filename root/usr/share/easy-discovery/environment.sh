#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Shared fixed-command environment backend. All callers run as the LuCI admin.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL
umask 077
set -f

ED_STATE=/tmp/easy-discovery/environment
ED_LOCK=$ED_STATE/operation.lock
ED_JOB_RUNNER=/usr/libexec/luci-easy-discovery-job
ED_UCI=/sbin/uci
ED_CONFIG=/etc/config/easy-discovery
ED_MANAGER=none
ED_PM=
if command -v apk >/dev/null 2>&1; then ED_MANAGER=apk; ED_PM=$(command -v apk)
elif command -v opkg >/dev/null 2>&1; then ED_MANAGER=opkg; ED_PM=$(command -v opkg); fi

if [ ! -r /usr/share/libubox/jshn.sh ]; then
    printf '%s\n' '{"status":"error","message":"缺少 jshn 运行依赖","error":{"code":"missing_dependency","message":"请安装 jshn"}}'
    exit 1
fi
. /usr/share/libubox/jshn.sh

ed_error() {
    json_init
    json_add_string status error
    json_add_string message "$2"
    json_add_object error
    json_add_string code "$1"
    json_add_string message "$2"
    json_close_object
    json_dump
    exit 1
}
ed_ok() {
    json_init
    json_add_string status ok
    json_add_string message "$1"
    json_dump
}
ed_owned_dir() {
    [ ! -L "$1" ] || return 1
    if [ ! -e "$1" ]; then mkdir -m 0700 "$1" 2>/dev/null || [ -d "$1" ] || return 1; fi
    [ -d "$1" ] && [ ! -L "$1" ] || return 1
    _ed_owner=$(stat -c '%u' "$1" 2>/dev/null || ls -nd "$1" | awk '{print $3}')
    [ "$_ed_owner" = 0 ] || return 1
    chmod 0700 "$1" || return 1
}
ed_state_init() {
    [ "$(id -u)" = 0 ] || ed_error permission_denied '仅管理员可操作运行环境'
    ed_owned_dir /tmp/easy-discovery && ed_owned_dir "$ED_STATE" || ed_error unsafe_path '运行状态目录不安全'
}
ed_pid_valid() { case "$1" in ''|*[!0-9]*) return 1 ;; *) [ "$1" -gt 1 ] 2>/dev/null ;; esac; }
ed_id_valid() { [ "${#1}" -eq 32 ] || return 1; case "$1" in *[!a-f0-9]*) return 1 ;; esac; }
ed_release_lock() {
    [ -d "$ED_LOCK" ] && [ ! -L "$ED_LOCK" ] || return 0
    [ "$(cat "$ED_LOCK/pid" 2>/dev/null)" = "$$" ] || return 0
    rm -f "$ED_LOCK/pid"
    rmdir "$ED_LOCK" 2>/dev/null || true
}
ed_acquire_lock() {
    if ! mkdir -m 0700 "$ED_LOCK" 2>/dev/null; then
        [ -d "$ED_LOCK" ] && [ ! -L "$ED_LOCK" ] || ed_error unsafe_path '操作锁路径不安全'
        _ed_pid=$(cat "$ED_LOCK/pid" 2>/dev/null || true)
        if ! ed_pid_valid "$_ed_pid" || ! kill -0 "$_ed_pid" 2>/dev/null; then
            if ! ed_pid_valid "$_ed_pid"; then
                # mkdir and PID publication are separate operations. A live
                # owner gets a grace period; a crash in between is recoverable.
                _ed_lock_created=$(stat -c '%Y' "$ED_LOCK" 2>/dev/null || printf 0)
                [ "$(( $(date +%s) - _ed_lock_created ))" -ge 15 ] ||
                    ed_error busy '环境操作正在启动，请稍候'
            fi
            # An accepted task may still be transferring the lock from the RPC
            # parent to its detached worker. Do not reclaim during that handoff.
            _ed_handoff=$(cat "$ED_STATE/current" 2>/dev/null || true)
            if ed_id_valid "$_ed_handoff" && [ ! -e "$ED_STATE/job-$_ed_handoff/pid" ] &&
               [ "$(cat "$ED_STATE/job-$_ed_handoff/state" 2>/dev/null)" = running ]; then
                _ed_created=$(stat -c '%Y' "$ED_STATE/job-$_ed_handoff/state" 2>/dev/null || printf 0)
                _ed_age=$(( $(date +%s) - _ed_created ))
                [ "$_ed_age" -ge 15 ] || ed_error busy '软件包任务正在启动，请稍候'
            fi
            # Only one contender may reap this specific stale directory. After
            # taking the guard, recheck the owner in case another request has
            # already replaced the directory with a new operation's lock.
            mkdir "$ED_LOCK/reclaim" 2>/dev/null || ed_error busy '环境操作锁正在恢复，请稍候'
            _ed_recheck=$(cat "$ED_LOCK/pid" 2>/dev/null || true)
            if [ "$_ed_recheck" != "$_ed_pid" ] || { ed_pid_valid "$_ed_recheck" && kill -0 "$_ed_recheck" 2>/dev/null; }; then
                rmdir "$ED_LOCK/reclaim" 2>/dev/null || true
                ed_error busy '已有环境操作正在执行，请等待完成'
            fi
            rm -f "$ED_LOCK/pid"
            rmdir "$ED_LOCK/reclaim" 2>/dev/null || ed_error busy '环境操作锁恢复失败'
            rmdir "$ED_LOCK" 2>/dev/null || ed_error busy '已有环境操作正在执行'
            mkdir -m 0700 "$ED_LOCK" 2>/dev/null || ed_error busy '已有环境操作正在执行'
        else
            ed_error busy '已有环境操作正在执行，请等待完成'
        fi
    fi
    printf '%s\n' "$$" > "$ED_LOCK/pid"
    trap 'ed_release_lock' EXIT
    trap 'exit 1' HUP INT TERM
}
ed_package_names() {
    case "$1" in
        avahi) printf '%s\n' avahi-dbus-daemon avahi-utils ;;
        dbus) printf '%s\n' dbus ;;
        arp) printf '%s\n' arp-scan ;;
        *) return 1 ;;
    esac
}
ed_component_name() { case "$1" in avahi) printf Avahi ;; dbus) printf D-Bus ;; arp) printf 'ARP 扫描增强' ;; *) return 1 ;; esac; }
ed_service_init() { case "$1" in avahi) printf /etc/init.d/avahi-daemon ;; dbus) printf /etc/init.d/dbus ;; *) return 1 ;; esac; }
ed_running() { case "$1" in avahi) pidof avahi-daemon >/dev/null 2>&1 ;; dbus) pidof dbus-daemon >/dev/null 2>&1 ;; *) return 1 ;; esac; }
ed_enabled() { _ed_init=$(ed_service_init "$1") || return 1; [ -x "$_ed_init" ] && "$_ed_init" enabled >/dev/null 2>&1; }
ed_pkg_info() {
    ED_PKG_INSTALLED=0
    ED_PKG_VERSION=
    if [ "$ED_MANAGER" = apk ]; then
        if "$ED_PM" info -e "$1" >/dev/null 2>&1; then
            ED_PKG_INSTALLED=1
            ED_PKG_VERSION=$("$ED_PM" list --installed --manifest "$1" 2>/dev/null | awk -v wanted="$1" '$1 == wanted && NF == 2 && $2 ~ /^[0-9A-Za-z][0-9A-Za-z._+~:-]*$/ { print $2; exit }')
        fi
    elif [ "$ED_MANAGER" = opkg ]; then
        _ed_pkg=$({ "$ED_PM" status "$1" 2>/dev/null || true; } | awk '/^Status: .* installed$/ {ok=1} /^Version: / {version=$2} END {if (ok) print version}')
        if [ -n "$_ed_pkg" ]; then ED_PKG_INSTALLED=1; ED_PKG_VERSION=$_ed_pkg; fi
    fi
}
ed_component_ready() {
    case "$1" in
        avahi) command -v avahi-daemon >/dev/null 2>&1 && command -v avahi-browse >/dev/null 2>&1 && [ -x /etc/init.d/avahi-daemon ] ;;
        dbus) command -v dbus-daemon >/dev/null 2>&1 && [ -x /etc/init.d/dbus ] ;;
        arp) command -v arp-scan >/dev/null 2>&1 ;;
        *) return 1 ;;
    esac
}
ed_component_json() {
    _ed_component=$1
    _ed_names=$(ed_package_names "$_ed_component") || return 1
    json_add_object ''
    json_add_string id "$_ed_component"
    json_add_string name "$(ed_component_name "$_ed_component")"
    json_add_array packages
    _ed_total=0; _ed_installed=0
    for _ed_name in $_ed_names; do
        ed_pkg_info "$_ed_name"
        _ed_total=$((_ed_total + 1)); _ed_installed=$((_ed_installed + ED_PKG_INSTALLED))
        json_add_object ''
        json_add_string name "$_ed_name"
        json_add_boolean installed "$ED_PKG_INSTALLED"
        if [ -n "$ED_PKG_VERSION" ]; then json_add_string version "$ED_PKG_VERSION"; else json_add_null version; fi
        json_close_object
    done
    json_close_array
    if [ "$_ed_installed" -eq "$_ed_total" ] && ed_component_ready "$_ed_component"; then _ed_install_state=installed
    elif [ "$_ed_installed" -gt 0 ]; then _ed_install_state=partial
    else _ed_install_state=missing; fi
    json_add_string installed "$_ed_install_state"
    _ed_flag=0
    if [ "$_ed_component" != arp ]; then
        _ed_component_init=$(ed_service_init "$_ed_component")
        [ -x "$_ed_component_init" ] && _ed_flag=1
    fi
    json_add_boolean has_service "$_ed_flag"
    _ed_flag=0; ed_running "$_ed_component" && _ed_flag=1
    json_add_boolean running "$_ed_flag"
    _ed_flag=0; ed_enabled "$_ed_component" && _ed_flag=1
    json_add_boolean enabled "$_ed_flag"
    json_close_object
}
ed_log_excerpt() {
    [ -f "$1" ] && [ ! -L "$1" ] || return 0
    # A bounded tail keeps rpcd responses small even for package download logs.
    tail -n 80 "$1" 2>/dev/null | cut -c 1-400
}
ed_job_json() {
    _ed_jobid=$1
    ed_id_valid "$_ed_jobid" || return 1
    _ed_jobdir=$ED_STATE/job-$_ed_jobid
    [ -d "$_ed_jobdir" ] && [ ! -L "$_ed_jobdir" ] || return 1
    _ed_jobstate=$(cat "$_ed_jobdir/state" 2>/dev/null || true)
    _ed_jobpid=$(cat "$_ed_jobdir/pid" 2>/dev/null || true)
    _ed_jobmessage=$(cat "$_ed_jobdir/message" 2>/dev/null || true)
    case "$_ed_jobstate" in running|succeeded|failed) ;; *) return 1 ;; esac
    if [ "$_ed_jobstate" = running ] && ed_pid_valid "$_ed_jobpid" && ! kill -0 "$_ed_jobpid" 2>/dev/null; then
        _ed_jobstate=failed
        _ed_jobmessage='软件包进程已中断，请刷新组件状态后重试'
    elif [ "$_ed_jobstate" = running ] && ! ed_pid_valid "$_ed_jobpid"; then
        _ed_created=$(stat -c '%Y' "$_ed_jobdir/state" 2>/dev/null || printf 0)
        if [ "$(( $(date +%s) - _ed_created ))" -ge 15 ]; then
            _ed_jobstate=failed
            _ed_jobmessage='软件包任务未能启动，请刷新状态后重试'
        fi
    fi
    json_add_object job
    json_add_string id "$_ed_jobid"
    json_add_string state "$_ed_jobstate"
    json_add_string action "$(cat "$_ed_jobdir/action" 2>/dev/null)"
    json_add_string component "$(cat "$_ed_jobdir/component" 2>/dev/null)"
    json_add_string message "$_ed_jobmessage"
    json_add_string output "$(ed_log_excerpt "$_ed_jobdir/output")"
    json_close_object
}
ed_status() {
    json_init
    json_add_string status ok
    json_add_string package_manager "$ED_MANAGER"
    json_add_array components
    for _ed_c in avahi dbus arp; do ed_component_json "$_ed_c"; done
    json_close_array
    json_add_object settings
    _ed_arp=0; [ "$("$ED_UCI" -q get easy-discovery.settings.arp_scan 2>/dev/null)" = 1 ] && _ed_arp=1
    json_add_boolean arp_scan "$_ed_arp"
    json_add_array networks
    _ed_networks=$("$ED_UCI" -q get easy-discovery.settings.network 2>/dev/null || true)
    [ -n "$_ed_networks" ] || _ed_networks=lan
    for _ed_net in $_ed_networks; do json_add_string '' "$_ed_net"; done
    json_close_array
    json_close_object
    _ed_current=$(cat "$ED_STATE/current" 2>/dev/null || true)
    ed_job_json "$_ed_current" || json_add_null job
    json_dump
}
ed_service() {
    [ "$#" -eq 2 ] || ed_error invalid_argument '服务操作参数无效'
    _ed_target=$1; _ed_action=$2
    _ed_target_init=$(ed_service_init "$_ed_target") || ed_error invalid_argument '不支持的服务'
    case "$_ed_action" in start|stop|restart|enable|disable) ;; *) ed_error invalid_argument '不支持的服务操作' ;; esac
    [ -x "$_ed_target_init" ] || ed_error missing_dependency '服务尚未安装完整，请先安装依赖'
    ed_acquire_lock
    _ed_output=$ED_STATE/service-output.$$
    : > "$_ed_output"
    _ed_rc=0
    if [ "$_ed_target" = dbus ] && [ "$_ed_action" = disable ] && ed_enabled avahi; then
        ed_error dependency_in_use '请先关闭 Avahi 开机自启，再关闭 D-Bus 开机自启'
    fi
    if [ "$_ed_target" = dbus ] && { [ "$_ed_action" = stop ] || [ "$_ed_action" = restart ]; } && ed_running avahi; then
        timeout 8 /etc/init.d/avahi-daemon stop >> "$_ed_output" 2>&1 || _ed_rc=$?
        [ "$_ed_rc" -eq 0 ] || { rm -f "$_ed_output"; ed_error service_failed '无法先停止依赖 D-Bus 的 Avahi'; }
    fi
    if [ "$_ed_target" = avahi ] && { [ "$_ed_action" = start ] || [ "$_ed_action" = restart ] || [ "$_ed_action" = enable ]; }; then
        ed_component_ready dbus || { rm -f "$_ed_output"; ed_error missing_dependency '请先安装完整的 D-Bus 依赖'; }
        if [ "$_ed_action" = enable ]; then
            /etc/init.d/dbus enable >> "$_ed_output" 2>&1 || _ed_rc=$?
        elif ! ed_running dbus; then
            timeout 8 /etc/init.d/dbus start >> "$_ed_output" 2>&1 || _ed_rc=$?
        fi
        [ "$_ed_rc" -eq 0 ] || { rm -f "$_ed_output"; ed_error service_failed 'D-Bus 依赖操作失败，请查看系统日志'; }
    fi
    timeout 8 "$_ed_target_init" "$_ed_action" >> "$_ed_output" 2>&1 || _ed_rc=$?
    _ed_message=$(ed_log_excerpt "$_ed_output")
    rm -f "$_ed_output"
    [ "$_ed_rc" -eq 0 ] || ed_error service_failed "服务操作失败：$_ed_message"
    # A successful init script does not establish daemon liveness; UI reloads status.
    ed_ok '服务操作已提交，请以刷新后的实际状态为准'
}
ed_package_validate() {
    [ "$#" -eq 2 ] || ed_error invalid_argument '软件包参数无效'
    case "$1" in install|upgrade|remove) ;; *) ed_error invalid_argument '不支持的软件包操作' ;; esac
    ed_package_names "$2" >/dev/null || ed_error invalid_argument '不支持的软件包组件'
    [ "$ED_MANAGER" != none ] || ed_error missing_dependency '没有找到 APK 或 OPKG 软件包管理器'
    command -v timeout >/dev/null 2>&1 || ed_error missing_dependency '缺少 timeout 命令'
    if [ "$1" = remove ]; then
        if [ "$2" = arp ] && [ "$("$ED_UCI" -q get easy-discovery.settings.arp_scan 2>/dev/null)" = 1 ]; then
            ed_error dependency_in_use '请先关闭 ARP 参与设备发现，再卸载扫描组件'
        fi
        if [ "$2" = avahi ] && ed_running avahi; then ed_error dependency_in_use '请先在服务管理中停止 Avahi，再卸载'; fi
        if [ "$2" = dbus ]; then
            ed_running avahi && ed_error dependency_in_use 'Avahi 正在使用 D-Bus，请先停止 Avahi'
            ed_running dbus && ed_error dependency_in_use '请先停止 D-Bus，再卸载'
        fi
    fi
}
ed_package_command() {
    _ed_phase=$1; _ed_action=$2; _ed_component=$3
    _ed_names=$(ed_package_names "$_ed_component") || return 1
    # Word splitting is intentional and restricted to the literal package list.
    set -- $_ed_names
    if [ "$ED_MANAGER" = apk ]; then
        case "$_ed_action" in install) _ed_verb=add ;; upgrade) _ed_verb=upgrade ;; remove) _ed_verb=del ;; *) return 1 ;; esac
        if [ "$_ed_phase" = plan ]; then timeout 15 "$ED_PM" --simulate "$_ed_verb" "$@"
        else timeout 150 "$ED_PM" "$_ed_verb" "$@"; fi
    elif [ "$ED_MANAGER" = opkg ]; then
        case "$_ed_action" in install|upgrade|remove) ;; *) return 1 ;; esac
        if [ "$_ed_phase" = plan ]; then timeout 15 "$ED_PM" --noaction "$_ed_action" "$@"
        else timeout 150 "$ED_PM" "$_ed_action" "$@"; fi
    else return 1; fi
}
ed_remove_plan_safe() {
    [ "$1" = remove ] || return 0
    _ed_allowed=$(ed_package_names "$2" | tr '\n' ' ')
    # Refuse dependency cascades outside the selected component. Never use force.
    awk -v allowed=" $_ed_allowed " '
        /Purging / { for (i=1;i<=NF;i++) if ($i=="Purging") {seen++; n=$(i+1); if (index(allowed," " n " ")==0) bad=1} }
        /Removing package / {for (i=1;i<=NF;i++) if ($i=="package") {seen++; n=$(i+1); if (index(allowed," " n " ")==0) bad=1}}
        END {exit (bad || !seen) ? 1 : 0}
    ' "$3"
}
ed_package_plan() {
    ed_package_validate "$@"
    ed_acquire_lock
    _ed_plan=$ED_STATE/plan.$$
    _ed_rc=0
    ed_package_command plan "$1" "$2" > "$_ed_plan" 2>&1 || _ed_rc=$?
    _ed_text=$(ed_log_excerpt "$_ed_plan")
    if [ "$_ed_rc" -eq 0 ] && ! ed_remove_plan_safe "$1" "$2" "$_ed_plan"; then
        rm -f "$_ed_plan"
        ed_error dependency_in_use '无法确认卸载仅影响所选组件，已拒绝；请由管理员检查变更计划与依赖关系'
    fi
    rm -f "$_ed_plan"
    [ "$_ed_rc" -eq 0 ] || ed_error package_plan_failed "无法生成软件包计划，请先在系统软件包页面更新索引：$_ed_text"
    json_init; json_add_string status ok
    json_add_string message '请确认软件包管理器给出的实际变更计划'
    json_add_string output "$_ed_text"
    json_dump
}
ed_package_apply() {
    ed_package_validate "$@"
    ed_acquire_lock
    [ -x "$ED_JOB_RUNNER" ] || ed_error missing_dependency '软件包任务执行器缺失'
    _ed_newid=$(/usr/bin/openssl rand -hex 16 2>/dev/null) || ed_error random_failed '无法生成软件包任务标识'
    ed_id_valid "$_ed_newid" || ed_error random_failed '软件包任务标识无效'
    _ed_dir=$ED_STATE/job-$_ed_newid
    mkdir -m 0700 "$_ed_dir" || ed_error state_failed '无法创建软件包任务目录'
    printf '%s\n' "$1" > "$_ed_dir/action"
    printf '%s\n' "$2" > "$_ed_dir/component"
    printf '%s\n' '正在执行软件包操作' > "$_ed_dir/message"
    printf '%s\n' running > "$_ed_dir/state"
    : > "$_ed_dir/output"
    _ed_previous=$(cat "$ED_STATE/current" 2>/dev/null || true)
    printf '%s\n' "$_ed_newid" > "$ED_STATE/current.new"
    mv -f "$ED_STATE/current.new" "$ED_STATE/current"
    # Detach only this allowlisted task; its child adopts and releases the lock.
    trap - EXIT HUP INT TERM
    "$ED_JOB_RUNNER" "$_ed_newid" "$1" "$2" </dev/null >/dev/null 2>&1 &
    if ed_id_valid "$_ed_previous" && [ "$_ed_previous" != "$_ed_newid" ]; then
        _ed_previous_dir=$ED_STATE/job-$_ed_previous
        if [ -d "$_ed_previous_dir" ] && [ ! -L "$_ed_previous_dir" ]; then
            rm -f "$_ed_previous_dir/action" "$_ed_previous_dir/component" "$_ed_previous_dir/message" "$_ed_previous_dir/state" "$_ed_previous_dir/output" "$_ed_previous_dir/pid" "$_ed_previous_dir/plan"
            rmdir "$_ed_previous_dir" 2>/dev/null || true
        fi
    fi
    json_init; json_add_string status ok
    json_add_string message '软件包操作已开始'
    ed_job_json "$_ed_newid"
    json_dump
}
ed_job_update() {
    printf '%s\n' "$2" > "$ED_JOBDIR/message.new"
    mv -f "$ED_JOBDIR/message.new" "$ED_JOBDIR/message"
    printf '%s\n' "$1" > "$ED_JOBDIR/state.new"
    mv -f "$ED_JOBDIR/state.new" "$ED_JOBDIR/state"
}
ed_worker() {
    [ "$#" -eq 3 ] && ed_id_valid "$1" || exit 1
    ED_JOBID=$1; ED_ACTION=$2; ED_COMPONENT=$3
    ED_JOBDIR=$ED_STATE/job-$ED_JOBID
    [ -d "$ED_JOBDIR" ] && [ ! -L "$ED_JOBDIR" ] && [ -d "$ED_LOCK" ] && [ ! -L "$ED_LOCK" ] || exit 1
    [ "$(cat "$ED_STATE/current" 2>/dev/null)" = "$ED_JOBID" ] || exit 1
    [ "$(cat "$ED_JOBDIR/action" 2>/dev/null)" = "$ED_ACTION" ] && [ "$(cat "$ED_JOBDIR/component" 2>/dev/null)" = "$ED_COMPONENT" ] || exit 1
    printf '%s\n' "$$" > "$ED_LOCK/pid"
    printf '%s\n' "$$" > "$ED_JOBDIR/pid"
    trap 'ed_release_lock' EXIT
    trap 'ed_job_update failed "软件包操作被中断，请刷新实际组件状态"; exit 1' HUP INT TERM
    # Recheck after acquiring the exclusive operation lock, including dependencies.
    if ! (ed_package_validate "$ED_ACTION" "$ED_COMPONENT") >> "$ED_JOBDIR/output" 2>&1; then
        ed_job_update failed '软件包操作前置条件已变化，请查看输出并刷新状态'
        exit 1
    fi
    if ! ed_package_command plan "$ED_ACTION" "$ED_COMPONENT" > "$ED_JOBDIR/plan" 2>&1; then
        cat "$ED_JOBDIR/plan" >> "$ED_JOBDIR/output"
        ed_job_update failed '软件包变更计划失败；请检查软件源和索引'
        exit 1
    fi
    if ! ed_remove_plan_safe "$ED_ACTION" "$ED_COMPONENT" "$ED_JOBDIR/plan"; then
        cat "$ED_JOBDIR/plan" >> "$ED_JOBDIR/output"
        ed_job_update failed '无法确认卸载仅影响所选组件，已拒绝卸载'
        exit 1
    fi
    if ed_package_command apply "$ED_ACTION" "$ED_COMPONENT" >> "$ED_JOBDIR/output" 2>&1; then
        ed_job_update succeeded '软件包操作完成，请以实际安装及服务状态为准'
    else
        ed_job_update failed '软件包操作失败或超时，请检查输出并刷新实际状态'
        exit 1
    fi
}
ed_set_arp() {
    [ "$#" -eq 2 ] && [ "$1" = arp ] || ed_error invalid_argument '不支持的发现设置'
    case "$2" in 0|1) ;; *) ed_error invalid_argument 'ARP 开关必须为 0 或 1' ;; esac
    ed_acquire_lock
    if [ "$2" = 1 ]; then ed_component_ready arp || ed_error missing_dependency '请先安装 ARP 扫描增强组件'; fi
    [ -f "$ED_CONFIG" ] && [ ! -L "$ED_CONFIG" ] || ed_error unsafe_path '发现配置文件不存在或路径不安全'
    [ "$("$ED_UCI" -q get easy-discovery.settings 2>/dev/null)" = discovery ] || ed_error config_conflict '发现配置段类型不一致，拒绝覆盖'
    [ -z "$("$ED_UCI" -q changes easy-discovery 2>/dev/null)" ] || ed_error config_busy '发现配置还有待提交修改，请先处理'
    _ed_backup=$(mktemp "$ED_STATE/config.XXXXXX") || ed_error state_failed '无法创建配置备份'
    cp "$ED_CONFIG" "$_ed_backup" || { rm -f "$_ed_backup"; ed_error state_failed '无法备份发现配置'; }
    if ! "$ED_UCI" set "easy-discovery.settings.arp_scan=$2" || ! "$ED_UCI" commit easy-discovery; then
        "$ED_UCI" -q revert easy-discovery >/dev/null 2>&1 || true
        cp "$_ed_backup" "$ED_CONFIG"
        rm -f "$_ed_backup"
        ed_error config_failed '保存 ARP 发现设置失败'
    fi
    rm -f "$_ed_backup"
    ed_ok '发现设置已保存，将从下一次主动发现开始生效'
}
