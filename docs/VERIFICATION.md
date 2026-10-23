# 验证状态与故障排查

## 当前交付状态

本次为 Easy Discovery `0.1.0` 软件包修订号 `2` 的运行测试与 CI 接入。生产页面使用真实 RPCD 返回值，演示数据只保留在 `docs/ui-preview.html` 的设计原型中。

2026-10-23 在开发容器完成以下运行测试：

| 范围 | 结果与含义 |
| --- | --- |
| 发现格式化 | 13 次真实 ucode 调用通过，包含 23 个业务断言和每次退出码检查 |
| 前端交互 | 17 项 jsdom 行为测试通过，执行实际 LuCI 模块，替换加载桥接与 RPC 传输 |
| 授权与环境事务 | 14 项隔离测试通过，执行真实 BusyBox ash、UCI、jshn、OpenSSL 与 ucode；权限用例遍历 1–15 全部掩码 |
| 源码与 ACL 契约 | 检查 Shell、JavaScript、JSON、Python 语法，外部权限边界及菜单/资源路径 |
| SDK 解析 | 实际读取官方元数据并生成 SDK URL、SHA256、版本及 feeds 来源记录 |

测试暴露并修复三处生产问题：ucode 属性删除语法错误；含 NUL 的控制字符正则导致运行错误/截断；授权屏障返回空结果时前端继续保留旧设备快照。修复后相关回归用例均通过。

没有连接真实路由器。后端测试中的 ubus 传输、软件包管理器和 init 服务采用有状态替身；这些测试不能证明真实 RPCD ACL、网络广播和固件包安装已经集成通过。开发容器没有浏览器二进制，未执行 CSS 截图验收。

Actions 的 **测试与 APK 构建** 工作流会在干净 Ubuntu runner 中重新构建测试运行时并执行上述测试，通过后再用官方 SDK 构建。每次 CI 的实际结果、日志与安装包以对应 Actions 运行记录为准，不能把仅完成工作流配置视为 CI 已通过。首次安装按 [目标设备验收步骤](BUILD.md#首次验收顺序) 检查。

## 复现全部本地测试

Ubuntu 需要 `build-essential`、`cmake`、`pkg-config`、`libjson-c-dev`、`busybox`、`curl`、Git、Python 3、OpenSSL 和 Node.js 22。运行时只写入指定临时目录。

```sh
sh scripts/prepare-test-runtime.sh /tmp/easy-discovery-test-runtime
sh tests/backend/prepare-runtime.sh /tmp/easy-discovery-backend-runtime
npm ci --prefix tests/frontend --ignore-scripts --no-audit --no-fund
python3 tests/check-source.py
python3 tests/discovery-fixtures.py /tmp/easy-discovery-test-runtime/ucode-build/ucode
npm test --prefix tests/frontend
python3 tests/backend/run.py --runtime /tmp/easy-discovery-backend-runtime --ucode /tmp/easy-discovery-test-runtime/ucode-build/ucode
```

测试运行时固定官方源码：ucode `6cfc97fbfe1f3a5226245e62fdf8e3b150d70859`、libubox `da2d205a5cf3e877c45a2eec488218cbaf452e7d`、UCI `74f6277aabffc943d026f406df57c22595134c42`。Node 测试使用锁定依赖的 `jsdom@26.1.0`。

## 隔离夹具

`tests/discovery-fixtures.py` 是发现格式化模块的隔离夹具。它在临时目录构造输入，使用 ucode 执行纯格式化逻辑，不扫描网络、不修改真实 UCI 配置。

具备 Python 3、ucode 和 ucode fs 模块的正常开发环境中，可以显式运行：

```sh
python3 tests/discovery-fixtures.py
```

夹具覆盖接口范围、Avahi 转义与端点上限、MAC/IPv6 归一化、租约状态、mDNS 型号来源、无效 JSON 回退、历史快照和跨网络隔离。缺少运行时就无法执行，不能把夹具文件存在视为通过。

用户明确指定“改 BUG 模式”或“调试模式”时，不运行夹具、语法检查、构建、lint 或 CI。

## 常见排查路径

### 没有设备或没有型号

先检查配置的逻辑网络是否已启动，再核对 DHCP/邻居数据是否存在。设备没有发布服务或没有上报型号时显示“未识别”是预期结果。应用不保证看见当前网络的每一台设备。

### ADB 返回依赖缺失或服务停止

在运行环境中安装完整 Avahi/D-Bus 组件，再启动服务。手机需要开启无线调试并在所选本地网络发布连接服务。停止或重启 D-Bus 会先停止 Avahi；重启 D-Bus 后需手动启动 Avahi。

### 软件包计划或安装失败

检查固件软件源、索引、可用空间和输出日志。应用不会使用强制移除参数。卸载计划含所选组件之外的软件包，或输出格式无法证明卸载范围时，操作会被拒绝；由管理员在系统软件包页面核对依赖关系。

软件包任务及日志存于 `/tmp/easy-discovery/environment`。任务被中断后页面会显示失败并回读实际组件状态，不把“已接受请求”当成安装成功。路由器重启会清空任务记录。

### 发现一直提示 busy

正常退出和 HUP/INT/TERM 会清理发现锁。`SIGKILL` 或异常断电可能留下工作目录和锁；重启会清空 `/tmp`。

如果不能重启，管理员先检查 `/tmp/easy-discovery/discovery/devices.lock/pid` 或 `adb.lock/pid` 及当前扫描进程，确认没有活动扫描后，才能删除对应的 `pid` 文件及空锁目录。不要批量删除活动任务目录。发现模块刻意不按旧 PID 自动抢删锁，避免 PID 重用与并发恢复删除活跃锁。

### 授权显示暂停或配置冲突

参见 [授权恢复说明](AUTHENTICATION.md#失败处理与恢复)。暂停时不要手动移除标记；在环境正常后执行“重新生成密钥”或“撤销授权”，让组件完成专用账号会话清理。发现接口在暂停期间返回空结果。
