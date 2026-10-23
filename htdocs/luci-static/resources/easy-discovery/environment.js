'use strict';
'require baseclass';
'require easy-discovery.common as ed';

var components = {
	avahi: { name: 'Avahi', purpose: '发现局域网 mDNS 与无线 ADB 端点', icon: 'discover' },
	dbus: { name: 'D-Bus', purpose: '为 Avahi 提供进程间通信支持', icon: 'link' },
	arp: { name: 'ARP 扫描增强', purpose: '按需补充同一二层网络内的 IPv4 设备', icon: 'network' }
};
function installedLabel(component) { return component.installed === 'installed' ? '已安装' : component.installed === 'partial' ? '安装不完整' : '未安装'; }
function title(component) {
	var meta = components[component.id] || {name:component.name || component.id, icon:'box'};
	return E('div', {'class':'ed-device'}, [E('span', {'class':'ed-device-icon'}, [ed.icon(meta.icon)]),
		E('div', [E('strong', [meta.name, component.id === 'arp' ? E('span', {'class':'ed-mini-tag'}, ['可选']) : '']),
			E('div', {'class':'ed-package-names'}, (component.packages || []).map(function(pkg) {
				return E('span', {'class':'ed-code-tag',title:pkg.version ? pkg.name + ' · ' + pkg.version : pkg.name}, [pkg.name + (pkg.version ? ' · ' + pkg.version : '')]);
			}))])]);
}
function switchButton(label, enabled, disabled, change) {
	return E('div', {'class':'ed-switch-label'}, [E('button', {type:'button', 'class':'ed-switch',role:'switch','aria-label':label,'aria-checked':String(!!enabled),disabled:disabled?'':null,
		click:function() { if(!this.disabled) change(!enabled); }}), E('span',[enabled?'已开启':'已关闭'])]);
}
function jobCard(ctx) {
	var job = ctx.state.packageJob;
	if (!job) return '';
	var running = job.state === 'running';
	var stateLabel = running ? '正在执行' : job.state === 'succeeded' ? '已完成' : '执行失败';
	var controls = [];
	if (running && !ctx.state.packageWatching) controls.push(ed.button('继续查看进度', ctx.actions.watchJob, {kind:'small',icon:'refresh'}));
	return E('div', {'class':'ed-card ed-job-card'}, [ed.section('软件包任务 · ' + stateLabel, ed.text(job.message, '操作结束后将重新读取实际组件状态。'), E('div',{'class':'ed-tools'},controls)),
		running && ctx.state.packageWatching ? E('div',{'class':'ed-progress'}) : '',
		E('div', {'class':'ed-job-meta'}, [ed.badge(ed.text((components[job.component] || {}).name, job.component),running?'blue':job.state==='succeeded'?'success':'error'),
			E('span', ['任务 ' + ed.text(job.id)])]),
		job.output ? E('details',{'class':'ed-job-output'},[E('summary',['查看执行日志']),E('pre',{'class':'ed-code'},[String(job.output)])]) : '',
		ctx.state.packageWatchError ? ed.note(ctx.state.packageWatchError,'warning') : '']);
}

return baseclass.extend({
	render: function(ctx) {
		var state = ctx.state, environment = state.environment, inventory = environment && Array.isArray(environment.components) ? environment.components : [];
		var packages = state.environmentTab === 'packages';
		var locked = !state.canWrite || state.busy.environment || state.busy.auth || state.busy.devices || state.busy.adb || !!(state.packageJob && state.packageJob.state === 'running');
		var ready = ctx.actions.adbReady(), content = [];
		if (state.errors.environment) content.push(ed.note(state.errors.environment,'error'));
		content.push(E('div',{'class':'ed-section-top'},[E('div',[E('h2',['运行环境']),E('p',['先准备发现组件，再按需开启相关服务。'])]),
			ed.badge(environment?(ready?'发现能力已就绪':'部分能力待开启'):'状态未知',environment&&ready?'success':'warning')]));
		content.push(E('div',{'class':'ed-env-steps','aria-label':'环境配置步骤'},[
			E('button',{type:'button','class':'ed-env-step'+(packages?' active':''),'aria-pressed':String(packages),click:function(){ctx.actions.environmentTab('packages');}},[
				E('span',{'class':'ed-step-number'},['01']),E('span',[E('strong',['依赖安装']),E('small',['安装、更新或移除软件组件'])]),ed.icon('box')]),
			E('button',{type:'button','class':'ed-env-step'+(!packages?' active':''),'aria-pressed':String(!packages),click:function(){ctx.actions.environmentTab('services');}},[
				E('span',{'class':'ed-step-number'},['02']),E('span',[E('strong',['服务管理']),E('small',['启动服务与设置开机自启'])]),ed.icon('power')])
		]));
		content.push(jobCard(ctx));
		if (!environment || !inventory.length) {
			content.push(E('div',{'class':'ed-card'},[ed.empty('组件状态暂不可用','请点击刷新组件状态重新读取；不会自动安装或启动软件。',
				ed.button('刷新组件状态',ctx.actions.refreshEnvironment,{icon:'refresh',disabled:state.busy.environment}))]));
			return E('div',content);
		}
		if (packages) {
			var requiredReady=inventory.filter(function(c){return c.id==='avahi'||c.id==='dbus';}).every(function(c){return c.installed==='installed';});
			content.push(ed.note(requiredReady?'ADB 所需组件已安装。服务运行状态请在「服务管理」中查看。':'ADB 依赖尚未齐全。可按组件安装或补齐缺失的软件包。',requiredReady?'success':'warning'));
			var rows=inventory.map(function(component){
				var meta=components[component.id]||{purpose:''}, complete=component.installed==='installed';
				var purpose=[E('div',[meta.purpose])];
				if(component.id==='arp'){
					if(environment.settings&&typeof environment.settings.arp_scan==='boolean'){
						purpose.push(E('div',{'class':'ed-arp-setting'},[E('span',['参与设备发现']),switchButton('ARP 扫描参与设备发现',environment.settings.arp_scan,locked||(!complete&&!environment.settings.arp_scan),ctx.actions.arp)]));
						purpose.push(E('div',{'class':'ed-sub'},['仅作用于下一次主动发现，安装不会自动启用。']));
					}else purpose.push(E('div',{'class':'ed-sub'},['安装后还需开启发现设置中的 ARP 扫描，默认关闭。']));
				}
				var action=complete?'upgrade':'install',label=complete?'检查更新':component.installed==='partial'?'补齐组件':'安装';
				var arpEnabled=component.id==='arp'&&environment.settings&&environment.settings.arp_scan;
				var removeBlocked=locked||arpEnabled||component.running||(component.id==='dbus'&&inventory.some(function(c){return c.id==='avahi'&&c.running;}));
				return E('tr',[
					ed.cell([title(component)]),ed.cell(purpose),ed.cell([ed.badge(installedLabel(component),complete?'success':component.installed==='partial'?'warning':'')]),
					ed.cell([E('div',{'class':'ed-row-actions'},[
						ed.button(label,function(){ctx.actions.packageAction(action,component.id);},{kind:complete?'small':'primary small',icon:complete?null:'download',disabled:locked||environment.package_manager==='none'}),
						component.installed!=='missing'?ed.button('卸载',function(){ctx.actions.packageAction('remove',component.id);},{kind:'text muted',disabled:removeBlocked||environment.package_manager==='none',title:arpEnabled?'先关闭“参与设备发现”，再卸载组件':removeBlocked?'先停止相关服务，再卸载组件':null}):''
					])])]);
			});
			content.push(E('div',{'class':'ed-card'},[ed.section('依赖组件','安装状态与运行状态分别管理。',ed.badge('包管理器：'+environment.package_manager)),
				ed.table(['组件','用途','安装状态','操作'],rows,'ed-environment-table'),
				E('div',{'class':'ed-card-foot'},[ed.icon('box'),E('span',['依赖安装完成后，进入「服务管理」查看并启动服务。卸载前需先停止对应服务。'])])]));
		}else{
			var services=inventory.filter(function(c){return c.id==='avahi'||c.id==='dbus';});
			var serviceRows=services.map(function(component){
				var complete=component.installed==='installed';
				return E('tr',[
					ed.cell([title(component)]),
					ed.cell([ed.badge(component.running?'运行中':component.has_service?'未运行':'服务未安装',component.running?'success':'')]),
					ed.cell([switchButton((components[component.id]||{}).name+' 开机自启',component.enabled,locked||!component.has_service,function(enabled){ctx.actions.service(component.id,enabled?'enable':'disable');})]),
					ed.cell([E('div',{'class':'ed-row-actions'},[
						component.running?ed.button('重启',function(){ctx.actions.service(component.id,'restart');},{kind:'small',icon:'refresh',disabled:locked||!component.has_service}):'',
						ed.button(component.running?'停止':'启动服务',function(){ctx.actions.service(component.id,component.running?'stop':'start');},{kind:component.running?'small':'primary small',icon:component.running?null:'power',disabled:locked||!component.has_service||(!component.running&&!complete)})
					])])
				]);
			});
			content.push(ed.note(ready?'Avahi 与 D-Bus 均已启动，可以主动发现无线 ADB 端点。':'请先确认依赖完整，再启动服务。设备基础发现仍可按需读取。',ready?'success':'warning'));
			content.push(E('div',{'class':'ed-card'},[ed.section('后台服务','即时启动状态与开机自启分别控制。',ed.badge('运行中 '+services.filter(function(c){return c.running;}).length+' / '+services.length,'blue')),
				ed.table(['服务','运行状态','开机自启','服务控制'],serviceRows,'ed-environment-table'),
				E('div',{'class':'ed-card-foot'},[ed.icon('info'),E('span',['停止或重启 D-Bus 会先停止 Avahi；重启 D-Bus 后需手动启动 Avahi。'])])]));
		}
		content.push(E('div',{'class':'ed-under-note'},[ed.icon('info'),E('span',['设备基础发现按需读取 DHCP 与邻居信息，无需常驻扫描进程。Avahi 用于 mDNS / ADB 发现，ARP 为可选增强。'])]));
		return E('div',content);
	}
});
