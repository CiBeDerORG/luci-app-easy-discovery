'use strict';
'require baseclass';
'require ui';
'require easy-discovery.toast as toast';

var paths = {
	network: ['M8 3h8v5H8zM12 8v5M5 17v-4h14v4M2 17h6v4H2zM9 17h6v4H9zM16 17h6v4h-6zM12 13v4'],
	discover: ['M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m13-5v4a1 1 0 0 1-1 1h-4', 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0m-1 3 3 3'],
	terminal: ['M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m2 5 4 4-4 4m7 0h5'],
	box: ['m12 2 9 5v10l-9 5-9-5V7zm-9 5 9 5 9-5m-9 5v10M7.5 4.5l9 5'],
	shield: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zm-3.5 9 2.2 2.2 4.8-4.8'],
	search: ['M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0m-1 5.5 5 5'],
	refresh: ['M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5'],
	clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2'],
	info: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7h.01'],
	check: ['m5 12 4 4L19 6'],
	copy: ['M10 8h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2m6 0V3H3v13h5'],
	close: ['m6 6 12 12M6 18 18 6'],
	chevron: ['m9 5 7 7-7 7'],
	power: ['M12 2v10M7 5a9 9 0 1 0 10 0'],
	key: ['M13 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0m-1 4 9 9m-5-5 3-3m-1 5 3-3'],
	code: ['m7 7-5 5 5 5m10-10 5 5-5 5m-3-14-4 18'],
	download: ['M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'],
	activity: ['M2 12h5l3-8 4 16 3-8h5'],
	phone: ['M9 2h6a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3m1 3h4m-3 14h2'],
	link: ['m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0']
};

function icon(name, extra) {
	var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('class', 'ed-icon' + (extra ? ' ' + extra : ''));
	svg.setAttribute('aria-hidden', 'true');
	(paths[name] || paths.info).forEach(function(d) {
		var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('d', d); svg.appendChild(path);
	});
	return svg;
}

function text(value, fallback) { return value == null || value === '' ? (fallback || '—') : String(value); }
function button(label, click, options) {
	options = options || {};
	return E('button', {
		type: 'button', 'class': 'ed-button ' + (options.kind || ''),
		disabled: options.disabled ? '' : null,
		title: options.title || null, 'aria-label': options.ariaLabel || null,
		click: function(e) { e.preventDefault(); if (!this.disabled) return click(e); }
	}, [options.icon ? icon(options.icon, options.spin ? 'ed-spin' : '') : '', label]);
}
function badge(label, kind) { return E('span', {'class': 'ed-badge ' + (kind || '')}, [E('i', {'class': 'ed-dot'}), text(label)]); }
function note(message, kind, action) {
	return E('div', {'class': 'ed-notice ' + (kind || ''), role: kind === 'error' ? 'alert' : 'status'},
		[icon(kind === 'success' ? 'check' : 'info'), E('div', {'class': 'ed-notice-text'}, Array.isArray(message) ? message : [text(message)]), action || '']);
}
function date(value) {
	var timestamp = Number(value);
	if (!isFinite(timestamp) || timestamp <= 0) return '—';
	var d = new Date(timestamp * 1000);
	return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function stat(label, value, unit, caption, symbol, kind) {
	return E('div', {'class': 'ed-stat'}, [
		E('div', {'class': 'ed-stat-label'}, [label]),
		E('div', {'class': 'ed-stat-value'}, [String(value), E('span', [unit || ''])]),
		E('div', {'class': 'ed-stat-caption'}, [caption || '']),
		E('div', {'class': 'ed-stat-icon ' + (kind || '')}, [icon(symbol || 'network')])
	]);
}
function empty(title, description, action) {
	return E('div', {'class': 'ed-empty'}, [E('div', {'class': 'ed-empty-icon'}, [icon('discover')]),
		E('h3', [title]), E('p', [description]), action || '']);
}
function table(headers, rows, className) {
	return E('div', {'class': 'ed-table-scroll'}, [E('table', {'class': 'ed-table ' + (className || '')}, [
		E('thead', [E('tr', headers.map(function(h) { return E('th', {scope: 'col'}, [h]); }))]),
		E('tbody', rows)
	])]);
}
function modal(title, body, actions) {
	ui.showModal(title, [E('div', {'class': 'ed-root ed-modal-body'}, body),
		E('div', {'class': 'ed-root ed-modal-actions'}, actions || [button('关闭', ui.hideModal)])]);
}
function notify(message, error) { return toast.show(text(message), error); }
function copy(value) {
	value = String(value);
	var result;
	if (navigator.clipboard && window.isSecureContext)
		result = navigator.clipboard.writeText(value);
	else result = new Promise(function(resolve, reject) {
		var field = E('textarea', {'class': 'ed-copy-buffer', 'aria-label': '复制内容'}, [value]);
		(document.querySelector('dialog[open]') || document.body).appendChild(field); field.select();
		var ok = document.execCommand('copy'); field.remove();
		if (ok) resolve(); else reject(new Error('copy unavailable'));
	});
	return result.then(function() { notify('已复制到剪贴板'); }, function() {
		var openDialog = document.querySelector('dialog[open]');
		var content = [E('p', ['浏览器未允许自动复制，可选中下方内容手动复制。']),
			E('textarea', {'class': 'ed-copy-field', readonly: '', 'aria-label': '待复制内容'}, [value])];
		if (openDialog) {
			var previous = openDialog.querySelector('.ed-copy-fallback');
			if (previous) previous.remove();
			var fallback = E('div', {'class': 'ed-copy-fallback'}, content);
			openDialog.appendChild(fallback); fallback.querySelector('textarea').select();
		} else modal('复制内容', content);
	});
}
function confirm(title, body, label, operation, danger) {
	var confirmed = false;
	modal(title, body, [button('取消', ui.hideModal), button(label || '确认', function() {
		if (confirmed) return; confirmed = true; ui.hideModal(); return operation();
	}, {kind: danger ? 'danger' : 'primary'})]);
}

return baseclass.extend({
	icon: icon, text: text, button: button, badge: badge, note: note, date: date,
	stat: stat, empty: empty, table: table, modal: modal, notify: notify, copy: copy, confirm: confirm,
	hideModal: function() { ui.hideModal(); },
	cell: function(value, className) { return E('td', {'class': className || ''}, Array.isArray(value) ? value : [text(value)]); },
	section: function(title, description, tools) {
		return E('div', {'class': 'ed-card-head'}, [E('div', [E('h3', {'class': 'ed-card-title'}, [title]),
			description ? E('p', {'class': 'ed-description'}, [description]) : '']), tools || '']);
	},
	search: function(placeholder, value, onInput) {
		return E('label', {'class': 'ed-search'}, [icon('search'), E('input', {
			type: 'search', value: value || '', placeholder: placeholder, 'aria-label': placeholder,
			input: function() { onInput(this.value); }
		})]);
	},
	select: function(label, options, value, onChange) {
		var select = E('select', {'class': 'ed-select', 'aria-label': label, change: function() { onChange(this.value); }},
			options.map(function(option) { return E('option', {value: option[0]}, [option[1]]); }));
		select.value = value;
		return select;
	},
	endpoint: function(endpoint) {
		var address = String(endpoint.address || '');
		return (address.indexOf(':') >= 0 ? '[' + address + (address.toLowerCase().indexOf('fe80:') === 0 && address.indexOf('%') < 0 && endpoint.iface ? '%' + endpoint.iface : '') + ']' : address) + ':' + endpoint.port;
	},
	permissionNames: [
		{id: 'deviceList', value: 1, name: '读取设备列表', object: 'easy-discovery.devices', method: 'list', description: '读取最近一次设备发现快照'},
		{id: 'deviceScan', value: 2, name: '发起设备发现', object: 'easy-discovery.devices', method: 'scan', description: '主动采集设备信息'},
		{id: 'adbList', value: 4, name: '读取 ADB 列表', object: 'easy-discovery.adb', method: 'list', description: '读取最近一次 ADB 端点快照'},
		{id: 'adbScan', value: 8, name: '发起 ADB 发现', object: 'easy-discovery.adb', method: 'scan', description: '执行一次有时间边界的 ADB 发现'}
	],
	apiEndpoint: function() {
		var path = L.env && typeof L.env.ubuspath === 'string' ? L.env.ubuspath : '/ubus';
		try { return new URL(path, window.location.origin).href.replace(/\/$/, ''); }
		catch (e) { return window.location.origin + '/ubus'; }
	},
	apiExample: function(id) {
		var p = this.permissionNames.filter(function(item) { return item.id === id; })[0] || this.permissionNames[0];
		var code = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'call', params: ['<RPCD_SESSION>', p.object, p.method, {}]}, null, 2);
		modal(p.name + ' · 调用示例', [
			E('p', ['接口地址：', E('code', [this.apiEndpoint()])]),
			E('p', ['先使用专用账号调用 session.login 获取 ubus_rpc_session，再调用已获授权的方法。']),
			E('pre', {'class': 'ed-code'}, [code]),
			E('p', {'class': 'ed-description'}, [p.method === 'list' ? 'list 仅读取快照，不会触发扫描。' : 'scan 显式发起一次发现，服务端限制执行时间与返回数量。'])
		], [button('复制示例', function() { return copy(code); }, {icon: 'copy'}), button('关闭', ui.hideModal, {kind: 'primary'})]);
	}
});
