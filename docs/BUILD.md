# 构建与安装

源码仓库不提交安装包二进制，构建成功后可从 Actions artifact 下载。SDK 由开发端或 CI 用来生成原生安装包，**安装者不需要准备 SDK，也不需要取得刷机固件当时的原始 SDK**。

当前应用只包含脚本、LuCI 页面与配置，声明 `PKGARCH=all`，没有本机编译程序、内核模块或固件修订号锁定。选择与目标固件相近、包管理器兼容的官方 OpenWrt / ImmortalWrt SDK 是构建建议；对于当前应用，SDK 与固件精确到同一源码提交不是安装的硬性条件。`all` / `noarch` 也不代表可以混装 APK/IPK，或忽略运行时依赖。

实际安装需要确认：原生包格式可被设备包管理器读取；现有固件与软件源能够满足 LuCI/RPCD、ucode 及其 fs/ubus 模块等依赖；设备信任同次构建的签名公钥；已按迁移说明处理旧插件的同名文件。CI 的打包、验签通过不能替代这些目标设备检查，也不要求为了安装本应用更换固件或切换到其他固件的软件源。

## 测试通过后构建 APK

打开 **Actions → 测试与 APK 构建 → Run workflow**，选择分支并保留“测试通过后构建当前设备平台的 APK”。也可以向 `ci/**` 专用分支推送已提交的代码来执行同一流程。

工作流依次执行源码/ACL 契约检查、真实 ucode 发现夹具、17 项 DOM 交互测试和 14 项隔离后端事务测试，全部通过后才构建软件包。取消构建选项时只执行测试。`main` 的普通推送不自动启动本流程。

默认 SDK 配置为 [ci/sdk-profile.json](../ci/sdk-profile.json) 中的 ImmortalWrt SNAPSHOT `qualcommax/ipq60xx`，对应已确认的设备平台与 `aarch64_cortex-a53` 架构。每次运行从官方校验文件确定当次 SDK，下载后核验 SHA256，并把 SDK 版本、校验值及 feeds 版本保存为 artifact。SDK 压缩包按 SHA256 缓存，命中缓存仍再次校验。

当前官方 SNAPSHOT 与设备曾报告的定制固件 `r0-1f96307` 不一定是同一源码版本。使用该 SDK 不会给当前脚本包添加固件版本锁；本 CI 验证原生 APK 打包与签名，目标路由器的依赖和运行兼容性仍需按下方步骤验收。需要使用某个固定固件 SDK 时，使用下面的独立构建工作流。

## GitHub Actions 手动构建

仓库提供 [构建 OpenWrt 软件包](../.github/workflows/build-package.yml) 工作流，支持 `workflow_dispatch` 手动输入 SDK，也可由测试工作流在通过后复用。

1. 从固件发行版官方下载目录找到对应 SDK，以及 `sha256sums` 中该文件的 SHA256。
2. 打开仓库 **Actions → 构建 OpenWrt 软件包 → Run workflow**。
3. 填入 `sdk_url` 和 `sdk_sha256`，手动启动。
4. 工作流校验下载文件，准备 SDK feeds，再用当前 SDK 的原生打包工具构建。
5. 完成后下载名为 `luci-app-easy-discovery-<提交 SHA>` 的 artifact。实际文件是 SDK 对应的 `.ipk` 或 `.apk`，不进行改后缀转换。签名 APK 会同时附上 `public-key.pem` 和原生包元数据 JSON，并在上传前通过 SDK 的 `apk verify` 验证。压缩包内提供 `SHA256SUMS`；构建私钥不会上传。
6. 构建日志保存在 `build-log-<提交 SHA>`，自动测试流程另提供 `sdk-source-<提交 SHA>` 来源记录。

下载地址限定为 `https://downloads.openwrt.org/` 或 `https://downloads.immortalwrt.org/`。其他定制固件可使用下面的本地构建流程及该固件的 SDK。

Actions 中 SDK/feeds 下载、依赖编译或源站错误仍可能导致构建失败；请查看对应步骤输出。本仓库不声明已在所有固件分支验证。

## 本地 SDK 构建

在合适的 Linux 构建环境准备对应 SDK。将本仓库克隆到 SDK 目录之外，然后在 SDK 根目录执行：

```sh
./scripts/feeds update -a
./scripts/feeds install -a
sh /绝对路径/luci-app-easy-discovery/scripts/build-sdk.sh /绝对路径/luci-app-easy-discovery
```

脚本会在 `package/luci-app-easy-discovery` 建立指向源码的链接，保留 SDK 的全局配置并设置应用为模块，执行 `make defconfig` 后确认应用确实被选中，再进行包级编译；遇到同名且指向其他源码的目录会拒绝覆盖。最终安装包在 SDK 的 `bin` 目录下，脚本会输出具体路径。

当前应用只安装脚本和页面资源。脚本会复用 SDK 的元数据解析器，确认本应用没有编译步骤、额外构建依赖，以及所有直接依赖和虚拟提供者均没有 ABI 后缀；确认后，先调用 SDK 原生目标准备 APK 签名密钥，再仅打包本应用。依赖声明、配置文件清单、维护脚本与 SDK 原生包检查仍保留。出现 ABI 依赖、未知语法、元数据缺失或新的编译步骤时，会回退完整依赖构建。可通过 `EASY_DISCOVERY_FULL_BUILD=1 sh /源码/scripts/build-sdk.sh /源码` 强制完整路径。

CI 在真实 SDK 解析器上运行构建资格回归用例，防止后续增加共享库、虚拟提供者或宿主依赖时误用快捷路径。这项打包验证不等于在路由器上验证依赖安装和服务运行。

如果 SDK 自带的 feeds 清单使用与固件不兼容的开发分支，应先按照固件厂商说明调整到正确版本，再执行更新与构建。不要直接拿其他版本的软件源给路由器补依赖。

## 安装

在路由器的 **系统 → 软件包** 页面安装，或者将安装包传到路由器 `/tmp` 后使用固件原生包管理器：

```sh
# 使用 OPKG 的固件；替换为实际文件名
opkg install /tmp/luci-app-easy-discovery_实际版本_all.ipk

# 使用 APK 的固件；使用同一次 CI 产物里的公钥和 APK
mkdir -p /etc/apk/keys
cp /tmp/public-key.pem /etc/apk/keys/easy-discovery-ci.pem
chmod 0644 /etc/apk/keys/easy-discovery-ci.pem
apk add /tmp/luci-app-easy-discovery-实际版本.apk
```

完整解压 CI 产物后，可执行 `sha256sum -c SHA256SUMS` 核对文件。每次 CI 的公钥对应同一次构建，APK 与公钥需要配套使用；本地手动构建则使用该 SDK 目录内的 `public-key.pem`。若包管理器拒绝签名，核对包格式、SDK 版本与配套公钥，不要把后缀改为 IPK 或绕过依赖检查。

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
