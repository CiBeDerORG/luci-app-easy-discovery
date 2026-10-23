# 专用账号、权限与会话恢复

Easy Discovery 沿用原 `luci-app-avahi-web` 的 RPCD 授权方式：固定专用账号 `easyadb`、随机密钥、SHA-512-crypt 密码哈希、RPCD 会话及 ACL。新设备接口和 ADB 接口使用同一套登录与授权机制。传输加密由路由器的 HTTPS 提供，本组件不增加一层自定义 JSON 加密。

## 账号与密钥

专用账号只位于 `/etc/config/rpcd` 的 `config login 'easyadb'`。本组件没有系统登录、SSH 或路由器管理员账号创建功能。

- 创建与轮换使用 `openssl rand -hex 32` 生成 64 个十六进制字符，再使用 `openssl passwd -6` 生成 SHA-512-crypt 哈希。
- 明文通过标准输入传给哈希命令，不进入进程参数、配置文件或临时文件。配置和私有事务文件只包含哈希，事务目录权限为 `0700`，提交后的 RPCD 配置权限为 `0600`。
- 明文只出现在创建或轮换成功的本次管理员响应中。页面不将它放入 URL、日志或浏览器持久存储。关闭页面或丢失响应后，必须再次轮换，不能从状态接口找回。
- `status` 不返回密码、密码哈希、会话标识或其他账号信息。

对外客户端先用 `easyadb` 登录 RPCD，再用得到的会话调用发现接口。请使用 HTTPS，并按部署环境限制 `/ubus` 的可访问范围。用户名、随机密钥和会话令牌都不能代替传输加密；使用 HTTP 时，请求内容不会因此自动加密。

## 四项独立能力

管理员在创建或修改授权时明确选择能力，后端只接受 `1` 到 `15` 的整数位掩码。权限均赋给专用账号的 `read` 角色列表；这里的 UCI 名称是 RPCD 的角色载入类别，每个角色真正允许的方法由下表限定。

| 位值 | 页面能力 | ACL 角色 | 允许的调用 |
| --- | --- | --- | --- |
| 1 | 设备列表 | `easy-discovery-devices-list` | `easy-discovery.devices.list` |
| 2 | 设备扫描 | `easy-discovery-devices-scan` | `easy-discovery.devices.scan` |
| 4 | ADB 列表 | `easy-discovery-adb-list` | `easy-discovery.adb.list` |
| 8 | ADB 扫描 | `easy-discovery-adb-scan` | `easy-discovery.adb.scan` |

例如，掩码 `5` 只允许读取两种快照，掩码 `10` 允许发起两种扫描。扫描本身返回当次结果，所以扫描权限也会获得该次扫描的设备信息；它不会隐含赋予独立的 `list` 方法权限。读取快照不会触发扫描。

选中 ADB 扫描时，还会添加 `luci-avahi-easyadb` 兼容角色。该角色只授予 `file.exec` 及其对应的固定命令权限：

```text
/usr/libexec/luci-avahi-scan scan
```

RPCD 同时检查 `ubus` 和 `file` 两个 ACL 范围，专用账号不能借此执行其他命令。它不会获得软件包安装、服务控制、ARP 设置、授权管理或管理员页面权限。

管理员角色 `luci-app-easy-discovery` 单独授予页面需要的发现方法，以及环境/授权脚本的固定操作。软件包名、服务名和动作使用枚举；带权限掩码或任务编号的命令还会在脚本入口严格验证。管理员 ACL 不使用任意文件执行权限。

## 从旧应用迁移

安装新应用不会自动重写旧 `rpcd.easyadb`、轮换原密钥，或扩大旧角色权限。

如果旧账号只有 `luci-avahi-easyadb` 角色，状态返回：

```json
{
  "status": "ok",
  "state": "managed",
  "username": "easyadb",
  "suspended": false,
  "recovery_required": false,
  "permissions": {
    "deviceList": false,
    "deviceScan": false,
    "adbList": false,
    "adbScan": false
  },
  "legacy_adb_scan": true,
  "legacy_only": true
}
```

旧 EasyADB 调用仍可使用原凭据执行兼容扫描。管理员明确修改权限后，后端按选中的四项能力重建角色列表；只有选中 ADB 扫描时才保留兼容扫描权限。仅轮换密钥会保留现有角色，包括只有旧兼容权限的账号。

账号管理不会覆盖以下配置：同名但不同配置段的账号、重复用户名、非 `login` 配置段、未知角色、任何非空 `write` 角色、未知账号字段，或不符合原 SHA-512-crypt 格式的密码。此时返回 `state: "conflict"` 或 `configuration_conflict`，由管理员核对现有配置。管理员账号及其他组件的账号不会被视为本组件可管理的专用身份。

## 管理员命令与返回值

固定入口为 `/usr/libexec/luci-easy-discovery-auth`，只能由管理员调用。

| 命令 | 结果 |
| --- | --- |
| `status` | 返回 `managed`、`absent` 或 `conflict` 状态，以及配置的权限和暂停标志 |
| `create MASK` | 创建新的专用账号；账号已存在时拒绝覆盖 |
| `permissions MASK` | 保留密钥哈希，替换权限并使专用账号旧会话失效 |
| `rotate` | 保留角色，生成新密钥并使专用账号旧会话失效 |
| `revoke` | 删除本组件拥有的专用账号并使其旧会话失效 |

成功修改返回状态字段、`sessions_invalidated: true` 和 `destroyed_sessions`。创建及轮换还返回一次性的 `password`。`destroyed_sessions` 是本次成功销毁的会话数量；在清理过程中自行过期的会话不计入该数字。

错误返回结构如下，进程退出码可能非零，前端应先解析标准输出中的 JSON：

```json
{
  "status": "error",
  "message": "专用账号旧会话未能全部清理，未开放新的登录；账号操作需要恢复。请刷新授权状态，排除错误后重新生成密钥或撤销授权",
  "recovery_required": true,
  "error": {
    "code": "session_cleanup_failed",
    "message": "专用账号旧会话未能全部清理，未开放新的登录；账号操作需要恢复。请刷新授权状态，排除错误后重新生成密钥或撤销授权"
  }
}
```

`state: "managed"` 表示配置归属于本组件，不单独代表授权正在开放。请同时检查 `suspended`。暂停状态下，返回的权限表示保留的配置，发现接口仍会拒绝请求。

## 为什么需要处理已有会话

RPCD 在每次 `session.login` 时读取账号配置，在登录时将 ACL 载入会话。单纯修改密码或角色，无法使已经存在的会话立即失效。RPCD 的重新载入路径还会保存并恢复会话，因此这里不使用全局 RPCD 重启或重新载入来完成密钥轮换。

创建、轮换、修改权限和撤销使用同一事务顺序：

1. 验证固定账号归属、配置路径、待提交修改及会话枚举能力，在私有目录准备完整的最终配置和暂停配置。
2. 原子写入暂停配置，将专用账号密码设为不可登录的 `!`，同时设置 `easy_discovery_suspended=1`。暂停时新的专用账号登录不会通过。
3. 完整枚举 RPCD 会话，只销毁 `data.username` 严格等于 `easyadb` 的会话。默认会话和其他用户名的会话不会被销毁。
4. 再次完整枚举，确认专用账号没有残留会话后，才写入新的密钥/权限，或完成账号删除。

会话 helper 使用 ucode ubus 模块的多响应模式；`session.list` 返回的每个会话是独立响应，不能只取第一个。连接失败、回包形状异常、会话过多、销毁失败、超时或残留会话都作为失败处理。目标会话在枚举后自行过期时允许 `NOT_FOUND`，但仍需通过最终枚举确认。

登录暂停和会话清理完成之间可能仍存在持有旧 ACL 的会话。为此，现代两种接口的 `list`/`scan` 和旧兼容扫描入口都检查暂停标记；发现标记为 `1` 时返回 `auth_suspended` 与空结果，不读取旧快照。这个短暂屏障也会影响管理员发起的发现请求，但不影响管理员登录、环境管理和授权恢复入口。

已经进入执行阶段的发现请求不会被追溯取消，已经发送给客户端的数据也无法收回。会话失效承诺针对操作完成后的新请求；单次 ADB 采集仍受原有扫描窗口限制。另一个 root 管理员直接改写 RPCD 配置或主动重建会话，属于独立的系统管理操作，不在本组件事务锁的控制范围内。

## 失败处理与恢复

暂停配置生效前发生失败，原账号配置保持不变。暂停生效后，如果无法确认会话已清理，组件保留暂停状态，不恢复旧密码，也不把尚未生效的权限报告为成功。这样可以避免在权限收紧失败后继续开放旧权限。

正常异常处理会清理私有暂存文件并释放操作锁。进程被强制终止或系统掉电后，暂停标记可能继续保留；页面会显示需要恢复。管理员修复 RPCD/ubus、存储空间或配置冲突后，可以选择：

```sh
# 查看安全状态，不输出密码或哈希
/usr/libexec/luci-easy-discovery-auth status

# 清理残留会话并生成新密钥，保留角色
/usr/libexec/luci-easy-discovery-auth rotate

# 或清理残留会话后撤销专用账号
/usr/libexec/luci-easy-discovery-auth revoke
```

暂停状态下不允许直接修改权限；先轮换恢复，再按需要调整权限。请勿仅手动把 `easy_discovery_suspended` 改为 `0`，那样会绕过残留会话清理。若整个 RPCD 配置已被外部操作改变，先刷新状态并核对冲突，不能假定之前的暂停屏障仍然存在。

操作锁为 `/tmp/luci-easy-discovery-auth.lock`，目录内 `pid` 记录启动进程。组件不会自动删除可能属于仍在运行操作的锁。若进程异常退出而锁残留，管理员必须先检查该 PID 和正在运行的授权命令，确认没有活动操作后，才可删除该锁内的 `pid` 文件和空锁目录，再执行轮换或撤销。不要批量删除其他组件的锁或 UCI 暂存目录。

## 配置并发边界

账号操作使用专用原子目录锁串行化。本组件发现 `uci changes rpcd` 非空时拒绝操作，不替其他管理员提交或撤销变更。

UCI 修改在私有配置目录和私有保存目录执行，使用每次事务唯一的临时包名，避免读取默认 `/tmp/.uci/rpcd` 中的待提交内容。暂存使用 `uci -t`；`uci -P` 带有禁止提交标志，不适合这里需要生成完整配置的事务。

写入使用同目录临时文件和原子重命名，并在写入前比较配置快照，检测操作期间已发生的外部配置更新。这不是跨所有 root 工具的全局事务锁；不要同时通过其他页面、脚本或终端编辑 RPCD。组件不会承诺能阻止不使用本组件锁的 root 进程在最终比较与重命名之间写入。

## 运行依赖与源码依据

授权入口需要 BusyBox shell、UCI、jshn、`openssl-util`、`ucode` 和 `ucode-mod-ubus`。管理员通过 `rpcd-mod-file` 调用入口；会话 helper 没有授予外部账号的独立 ACL。

实现依据为上游公开源码：

- [RPCD session.c](https://github.com/openwrt/rpcd/blob/master/session.c)：每次登录读取配置、会话中的 `data.username`、会话列表的多次响应和 `session.destroy` 行为。
- [RPCD main.c](https://github.com/openwrt/rpcd/blob/master/main.c)：重新载入时会话保存与恢复的生命周期。
- [ucode ubus 模块](https://lxr.openwrt.org/source/ucode/lib/ubus.c)：`call` 多响应模式与数字错误码读取。
- [UCI cli.c](https://github.com/openwrt/uci/blob/master/cli.c) 与 [delta.c](https://github.com/openwrt/uci/blob/master/delta.c)：`-P`/`-t` 差异及保存目录加载行为。

实际验证结果记录在项目交付说明中。源码级实现不代表已经在真实路由器上验证；不同固件版本的打包、ubus 模块和 HTTPS 配置需要在目标设备上验收。
