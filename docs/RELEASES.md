# 自动发布与公开下载

每次分支 push 的流水线为：测试 → 原生 APK 构建及验签 → Actions 产物 → GitHub Release。发布任务只下载同一次运行、同一提交的安装包，不会借用旧版产物冒充本次成功构建。手动运行「测试与 APK 构建」且勾选打包时执行相同流程；仅测试时不会发布。

## 下载入口

- [最新主分支 Release](https://github.com/CiBeDerORG/luci-app-easy-discovery/releases/latest)
- [最新主分支 APK 固定地址](https://github.com/CiBeDerORG/luci-app-easy-discovery/releases/latest/download/luci-app-easy-discovery.apk)
- [完整安装包、公钥及原始校验清单](https://github.com/CiBeDerORG/luci-app-easy-discovery/releases/latest/download/easy-discovery.zip)

公开仓库的 Release 附件无需登录即可下载，不受 Actions artifact 的 14 天保留期影响；手动删除 Release 或附件仍会导致相应链接失效。

## 分支和版本

`main` 的当前提交构建成功后设为 Latest，固定下载地址自动指向新包。其他分支生成预发布版，不覆盖主分支 Latest。旧主分支提交重跑只发布历史版本，不将 Latest 倒退。Latest 表示最近的主分支成功产物，不代表已经完成真实路由器验收。

每次构建使用独立标签 `v<软件包版本>-build.<运行编号>.<重跑次数>`，标签目标为实际构建提交。同一个软件包修订号可以对应不同构建记录，已公开的旧版本不被覆盖。新增业务修复仍应递增 Makefile 中的软件包修订号，Release 标签不是包管理器版本号。

## 附件与发布保护

发布版本化 APK、同内容固定名称 `luci-app-easy-discovery.apk`、配套 `public-key.pem`、元数据、构建信息、校验清单及 `easy-discovery.zip`。ZIP 内保留原始安装包及原始校验清单；Release 单独的 `SHA256SUMS` 还覆盖固定名称 APK 和 ZIP。

只发布允许列表内、经过 SHA256 校验的文件，并核对产物源码提交。未知附件、私钥、符号链接及不完整校验清单均拒绝发布。构建签名私钥不会上传。

先创建草稿，再上传并检查全部附件，最后公开发布；上传或校验失败时保留草稿，旧公开版本及 Latest 不变。每次重跑使用新标签，不删除旧资产。

仅 Release 作业授予 `contents: write`，测试与构建继续使用只读权限，使用 Actions 内置 `GITHUB_TOKEN`，不要求另配个人令牌。独立的「构建 OpenWrt 软件包」工作流允许自选 SDK/IPK，它仍只生成 Actions artifact，不自动作为主分支 APK 发布。

## 安装

通过完整 ZIP 获取同一次构建的 APK、公钥与校验清单。沿用开发包的宽松签名安装方式时，可将固定名称 APK 上传到 `/tmp` 后执行：

```sh
apk add --allow-untrusted /tmp/luci-app-easy-discovery.apk
```

该参数仅允许未受信任签名，不跳过依赖或文件冲突检查。新旧插件迁移及公钥安装方式仍见 [构建与安装](BUILD.md)。
