'use strict';
'require view';
'require easy-discovery.api as api';
'require easy-discovery.common as ed';
'require easy-discovery.discovery as discovery';
'require easy-discovery.environment as environment';
'require easy-discovery.authorization as authorization';

var componentNames = {avahi:'Avahi',dbus:'D-Bus',arp:'ARP 扫描增强'};
var operationNames = {start:'启动',stop:'停止',restart:'重启',enable:'开启自启',disable:'关闭自启',install:'安装',upgrade:'更新',remove:'卸载'};
var pages = [
	{id:'devices',label:'设备发现',icon:'network'},
	{id:'adb',label:'ADB 发现',icon:'terminal'},
	{id:'environment',label:'运行环境',icon:'box'},
	{id:'auth',label:'接口授权',icon:'shield'}
];

function errorMessage(error) { return error && error.message ? error.message : String(error || '操作失败'); }
function snapshotError(data) {
	if(data.message)return String(data.message);
	if(data.error&&data.error.message)return String(data.error.message);
	if(Array.isArray(data.errors)&&data.errors.length)return data.errors.map(function(item){return ed.text(item.message||item.code);}).join('；');
	return '本次发现失败，保留上次成功结果。';
}

return view.extend({
	load: function() {
		return Promise.all([
			api.settle(api.discover('devices','list')),
			api.settle(api.discover('adb','list')),
			api.settle(api.environment()),
			api.settle(api.authorization('status'))
		]);
	},
	render: function(data) {
		if(!document.getElementById('easy-discovery-style'))document.head.appendChild(E('link',{id:'easy-discovery-style',rel:'stylesheet',href:L.resource('easy-discovery/style.css')}));
		var state={
			page:'devices',environmentTab:'packages',canWrite:typeof L.hasViewPermission==='function'&&L.hasViewPermission()===true,
			snapshots:{devices:data[0].value,adb:data[1].value},environment:data[2].value,authorization:data[3].value,
			errors:{devices:data[0].error,adb:data[1].error,environment:data[2].error,auth:data[3].error},
			busy:{devices:false,adb:false,environment:false,auth:false},loading:{devices:false,adb:false},
			deviceFilter:{query:'',network:'all',observation:'all',page:1},adbFilter:{query:'',protocol:'all',page:1},
			packageJob:data[2].value&&data[2].value.job||null,packageWatching:false,packageWatchError:null
		};
		['devices','adb'].forEach(function(kind){if(state.snapshots[kind]&&state.snapshots[kind].status==='error')state.errors[kind]=snapshotError(state.snapshots[kind]);});
		var root=E('section',{'class':'ed-root ed-app'}),header=E('div',{'class':'ed-heading'}),tabs=E('nav',{'class':'ed-tabs',role:'tablist','aria-label':'发现功能'}),
			content=E('section',{id:'ed-panel',role:'tabpanel',tabindex:'0'}),permissionNote=E('div');
		var packageTimer=null,watchGeneration=0,disposed=false;
		var ctx={state:state,actions:{}};
		function mounted(){return !disposed&&root.isConnected;}
		function readOnly(){if(!state.canWrite){ed.notify('当前账号只有只读权限。',true);return true;}return false;}
		function writeBusy(){return state.busy.devices||state.busy.adb||state.busy.environment||state.busy.auth||!!(state.packageJob&&state.packageJob.state==='running');}
		function environmentComponents(){return state.environment&&Array.isArray(state.environment.components)?state.environment.components:[];}
		function adbReady(){var components=environmentComponents();return ['avahi','dbus'].every(function(id){return components.some(function(c){return c.id===id&&c.installed==='installed'&&c.running;});});}
		function setPage(page){state.page=page;draw();}
		function applySnapshot(kind,result){
			if(result.status==='error'){
				var authBlocked=Array.isArray(result.errors)&&result.errors.some(function(error){return error.code==='auth_suspended'||error.code==='auth_unavailable';});
				// The authorization barrier intentionally returns an empty result.
				// Replace the browser copy too, instead of keeping stale rows visible.
				if(result.has_snapshot||authBlocked)state.snapshots[kind]=result;
				state.errors[kind]=snapshotError(result);return false;
			}
			state.snapshots[kind]=result;state.errors[kind]=null;return true;
		}
		function refreshList(kind){
			if(state.loading[kind]||state.busy[kind])return Promise.resolve();
			state.loading[kind]=true;draw();
			return api.discover(kind,'list').then(function(result){applySnapshot(kind,result);},function(error){state.errors[kind]='读取列表失败：'+errorMessage(error);})
				.then(function(){state.loading[kind]=false;if(mounted())draw();});
		}
		function scan(kind){
			if(readOnly()||writeBusy()||state.loading[kind])return Promise.resolve();
			if(kind==='adb'&&!adbReady()){ed.notify('请先确认 Avahi 与 D-Bus 已安装并运行。',true);return Promise.resolve();}
			state.busy[kind]=true;state.errors[kind]=null;draw();
			return api.discover(kind,'scan').then(function(result){
				if(applySnapshot(kind,result))ed.notify(result.status==='partial'?'发现已完成，部分来源不可用，请查看来源状态。':'发现已完成，共 '+result.devices.length+(kind==='adb'?' 个端点。':' 条设备记录。'),result.status==='partial');
			},function(error){state.errors[kind]='本次发现失败：'+errorMessage(error)+'。上次结果仍保留。';})
				.then(function(){state.busy[kind]=false;if(mounted())draw();});
		}
		function readEnvironment(preserveError){
			return api.environment().then(function(result){state.environment=result;if(!preserveError)state.errors.environment=null;
				var previousId=state.packageJob&&state.packageJob.id;
				if(state.packageWatching&&(!result.job||result.job.id!==previousId||result.job.state!=='running'))stopWatching();
				state.packageJob=result.job||null;
				if(!result.job||result.job.id!==previousId||result.job.state!=='running')state.packageWatchError=null;
				return result;
			},function(error){state.errors.environment='组件状态回读失败：'+errorMessage(error);throw error;});
		}
		function refreshEnvironment(){
			if(state.busy.environment)return Promise.resolve();
			state.busy.environment=true;draw();
			return readEnvironment().catch(function(){}) .then(function(){state.busy.environment=false;if(mounted())draw();});
		}
		function environmentAction(operation){
			if(readOnly()||writeBusy())return Promise.resolve();
			state.busy.environment=true;state.errors.environment=null;draw();
			return operation().then(function(result){ed.notify(result.message||'操作完成');},function(error){state.errors.environment=errorMessage(error);ed.notify(state.errors.environment,true);})
				.then(function(){return readEnvironment(true).catch(function(){});})
				.then(function(){state.busy.environment=false;if(mounted())draw();});
		}
		function service(component,action){
			if(readOnly()||writeBusy())return;
			var perform=function(){return environmentAction(function(){return api.service(component,action);});};
			if(action==='stop'||action==='disable'||(component==='dbus'&&action==='restart')){
				var warning;
				if(action==='disable')warning=component==='dbus'?'请先关闭 Avahi 的开机自启，再关闭 D-Bus 的开机自启。当前服务运行状态保持不变。':'关闭后，Avahi 将不会在下次开机时自动启动。当前服务运行状态保持不变。';
				else if(component==='dbus')warning='此操作会先停止正在运行的 Avahi。'+(action==='restart'?'D-Bus 重启后需手动启动 Avahi，才能继续发起 ADB 发现。':'需要恢复 ADB 发现时，请在服务管理中重新启动 Avahi。')+'其他依赖 D-Bus 的系统功能也可能受影响。';
				else warning='停止服务后暂时无法发起新的 ADB 发现，已有快照仍可读取。';
				ed.confirm(operationNames[action]+' '+componentNames[component]+'？',[E('p',[warning])],operationNames[action],perform,action==='stop');
			}else return perform();
		}
		function stopWatching(){clearTimeout(packageTimer);packageTimer=null;state.packageWatching=false;watchGeneration++;}
		function watchJob(){
			if(state.packageWatching||!state.packageJob||state.packageJob.state!=='running')return;
			state.packageWatching=true;state.packageWatchError=null;var id=state.packageJob.id,generation=++watchGeneration,deadline=Date.now()+300000;
			if(mounted())draw();
			function poll(){
				if(generation!==watchGeneration)return;
				if(!mounted()){stopWatching();return;}
				if(Date.now()>deadline){stopWatching();state.packageWatchError='本次进度查看已超过 5 分钟。后台任务可能仍在运行，可点击“继续查看进度”重新读取。';draw();return;}
				api.packageJob(id).then(function(result){
					if(generation!==watchGeneration||!mounted())return;
					if(!result.job||result.job.id!==id||['running','succeeded','failed'].indexOf(result.job.state)<0)throw new Error('任务状态响应无效');
					state.packageJob=result.job;
					if(result.job.state==='running'){if(state.page==='environment')draw();packageTimer=setTimeout(poll,2000);return;}
					stopWatching();ed.notify(result.job.message||(result.job.state==='succeeded'?'软件包操作已完成':'软件包操作失败'),result.job.state!=='succeeded');
					readEnvironment().catch(function(){}).then(function(){if(mounted())draw();});
				},function(error){
					if(generation!==watchGeneration)return;
					stopWatching();state.packageWatchError='无法继续读取任务状态：'+errorMessage(error)+'。请刷新组件状态或再次查看进度。';if(mounted())draw();
				}).catch(function(error){if(generation!==watchGeneration)return;stopWatching();state.packageWatchError=errorMessage(error);if(mounted())draw();});
			}
			poll();
		}
		function applyPackage(action,component){
			if(readOnly()||writeBusy())return Promise.resolve();
			var appliedJobId=null;
			state.busy.environment=true;state.errors.environment=null;draw();
			return api.packageApply(action,component).then(function(result){
				if(!result.job||!result.job.id||['running','succeeded','failed'].indexOf(result.job.state)<0)throw new Error('软件包任务未返回有效状态，请刷新组件状态');
				state.packageJob=result.job;state.packageWatchError=null;appliedJobId=result.job.id;
				if(result.job.state!=='running'){
					var failed=result.job.state!=='succeeded',message=result.job.message||(failed?'软件包操作失败':'软件包操作已完成');
					if(failed)state.errors.environment=message;
					ed.notify(message,failed);
					return readEnvironment(true).catch(function(){});
				}
			}).catch(function(error){state.errors.environment=errorMessage(error);ed.notify(state.errors.environment,true);})
				.then(function(){state.busy.environment=false;if(mounted()){draw();if(appliedJobId&&state.packageJob&&state.packageJob.id===appliedJobId&&state.packageJob.state==='running')watchJob();}});
		}
		function packageAction(action,component){
			if(readOnly()||writeBusy())return Promise.resolve();
			state.busy.environment=true;draw();
			return api.packagePlan(action,component).then(function(plan){
				state.busy.environment=false;if(!mounted())return;draw();
				ed.confirm('确认'+operationNames[action]+' '+componentNames[component], [E('p',[plan.message||'请确认软件包管理器给出的操作计划。']),
					E('pre',{'class':'ed-code'},[plan.output||'计划已生成。']), E('p',{'class':'ed-description'},['确认后提交后台任务，可在此页查看进度与结果。'])],
					'确认'+operationNames[action],function(){return applyPackage(action,component);},action==='remove');
			},function(error){state.busy.environment=false;state.errors.environment='无法生成操作计划：'+errorMessage(error);if(mounted())draw();});
		}
		function readAuthorization(preserveError){
			return api.authorization('status').then(function(result){state.authorization=result;if(!preserveError)state.errors.auth=null;},function(error){state.errors.auth='授权状态读取失败：'+errorMessage(error);throw error;});
		}
		function refreshAuth(){
			if(state.busy.auth)return Promise.resolve();state.busy.auth=true;draw();
			return readAuthorization().catch(function(){}).then(function(){state.busy.auth=false;if(mounted())draw();});
		}
		function authAction(action,mask){
			if(readOnly()||writeBusy())return Promise.resolve();state.busy.auth=true;state.errors.auth=null;draw();
			return api.authorization(action,mask).then(function(result){
				if(result.password)authorization.secret(result);
				ed.notify(result.message||'授权操作已完成');
			},function(error){state.errors.auth=errorMessage(error);ed.notify(state.errors.auth,true);})
				.then(function(){return readAuthorization(true).catch(function(){});})
				.then(function(){state.busy.auth=false;if(mounted())draw();});
		}
		ctx.actions={
			page:setPage,adbReady:adbReady,detail:function(device){discovery.detail(device,ctx);},
			services:function(){state.environmentTab='services';setPage('environment');},
			environmentTab:function(tab){state.environmentTab=tab;draw();},refreshEnvironment:refreshEnvironment,
			service:service,packageAction:packageAction,watchJob:watchJob,
			arp:function(enabled){return environmentAction(function(){return api.arp(enabled);});},
			refreshAuth:refreshAuth,permissions:function(create){if(!readOnly()&&!writeBusy()&&!(state.authorization&&(state.authorization.suspended||state.authorization.recovery_required)))authorization.permissions(ctx,create);},
			savePermissions:function(create,mask){return authAction(create?'create':'permissions',mask);},
			rotate:function(){if(!readOnly()&&!writeBusy())ed.confirm('重新生成客户端密钥？',[E('p',['当前密钥将被替换，专用账号已有会话将失效。请同步更新客户端凭据。'])],'重新生成',function(){return authAction('rotate');});},
			revoke:function(){if(!readOnly()&&!writeBusy())ed.confirm('撤销客户端授权？',[E('p',['撤销后会清理专用账号已有会话，客户端需要重新授权。管理员会话不受影响。'])],'撤销授权',function(){return authAction('revoke');},true);}
		};
		function draw(){
			var buttons=[];
			if(state.page==='devices'||state.page==='adb'){
				var kind=state.page;
				buttons.push(ed.button('刷新列表',function(){return refreshList(kind);},{icon:'refresh',disabled:state.loading[kind]||state.busy[kind]}));
				buttons.push(ed.button(state.busy[kind]?'正在发现…':kind==='adb'?'立即发现 ADB':'立即发现设备',function(){return scan(kind);},{kind:'primary',icon:state.busy[kind]?'refresh':'discover',spin:state.busy[kind],disabled:!state.canWrite||writeBusy()||state.loading[kind]||(kind==='adb'&&!adbReady())}));
			}else if(state.page==='environment')buttons.push(ed.button('刷新组件状态',refreshEnvironment,{icon:'refresh',disabled:state.busy.environment}));
			else{buttons.push(ed.button('刷新授权状态',refreshAuth,{icon:'refresh',disabled:state.busy.auth}));buttons.push(ed.button('查看接口示例',function(){ed.apiExample();},{icon:'code'}));}
			header.replaceChildren(E('div',[E('div',{'class':'ed-eyebrow'},['YOUR NETWORK, DISCOVERED.']),E('h1',['Easy Discovery']),E('p',['汇集局域网设备与无线 ADB 端点，让设备信息一目了然。'])]),E('div',{'class':'ed-heading-actions'},buttons));
			permissionNote.replaceChildren.apply(permissionNote,state.canWrite?[]:[ed.note('当前账号为只读权限，可以读取发现快照与状态；主动发现、服务管理与授权修改需要写权限。','warning')]);
			var tabButtons=pages.map(function(page){
				var selected=state.page===page.id,label=[ed.icon(page.icon),page.label];
				if(page.id==='devices'||page.id==='adb')label.push(E('span',{'class':'ed-count'},[state.snapshots[page.id]&&state.snapshots[page.id].has_snapshot?String(discovery.records(state.snapshots[page.id]).length):'—']));
				var button=E('button',{type:'button','class':'ed-tab',id:'ed-tab-'+page.id,role:'tab','aria-controls':'ed-panel','aria-selected':String(selected),tabindex:selected?'0':'-1',click:function(){setPage(page.id);document.getElementById('ed-tab-'+page.id).focus();}},label);
				button.addEventListener('keydown',function(event){
					if(['ArrowLeft','ArrowRight','Home','End'].indexOf(event.key)<0)return;event.preventDefault();var index=pages.indexOf(page);
					index=event.key==='Home'?0:event.key==='End'?pages.length-1:(index+(event.key==='ArrowRight'?1:-1)+pages.length)%pages.length;
					setPage(pages[index].id);document.getElementById('ed-tab-'+pages[index].id).focus();
				});return button;
			});
			tabs.replaceChildren.apply(tabs,tabButtons);content.setAttribute('aria-labelledby','ed-tab-'+state.page);
			content.replaceChildren(state.page==='devices'?discovery.devices(ctx):state.page==='adb'?discovery.adb(ctx):state.page==='environment'?environment.render(ctx):authorization.render(ctx));
		}
		root.append(header,tabs,permissionNote,content,E('footer',{'class':'ed-footer'},[E('span',['Easy Discovery · 局域网设备发现']),E('span',['快照保存在内存中，重启后清空'])]));
		window.addEventListener('pagehide',function(){disposed=true;stopWatching();},{once:true});
		draw();return root;
	},
	handleSaveApply:null,
	handleSave:null,
	handleReset:null
});
