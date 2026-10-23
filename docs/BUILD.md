# 构建与安装

应用源码不包含现成安装包。请选择与目标路由器**固件发行版、版本、目标平台和架构匹配**的官方 OpenWrt / ImmortalWrt SDK。`PKGARCH=all` 表示应用脚本本身不包含本机编译代码，不代表可以跨固件软件包格式混装。

## GitHub Actions 手动构建

仓库提供 [构建 OpenWrt 软件包](../.github/workflows/build-package.yml) 工作流，只配置了 `workflow_dispatch`，推送代码不会自动启动构建。

1. 从固件发行版官方下载目录找到对应 SDK，以及 `sha256sums` 中该文件的 SHA256。
2. 打开仓库 **Actions → 构建 OpenWrt 软件包 → Run workflow**。
3. 填入 `sdk_url` 和 `sdk_sha256`，手动启动。
4. 工作流校验下载文件，准备 SDK feeds，再用当前 SDK 的原生打包工具构建。
5. 完成后下载名为 `luci-app-easy-discovery-<提交 SHA>` 的 artifact。实际文件是 SDK 对应的 `.ipk` 或 `.apk`，不进行改后缀转换。

下载地址限定为 `https://downloads.openwrt.org/` 或 `https://downloads.immortalwrt.org/`。其他定制固件可使用下面的本地构建流程及该固件的 SDK。

Actions 中 SDK/feeds 下载、依赖编译或源站错误仍可能导致构建失败；请查看对应步骤输出。本仓库不声明已在所有固件分支验证。

## 本地 SDK 构建

在合适的 Linux 构建环境准备对应 SDK。将本仓库克隆到 SDK 目录之外，然后在 SDK 根目录执行：

```sh
./scripts/feeds update -a
./scripts/feeds install -a
sh /绝对路径/luci-app-easy-discovery/scripts/build-sdk.sh /绝对路径/luci-app-easy-discovery
```

脚本会在 `package/luci-app-easy-discovery` 建立指向源码的链接，设置应用为模块，执行 `make defconfig` 和包级编译；遇到同名且指向其他源码的目录会拒绝覆盖。最终安装包在 SDK 的 `bin` 目录下，脚本会输出具体路径。

如果 SDK 自带的 feeds 清单使用与固件不兼容的开发分支，应先按照固件厂商说明调整到正确版本，再执行更新与构建。不要直接拿其他版本的软件源给路由器补依赖。

## 安装

在路由器的 **系统 → 软件包** 页面安装，或者将安装包传到路由器 `/tmp` 后使用固件原生包管理器：

```sh
# 使用 OPKG 的固件；替换为实际文件名
opkg install /tmp/luci-app-easy-discovery_实际版本_all.ipk

# 使用 APK 的固件；替换为实际文件名
apk add /tmp/luci-app-easy-discovery-实际版本.apk
```

本地构建 APK 的签名信任策略按固件要求处理：优先配置构建签名及受信任公钥。若包管理器拒绝签名，不要把后缀改为 IPK，也不要绕过依赖检查；核对包格式、SDK 版本与信任配置。

应用的必需依赖由包管理器安装，包括 LuCI/RPCD、jshn、ucode（fs/ubus 模块）、OpenSSL 工具和 `ip` 提供者。Avahi、D-Bus 与 `arp-scan` 在应用的运行环境页面按需安装。

已有 `luci-app-avahi-web` 时，先按 README 迁移说明备份配置并卸载旧应用。不要强制覆盖新旧包的同名文件。新应用的安装脚本不会生成客户端密钥，也不会扩展旧账号 ACL。

## 首次验收顺序

1. 打开原有 LuCI 界面，确认 **服务 → Easy Discovery** 出现。
2. 确认首次列表显示“尚未发现”，没有演示设备；发起设备发现后，检查 IP、MAC、来源与状态。
3. 安装 D-Bus/Avahi，分别检查安装状态、运行状态和开机自启；在手机已经开启无线调试的环境中发起 ADB 发现。
4. 创建只读授权，登录后验证两种列表可读、扫描和环境管理被拒绝；再明确授予扫描能力。
5. 使用专用账号登录，轮换密钥后验证旧会话与旧密钥失效，管理员会话仍可用。
6. 如从旧应用迁移，先用旧凭据验证固定扫描入口，再选择是否增授新接口。

这些是目标设备的验收步骤，不是已完成的测试结果。当前交付的检查边界见 [验证说明](VERIFICATION.md)。
