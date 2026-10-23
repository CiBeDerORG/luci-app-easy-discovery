# 第一版模块接口约定

此文件是实现约定，功能范围以 README 与用户确认原型为准。

## 目录与执行环境

- `htdocs/luci-static/resources/view/easy-discovery/overview.js`：LuCI 主视图。
- `htdocs/luci-static/resources/easy-discovery/`：样式及可复用前端模块。
- `root/usr/libexec/luci-easy-discovery`：管理员依赖安装/服务管理入口。
- `root/usr/libexec/luci-easy-discovery-auth`：专用账号管理入口。
- `root/usr/libexec/luci-easy-discovery-adb`：ADB 扫描/快照读取入口。
- `root/usr/libexec/luci-easy-discovery-devices`：设备采集/快照读取入口。
- `root/usr/libexec/luci-avahi-scan`：旧 EasyADB 兼容入口。
- `root/usr/libexec/rpcd/easy-discovery.adb` 和 `easy-discovery.devices`：RPCD 可执行插件，各自支持 list、scan，无自由形式的参数。
- 运行依赖采用 BusyBox shell、jshn、ucode（fs/ubus 模块）。可选 Avahi、D-Bus、arp-scan 不列为应用强制依赖。
- 主网络范围来自 /etc/config/easy-discovery 的 config discovery 'settings'，list network 'lan'（可追加 guest）。
- 发现快照仅存 /tmp/easy-discovery，按能力独立加锁；无后台定时扫描。

## 管理员环境接口（通过 LuCI fs.exec 调用）

固定命令 /usr/libexec/luci-easy-discovery：

- status → {status:'ok',package_manager:'apk'|'opkg'|'none',components:[{id:'avahi'|'dbus'|'arp',name,installed:'installed'|'partial'|'missing',packages:[{name,installed:boolean,version:string|null}],has_service:boolean,running:boolean,enabled:boolean}],job:null|{id,state,action,component,message,output}}。
- service COMPONENT ACTION，COMPONENT=avahi|dbus，ACTION=start|stop|restart|enable|disable → {status:'ok',message}；D-Bus 的 stop/restart 影响 Avahi，UI 明确提示。启动 Avahi 时先启动 D-Bus。
- discovery arp 0|1 → 保存 ARP 扫描参与设置；status 另返回 settings.arp_scan 与 settings.networks。开启要求已安装，关闭不要求已安装，卸载前应先关闭参与。
- package plan ACTION COMPONENT，ACTION=install|upgrade|remove，COMPONENT=avahi|dbus|arp → {status:'ok',output,message}。使用固定包名的包管理器模拟；卸载需已停止服务。
- package apply ACTION COMPONENT → {status:'ok',job:{id,state:'running'|'succeeded'|'failed'},message}，异步执行并只保留单个活动作业；极短任务可能已进入终态。
- package job JOB_ID → {status:'ok',job:{id,state:'running'|'succeeded'|'failed',action,component,message,output}}。前端只在明确发起安装任务期间轮询，终态立即停止。
- 错误返回 {status:'error',message,error:{code,message}}，可能伴随非零进程返回值；前端需读取 stdout 中的 JSON 再显示。

## 管理员授权接口（通过 LuCI fs.exec 调用）

固定命令 /usr/libexec/luci-easy-discovery-auth：

- status → {status:'ok',state:'managed'|'absent'|'conflict',username:'easyadb',permissions:{deviceList:boolean,deviceScan:boolean,adbList:boolean,adbScan:boolean},legacy_adb_scan:boolean,legacy_only:boolean,suspended:boolean,recovery_required:boolean}。
- create MASK、permissions MASK：MASK 1..15，位值 deviceList=1、deviceScan=2、adbList=4、adbScan=8。创建/编辑权限均由管理员明确选择。
- rotate：轮换密钥，保留权限。
- revoke：撤销专用授权。
- create/rotate 成功时额外返回 password，一次性显示，不写日志、不缓存、不放 URL 或 localStorage。
- 成功/失败 JSON 与环境入口一致。出现配置冲突不得覆盖已有账号。
- 保留旧 username=easyadb、rpcd.easyadb 与已有密码哈希；旧 luci-avahi-easyadb 角色只保留旧 file.exec scan 能力，不在迁移时扩大权限。旧账号状态 legacy_only=true、新能力均 false，兼容入口权限独立显示。
- 创建现代账号时按选中能力赋独立 ACL 角色；选中 adbScan 时一并授予旧兼容扫描角色。
- 轮换、撤销、权限收紧必须处理专用账号已有会话，不能影响管理员会话；任何未能实现的边界在返回状态/文档中明确。
- 变更成功返回 sessions_invalidated 与 destroyed_sessions；暂停期间所有发现入口返回 auth_suspended 和空结果。暂停后清理失败保持暂停，需要轮换或撤销恢复。

## 对外发现接口

- ubus 对象 easy-discovery.devices 与 easy-discovery.adb，方法 list 和 scan。
- LuCI 通过 rpc.declare 调用；登录和 ACL 统一走 RPCD。
- 公共结果：{status:'ok'|'partial'|'error',has_snapshot:boolean,schema_version:1,scanned_at:number|null,count:number,storage:'volatile',devices:[],errors:[],truncated:boolean}。
- 尚无快照：status=ok、has_snapshot=false、scanned_at=null、devices=[]；成功空结果 has_snapshot=true。
- 失败保持上一次成功快照。返回明确错误及上次时间，不将旧结果冒充新扫描结果。
- ADB devices 保留 iface、protocol、instance、service、host、address、port。现代入口也可以保持 32 条上限，避免兼容分歧；协议为 IPv4/IPv6。
- 设备项：{id,name,hostname,mac,ipv4:[],ipv6:[],iface,network,vendor:null|string,model:null|string,sources:[],observation:'recent'|'lease'|'cached',last_seen:number|null}。有明确来源才填厂商/型号；不猜测型号。设备标识至少含网络范围，不按 IP/名称跨网络合并。
- 设备附加 last_observed_at、model_source、vendor_source；结果附加 observed_count、reachable_count、sources 与 networks。last_observed_at 表示来源观测时间，不代表可达；失败另有 last_attempt_at。
- 合并失去本次观测的记录时 observation=cached、last_seen 保持旧值；不将 list 调用时间写入发现时间。
- 外部返回的所有字符串视为不可信，前端只用文本 DOM 渲染。

## 验证与交付

- 不部署到真实设备、不手动触发 CI。
- 第一版正常开发可做本地语法与隔离夹具检查；没有 OpenWrt 环境时不声称真实路由器已验证。
- 代码、构建说明、迁移说明、接口协议及实施进度提交到仓库。

