'use strict';
'require baseclass';
'require rpc';
'require fs';

var CONTROL = '/usr/libexec/luci-easy-discovery';
var AUTH = '/usr/libexec/luci-easy-discovery-auth';

function discoveryCall(object, method) {
	return rpc.declare({ object: object, method: method, params: [], reject: true, nobatch: true });
}
var calls = {
	devices: { list: discoveryCall('easy-discovery.devices', 'list'), scan: discoveryCall('easy-discovery.devices', 'scan') },
	adb: { list: discoveryCall('easy-discovery.adb', 'list'), scan: discoveryCall('easy-discovery.adb', 'scan') }
};

function command(path, args) {
	return fs.exec(path, args).then(function(result) {
		var data;
		try { data = JSON.parse(result.stdout || ''); }
		catch (e) { throw new Error((result.stderr || '后端没有返回有效的 JSON 结果').trim().slice(0, 2000)); }
		if (!data || typeof data !== 'object' || Array.isArray(data))
			throw new Error('后端响应格式无效');
		if (data.status !== 'ok' || result.code !== 0) {
			var error = new Error(data.message || (data.error && data.error.message) || '操作失败');
			error.code = data.error && data.error.code;
			throw error;
		}
		return data;
	});
}

return baseclass.extend({
	discover: function(kind, method) {
		if (!calls[kind] || !calls[kind][method]) return Promise.reject(new Error('不支持的发现操作'));
		return calls[kind][method]().then(function(data) {
			if (!data || ['ok', 'partial', 'error'].indexOf(data.status) < 0 || !Array.isArray(data.devices))
				throw new Error('发现接口返回格式无效，请确认插件安装完整');
			return data;
		});
	},
	environment: function() { return command(CONTROL, ['status']); },
	service: function(component, action) { return command(CONTROL, ['service', component, action]); },
	packagePlan: function(action, component) { return command(CONTROL, ['package', 'plan', action, component]); },
	packageApply: function(action, component) { return command(CONTROL, ['package', 'apply', action, component]); },
	packageJob: function(id) { return command(CONTROL, ['package', 'job', id]); },
	arp: function(enabled) { return command(CONTROL, ['discovery', 'arp', enabled ? '1' : '0']); },
	authorization: function(action, mask) {
		var args = [action];
		if (action === 'create' || action === 'permissions') args.push(String(mask));
		return command(AUTH, args);
	},
	settle: function(promise) {
		return promise.then(function(value) { return { value: value, error: null }; },
			function(error) { return { value: null, error: error.message || String(error) }; });
	}
});
