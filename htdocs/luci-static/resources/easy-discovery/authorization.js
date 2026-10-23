'use strict';
'require baseclass';
'require easy-discovery.common as ed';

function chips(authorization) {
	var granted = ed.permissionNames.filter(function(p) { return authorization.permissions && authorization.permissions[p.id]; });
	var result = granted.map(function(p) { return E('span', {'class':'ed-permission-chip'}, [ed.icon('check'), p.name]); });
	if (authorization.legacy_adb_scan) result.push(E('span', {'class':'ed-permission-chip legacy'}, [ed.icon('link'), '旧 EasyADB 扫描入口']));
	return result.length ? result : [E('span', {'class':'ed-muted'}, ['暂无授权能力'])];
}

return baseclass.extend({
	render: function(ctx) {
		var state=ctx.state, authorization=state.authorization, locked=!state.canWrite||state.busy.auth||state.busy.environment||state.busy.devices||state.busy.adb||!!(state.packageJob&&state.packageJob.state==='running');
		var managed=authorization&&authorization.state==='managed', conflict=authorization&&authorization.state==='conflict';
		var suspended=!!(authorization&&(authorization.suspended||authorization.recovery_required));
		var secure=window.location.protocol==='https:', content=[];
		if(state.errors.auth)content.push(ed.note(state.errors.auth,'error'));
		content.push(E('div',{'class':'ed-section-top'},[E('div',[E('h2',['接口授权']),E('p',['为 EasyADB 或其他客户端配置发现能力的访问权限。'])]),ed.badge('RPCD 会话认证','blue')]));
		if(!secure)content.push(ed.note('当前连接使用 HTTP，未启用传输加密。请通过 HTTPS 地址管理和调用接口，以保护账号、密钥与会话。','warning'));
		if(conflict)content.push(ed.note('检测到同名账号或非本应用管理的权限配置。为避免覆盖现有账号，已禁止修改，请由管理员检查 RPCD 配置。','error'));
		if(suspended)content.push(ed.note('专用账号已暂停。请排除授权操作报告的错误，再重新生成密钥或撤销授权；恢复前客户端无法使用发现接口。','error'));
		if(authorization&&authorization.legacy_only)content.push(ed.note('已识别旧 EasyADB 授权，保留原账号与密码。旧账号仅可使用原扫描入口；如需读取新列表或调用新发现接口，请明确编辑权限。','warning'));
		if(!authorization){
			content.push(E('div',{'class':'ed-card'},[ed.empty('授权状态暂不可用','读取成功后才能管理专用账号。',ed.button('刷新授权状态',ctx.actions.refreshAuth,{icon:'refresh',disabled:state.busy.auth}))]));
			return E('div',content);
		}
		var buttons=[];
		if(managed){
			buttons.push(ed.button('编辑权限',function(){ctx.actions.permissions(false);},{kind:'small',icon:'shield',disabled:locked||suspended}));
			buttons.push(ed.button('重新生成密钥',ctx.actions.rotate,{kind:'small',icon:'key',disabled:locked}));
			buttons.push(ed.button('撤销授权',ctx.actions.revoke,{kind:'text danger',disabled:locked}));
		}else buttons.push(ed.button('创建客户端授权',function(){ctx.actions.permissions(true);},{kind:'primary',icon:'key',disabled:locked||conflict}));
		var connection=E('div',{'class':'ed-copy-value'},[E('code',[ed.apiEndpoint()]),ed.button('',function(){return ed.copy(ed.apiEndpoint());},{kind:'text icon-only',icon:'copy',ariaLabel:'复制接口地址'})]);
		var authCard=E('div',{'class':'ed-card'},[ed.section('客户端授权',null,ed.badge(suspended?'账号已暂停':managed?'已授权':conflict?'配置冲突':'未授权',suspended?'error':managed?'success':conflict?'error':'')),
			E('div',{'class':'ed-auth-body'},[E('dl',{'class':'ed-auth-grid'},[
				E('dt',['接口地址']),E('dd',[secure?'HTTPS · JSON-RPC':'HTTP · JSON-RPC',connection]),
				E('dt',['专用账号']),E('dd',[E('code',[managed?ed.text(authorization.username,'easyadb'):'—'])]),
				E('dt',['访问凭据']),E('dd',managed?[E('span',{'class':'ed-mono'},['••••••••••••••••']),E('div',{'class':'ed-sub'},['只在创建或重新生成时展示一次。'])]:['创建授权后生成专用密钥。']),
				E('dt',['授权能力']),E('dd',[E('div',{'class':'ed-chips'},managed?chips(authorization):[E('span',{'class':'ed-muted'},['暂无授权能力'])])])
			]),E('div',{'class':'ed-auth-actions'},buttons)])]);
		var guide=E('aside',{'class':'ed-card ed-guide'},[E('h3',[ed.icon('link'),'如何接入']),
			E('div',{'class':'ed-guide-steps'},[
				E('div',{'class':'ed-guide-step'},[E('span',['1']),E('div',[E('strong',['创建专用授权']),E('p',['选择需要的发现能力，保存一次性显示的密钥。'])])]),
				E('div',{'class':'ed-guide-step'},[E('span',['2']),E('div',[E('strong',['填写连接信息']),E('p',['在客户端中填写接口地址、账号与密钥。'])])]),
				E('div',{'class':'ed-guide-step'},[E('span',['3']),E('div',[E('strong',['登录后调用接口']),E('p',['取得 RPCD 会话后读取列表，或按需发起发现。'])])])
			]),E('div',{'class':'ed-guide-foot'},[ed.icon('shield'), '访问范围由 ACL 限定。外部账号不授予安装软件、控制服务或管理密钥的权限。'])]);
		content.push(E('div',{'class':'ed-auth-layout'},[authCard,guide]));
		var rows=ed.permissionNames.map(function(p){return E('tr',[
			ed.cell([E('strong',[p.name]),E('div',{'class':'ed-sub ed-mono'},[p.object+' · '+p.method])]),
			ed.cell(p.description),ed.cell([ed.badge(suspended?'账号已暂停':managed&&authorization.permissions&&authorization.permissions[p.id]?'已授权':'未授权',suspended?'warning':managed&&authorization.permissions&&authorization.permissions[p.id]?'success':'')]),
			ed.cell([ed.button('查看',function(){ed.apiExample(p.id);},{kind:'text',icon:'code'})])
		]);});
		content.push(E('div',{'class':'ed-card'},[ed.section('对外发现接口','设备与 ADB 分别提供列表读取和主动发现。',ed.button('调用示例',function(){ed.apiExample();},{kind:'text',icon:'chevron'})),
			ed.table(['接口能力','功能说明','授权状态','示例'],rows,'ed-api-table')]));
		content.push(E('div',{'class':'ed-under-note'},[ed.icon('info'),E('span',['账号使用随机密钥与密码哈希，RPCD 会话负责认证，HTTPS 负责传输加密。'])]));
		return E('div',content);
	},
	permissions: function(ctx, create) {
		var authorization=ctx.state.authorization, fields=[];
		var rows=ed.permissionNames.map(function(p){
			var checked=create?(p.method==='list'):!!(authorization&&authorization.permissions&&authorization.permissions[p.id]);
			var input=E('input',{type:'checkbox',checked:checked?'':null,value:String(p.value)});
			fields.push(input);
			return E('label',{'class':'ed-check-row'},[input,E('span',[E('strong',[p.name]),E('small',[p.description])])]);
		});
		var submitting=false;
		ed.modal(create?'创建客户端授权':'编辑访问权限',[
			E('p',['选择客户端可以使用的能力。读取列表不会主动扫描；需要主动更新的客户端，请勾选相应发现权限。']),
			E('div',rows), E('p',{'class':'ed-description'},['“发起 ADB 发现”同时控制旧 EasyADB 固定扫描入口。保存后将清理专用账号的旧会话，客户端需要重新登录。'])
		],[ed.button('取消',ed.hideModal),ed.button(create?'生成访问凭据':'保存权限',function(){
			if(submitting)return;
			var mask=fields.reduce(function(value,field){return value+(field.checked?Number(field.value):0);},0);
			if(!mask){ed.notify('请至少选择一项能力；如需完全停用，请撤销授权。',true);return;}
			submitting=true; ed.hideModal(); return ctx.actions.savePermissions(create,mask);
		},{kind:'primary',disabled:!ctx.state.canWrite||ctx.state.busy.auth})]);
	},
	secret: function(result) {
		if(!result.password)return;
		var secret=String(result.password), credential=E('code',{'class':'ed-secret','aria-label':'一次性访问密钥'},[secret]);
		var priorFocus=document.activeElement,dialog;
		var clear=function(){credential.textContent='';secret='';dialog.remove();if(priorFocus&&priorFocus.isConnected)priorFocus.focus();};
		var close=function(){dialog.close();};
		dialog=E('dialog',{'class':'ed-root ed-key-dialog','aria-labelledby':'ed-key-title'},[
			E('div',{'class':'ed-drawer-head'},[E('h2',{id:'ed-key-title'},['保存客户端密钥']),ed.button('',close,{kind:'text icon-only',icon:'close',ariaLabel:'关闭密钥弹窗'})]),
			E('div',{'class':'ed-key-body'},[ed.note('请立即保存。关闭后无法再次查看此密钥。','warning'),
				E('p',['专用账号：',E('code',[ed.text(result.username,'easyadb')])]),credential,
				E('p',{'class':'ed-description'},['将账号与密钥填入客户端配置；需要更换时可重新生成。'])]),
			E('div',{'class':'ed-drawer-foot'},[ed.button('复制密钥',function(){return ed.copy(secret);},{icon:'copy'}),ed.button('已保存，关闭',close,{kind:'primary'})])
		]);
		dialog.addEventListener('close',clear,{once:true});
		dialog.addEventListener('cancel',function(){credential.textContent='';secret='';});
		window.addEventListener('pagehide',clear,{once:true});
		document.body.appendChild(dialog);dialog.showModal();
		delete result.password;
	}
});
