# 对外发现接口

## 传输与登录

使用路由器的 HTTPS `/ubus` JSON-RPC 入口。将示例中的 `ROUTER`、`CLIENT_SECRET` 和 `SESSION_ID` 替换为部署环境中的值；这些只是占位符。不要把密钥放入 URL、日志或公开文件。

向 `https://ROUTER/ubus` 发送 `Content-Type: application/json` 的 POST：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "call",
  "params": [
    "00000000000000000000000000000000",
    "session",
    "login",
    { "username": "easyadb", "password": "CLIENT_SECRET", "timeout": 300 }
  ]
}
```

登录成功时，RPCD 返回的 `result[0]` 为 `0`，会话标识位于 `result[1].ubus_rpc_session`。每次调用仍需检查 JSON-RPC/ubus 错误，不能只检查 HTTP 状态码。

RPCD 会话和随机密钥负责身份认证；HTTPS 负责传输加密。本应用不使用自定义请求体加密算法。客户端必须验证服务器证书，私有 CA 应配置为受信任证书，而不是长期关闭验证。

## 四个能力

| 对象 | 方法 | 权限位 | 作用 |
| --- | --- | --- | --- |
| `easy-discovery.devices` | `list` | 1 | 读取最后的设备快照 |
| `easy-discovery.devices` | `scan` | 2 | 显式采集并返回设备快照 |
| `easy-discovery.adb` | `list` | 4 | 读取最后的 ADB 快照 |
| `easy-discovery.adb` | `scan` | 8 | 显式扫描并返回 ADB 快照 |

接口不接受自由形式的 shell 参数、网段或软件包名。发现范围来自管理员配置。

读取设备列表：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "call",
  "params": ["SESSION_ID", "easy-discovery.devices", "list", {}]
}
```

发起 ADB 发现：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "call",
  "params": ["SESSION_ID", "easy-discovery.adb", "scan", {}]
}
```

业务 JSON 位于成功 ubus 回包的 `result[1]`。`scan` 会返回扫描结果，因此拥有扫描权限本身即可得到本次设备信息；它不隐含独立 `list` 权限。调用端无需为获得同次结果再请求列表。

建议现代客户端为扫描设置不少于 15 秒的请求超时。采集器内部设置了独立时间上限：ADB 的 Avahi 窗口为 8 秒，设备的基础采集并行执行，可选 ARP 另有 4 秒窗口。RPC、网络及结果规范化仍有额外耗时，不应将 8 秒理解为端到端硬性截止时间。

## 公共结果

下面展示成功空列表的业务 JSON 结构，不代表某个实际网络：

```json
{
  "status": "ok",
  "schema_version": 1,
  "has_snapshot": true,
  "scanned_at": 1792713600,
  "source": "network-aggregate",
  "storage": "volatile",
  "count": 0,
  "devices": [],
  "truncated": false,
  "errors": [],
  "sources": [],
  "networks": []
}
```

| 字段 | 含义 |
| --- | --- |
| `status` | `ok` 完整结果；`partial` 有可用来源但部分采集失败/受限；`error` 本次操作未成功 |
| `has_snapshot` | 是否存在有效快照；首次读取为 `false`，成功扫描但没有设备为 `true` |
| `scanned_at` | 快照采集完成时的 Unix 秒时间；无快照为 `null`，读列表不更新 |
| `last_attempt_at` | 扫描错误时可附带最近尝试时间，与旧快照时间分开 |
| `source` | `network-aggregate` 或 `avahi` |
| `storage` | 固定 `volatile`，路由器重启即清空 |
| `count` | 本次返回的条目数，不承诺是网络设备总数 |
| `truncated` | 达到条目数或地址数限制；调用端应提示结果不完整 |
| `errors` | `{source, code, message}` 列表 |
| `sources` | 各采集来源及 `ok`、`error`、`unavailable` 或 `disabled` 状态 |
| `networks` | 本次允许的逻辑网络、接口及网段信息 |

尚无快照时返回 `status: "ok"`、`has_snapshot: false`、`scanned_at: null`、`count: 0` 和空 `devices`，不自动触发扫描。

扫描失败会保留最后成功快照并明确返回 `status: "error"`；调用端可以展示旧结果，但必须同时显示错误和原 `scanned_at`。不能把 `devices` 非空当作本次扫描成功。授权暂停时例外：返回 `auth_suspended` 和空结果，避免旧会话在授权变更期间取得快照。

## 设备条目

| 字段 | 类型及语义 |
| --- | --- |
| `id` | 字符串，包含逻辑网络与接口；优先 MAC，无 MAC 时为临时 IP 身份 |
| `name` | 展示名称，按主机名、MAC、IP 等信息回退 |
| `hostname` | 主机名或 `null` |
| `mac` | 小写 MAC 地址或 `null` |
| `ipv4` / `ipv6` | 地址数组，各最多 8 条；IPv6 规范化为压缩形式 |
| `iface` / `network` | 本地接口名与逻辑网络名 |
| `model` / `vendor` | 设备明确上报的型号/厂商；没有来源为 `null` |
| `model_source` / `vendor_source` | 型号/厂商的来源，例如 `mdns:_googlecast._tcp` |
| `sources` | `dhcp`、`dhcp6`、`neighbor`、`host-hints`、`arp`、`mdns` 等来源标签 |
| `observation` | `recent` 本次有可达证据；`lease` 租约信息；`cached` 缓存或缺少可达证据 |
| `last_seen` | 最近明确可达证据的 Unix 秒时间，未知为 `null`；旧值不会被读列表刷新 |
| `last_observed_at` | 最近一次从数据来源中获得该记录的 Unix 秒时间，不等于确认在线 |

设备结果还包含 `observed_count`（本次观测的记录数）和 `reachable_count`（本次有明确可达证据的记录数）。总列表可能包含最多 24 小时内的历史缓存，因此三个数量可能不同。

不会按相同主机名跨网络合并。设备采用随机 MAC、迁移网络或先以无 MAC 的 mDNS 信息出现时，标识可能变化；调用端不应将 `id` 当成永久硬件序列号。

## ADB 条目与旧入口

ADB 条目保留 `iface`、`protocol`、`instance`、`service`、`host`、`address`、`port`，另增加 `network`。`protocol` 为 `IPv4` 或 `IPv6`，`service` 为 `_adb-tls-connect._tcp`。最多返回 32 个不同端点，多余端点使 `truncated` 为 `true`，业务状态仍为 `ok` 以兼容旧客户端。

接口只发现连接服务，不获取设备上的 ADB 配对码，不自动连接设备，也不提供任意 ADB 命令执行。

旧 EasyADB 调用保持：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "call",
  "params": [
    "SESSION_ID",
    "file",
    "exec",
    { "command": "/usr/libexec/luci-avahi-scan", "params": ["scan"] }
  ]
}
```

此调用的业务 JSON 在 `result[1].stdout` 内，需要再次解析。调用端同时检查 `result[1].code` 和业务 `status`。旧角色只允许上述固定命令；新的 `list` 方法需要另外授权。

## 管理接口与错误

软件包、服务与授权管理仅提供给 LuCI 管理员，不属于上述外部 API。管理员固定入口与参数记录在 [实施契约](IMPLEMENTATION-CONTRACT.md)。

常见错误包括 `busy`、`dependency_missing`、`service_stopped`、`scope_unavailable`、`browse_failed`、`sources_unavailable`、`invalid_snapshot`、`auth_suspended` 和 `auth_unavailable`。授权配置无法读取时同样返回空结果。错误消息是用于显示的文本，不应作为程序分支依据；优先使用错误代码并兼容未来新增代码。

同类扫描串行化；被强制终止后可能遗留锁，参见 [验证与故障排查](VERIFICATION.md)。不要通过不停重试 `scan` 来刷新界面；列表展示使用 `list`，扫描由用户或业务任务明确触发。
