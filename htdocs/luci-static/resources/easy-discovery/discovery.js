'use strict';
'require baseclass';
'require easy-discovery.common as ed';

var PAGE_SIZE = 15;
var observationNames = { recent: '本次观测', lease: '租约记录', cached: '历史记录' };

function records(snapshot) { return snapshot && Array.isArray(snapshot.devices) ? snapshot.devices : []; }
function addresses(device) {
	return (Array.isArray(device.ipv4) ? device.ipv4 : []).concat(Array.isArray(device.ipv6) ? device.ipv6 : [])
		.filter(function(value) { return typeof value === 'string'; });
}
function normalizeAddress(value) {
	value = String(value || '').toLowerCase().split('%')[0];
	if (value.indexOf(':') < 0) return value;
	try { return new URL('http://[' + value + ']/').hostname; } catch (e) { return value; }
}

/* A name or IP match alone is insufficient: require the same link, a nearby
 * observation time and one unambiguous device in the two saved snapshots. */
function linkedDevice(endpoint, state) {
	var scanTime = Number(state.snapshots.adb && state.snapshots.adb.scanned_at);
	if (!scanTime || !endpoint.iface) return null;
	var found = records(state.snapshots.devices).filter(function(device) {
		return device.observation !== 'cached' && device.iface === endpoint.iface &&
			Number(device.last_seen) > 0 && Math.abs(scanTime - Number(device.last_seen)) <= 120 &&
			addresses(device).some(function(address) { return normalizeAddress(address) === normalizeAddress(endpoint.address); });
	});
	return found.length === 1 ? found[0] : null;
}
function linkedEndpoints(device, state) {
	return records(state.snapshots.adb).filter(function(endpoint) {
		var found = linkedDevice(endpoint, state);
		return found && found.id === device.id;
	});
}
function recordName(device) { return ed.text(device.name || device.hostname, '未命名设备'); }
function networkName(device) { return ed.text(device.network || device.iface, '未知范围'); }
function statusBadge(device) { return ed.badge(observationNames[device.observation] || '记录', device.observation === 'recent' ? 'success' : ''); }
function sourceName(source) {
	var names = {dhcp:'DHCP 租约',dhcp6:'DHCPv6 租约',dhcp_leases:'DHCP 租约',neighbor:'邻居表',neighbors:'邻居表',arp:'ARP 主动探测',arp_scan:'ARP 主动探测','arp-scan':'ARP 主动探测',
		host_hints:'LuCI 主机提示',hosthints:'LuCI 主机提示','host-hints':'LuCI 主机提示',mdns:'mDNS 服务信息',uci:'管理员配置',oui:'MAC 厂商数据库'};
	return names[source] || ed.text(source, '未提供来源');
}

function snapshotNotices(ctx, kind) {
	var snapshot = ctx.state.snapshots[kind], result = [];
	if (ctx.state.errors[kind]) result.push(ed.note(ctx.state.errors[kind], 'error'));
	if (ctx.state.busy[kind]) result.push(ed.note('正在发现，完成前保留上次结果。页面不会自动发起下一次发现。'));
	if (snapshot && snapshot.status === 'partial') result.push(ed.note('本次仅部分来源采集成功，以下结果可能不完整。', 'warning'));
	if (snapshot && snapshot.truncated) result.push(ed.note('结果已达到本次返回上限，当前列表不是完整设备清单。', 'warning'));
	if (snapshot && Array.isArray(snapshot.errors) && snapshot.errors.length) {
		result.push(E('details', {'class': 'ed-source-errors'}, [E('summary', ['查看来源状态与错误（' + snapshot.errors.length + '）']),
			E('ul', snapshot.errors.slice(0, 20).map(function(error) { return E('li', [
				ed.text(error.source, '发现来源') + '：' + ed.text(error.message || error.code, '来源暂不可用')
			]); }))]));
	}
	return result;
}
function timestamp(snapshot) {
	return E('div', {'class': 'ed-snapshot-line'}, [E('span', [ed.icon('clock'),
		snapshot && snapshot.has_snapshot ? '上次发现：' + ed.date(snapshot.scanned_at) : '尚无已保存的发现结果']),
		E('span', ['手动发现 · 刷新仅读取快照'])]);
}
function paginate(filtered, filter) {
	var pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	filter.page = Math.min(Math.max(Number(filter.page) || 1, 1), pages);
	return { pages: pages, rows: filtered.slice((filter.page - 1) * PAGE_SIZE, filter.page * PAGE_SIZE) };
}
function pagination(footer, filtered, all, filter, paged, redraw, unit) {
	footer.replaceChildren(E('span', ['显示 ' + filtered + ' / ' + all + ' ' + unit]),
		E('div', {'class': 'ed-pagination'}, [E('span', ['每页 ' + PAGE_SIZE + ' 条']),
			ed.button('上一页', function() { filter.page--; redraw(); }, {kind: 'small', disabled: filter.page <= 1}),
			E('span', {'class': 'ed-page-number'}, [filter.page + ' / ' + paged.pages]),
			ed.button('下一页', function() { filter.page++; redraw(); }, {kind: 'small', disabled: filter.page >= paged.pages})]));
}
function emptyRow(columns, snapshot, filtered, clear) {
	var title, description;
	if (!snapshot) { title = '发现结果暂不可用'; description = '请查看上方错误，或点击刷新列表重新读取。'; }
	else if (!snapshot.has_snapshot) { title = '还没有发现结果'; description = '点击右上角的立即发现，采集当前可见的信息。'; }
	else if (filtered) { title = '没有匹配的记录'; description = '可以调整关键词或筛选条件。'; }
	else { title = '本次未发现记录'; description = '本次发现已完成。可检查网络范围与相关服务后再次发现。'; }
	return E('tr', [E('td', {colspan: columns, 'class': 'ed-empty-cell'}, [ed.empty(title, description,
		filtered ? ed.button('清空筛选', clear, {kind: 'small'}) : null)])]);
}
function exportRecords(rows, scannedAt) {
	var blob = new Blob([JSON.stringify({scanned_at: scannedAt || null, devices: rows}, null, 2)], {type: 'application/json;charset=utf-8'});
	var url = URL.createObjectURL(blob), link = E('a', {href: url, download: 'easy-discovery-devices.json'});
	document.body.appendChild(link); link.click(); link.remove();
	setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

return baseclass.extend({
	devices: function(ctx) {
		var state = ctx.state, snapshot = state.snapshots.devices, all = records(snapshot), filter = state.deviceFilter;
		var networkOptions = [['all', '全部网络']];
		Array.from(new Set(all.map(networkName))).sort().forEach(function(name) { networkOptions.push([name, name]); });
		if (!networkOptions.some(function(option) { return option[0] === filter.network; })) filter.network = 'all';
		var body = E('tbody'), footer = E('div', {'class': 'ed-table-footer'}), search, network, observation;
		function selected() {
			var query = filter.query.toLowerCase().trim();
			return all.filter(function(device) {
				var haystack = [device.name, device.hostname, device.mac, device.vendor, device.model].concat(addresses(device)).join(' ').toLowerCase();
				return (!query || haystack.indexOf(query) >= 0) && (filter.network === 'all' || networkName(device) === filter.network) &&
					(filter.observation === 'all' || device.observation === filter.observation);
			});
		}
		function clear() { filter.query = ''; filter.network = 'all'; filter.observation = 'all'; filter.page = 1;
			search.querySelector('input').value = ''; network.value = 'all'; observation.value = 'all'; drawRows(); }
		function drawRows() {
			var filtered = selected(), paged = paginate(filtered, filter);
			var rows = paged.rows.map(function(device) {
				var ips = addresses(device), linked = linkedEndpoints(device, state);
				return E('tr', [
					ed.cell([E('div', {'class': 'ed-device'}, [E('span', {'class': 'ed-device-icon'}, [ed.icon(linked.length ? 'phone' : 'network')]),
						E('div', [E('strong', [recordName(device), linked.length ? E('span', {'class': 'ed-mini-tag'}, ['ADB']) : '']),
							E('div', {'class': 'ed-sub'}, [ed.text(device.hostname, networkName(device))])])])]),
					ed.cell([E('div', {'class': 'ed-mono'}, [ips[0] || '—']), E('div', {'class': 'ed-sub'}, [networkName(device) + (ips.length > 1 ? ' · +' + (ips.length - 1) + ' 地址' : '')])]),
					ed.cell(device.mac, 'ed-mono ed-muted'), ed.cell(device.vendor || '未识别', device.vendor ? '' : 'ed-muted'),
					ed.cell(device.model || '未识别', device.model ? '' : 'ed-muted'), ed.cell([statusBadge(device)]),
					ed.cell(ed.date(device.last_seen), 'ed-time'),
					ed.cell([ed.button('详情', function() { ctx.actions.detail(device); }, {kind: 'text', icon: 'chevron'})])
				]);
			});
			body.replaceChildren.apply(body, rows.length ? rows : [emptyRow(8, snapshot, all.length > 0, clear)]);
			pagination(footer, filtered.length, all.length, filter, paged, drawRows, '条记录');
		}
		search = ed.search('搜索名称、IP 或 MAC 地址', filter.query, function(value) { filter.query = value; filter.page = 1; drawRows(); });
		network = ed.select('网络范围', networkOptions, filter.network, function(value) { filter.network = value; filter.page = 1; drawRows(); });
		observation = ed.select('发现状态', [['all', '全部记录'], ['recent', '本次观测'], ['lease', '租约记录'], ['cached', '历史记录']], filter.observation,
			function(value) { filter.observation = value; filter.page = 1; drawRows(); });
		var head = E('thead', [E('tr', ['设备名称', '内网 IP', 'MAC 地址', '厂商', '设备型号', '发现状态', '最后可达', '操作'].map(function(label) { return E('th', {scope:'col'}, [label]); }))]);
		var view = E('div', [E('div', {'class': 'ed-stats'}, [
			ed.stat('已发现设备', all.length, '条', '当前快照中的设备记录', 'network'),
			ed.stat('本次观测', all.filter(function(d) { return d.observation === 'recent'; }).length, '条', '不等同于持续在线', 'activity', 'green'),
			ed.stat('ADB 端点', records(state.snapshots.adb).length, '个', '同一设备可有多个端点', 'terminal', 'purple'),
			ed.stat('网络范围', Math.max(0, networkOptions.length - 1), '个', '按网络范围聚合', 'network', 'orange')
		]), timestamp(snapshot)].concat(snapshotNotices(ctx, 'devices')).concat([
			E('div', {'class': 'ed-card'}, [ed.section('设备列表', '设备名称、地址与身份信息，集中查看。', E('div', {'class': 'ed-tools'}, [search, network, observation,
				ed.button('', function() { exportRecords(selected(), snapshot && snapshot.scanned_at); }, {icon: 'download', kind: 'icon-only', title: '导出当前列表', ariaLabel: '导出当前设备列表', disabled: !all.length})])),
				state.busy.devices ? E('div', {'class': 'ed-progress'}) : '',
				E('div', {'class': 'ed-table-scroll'}, [E('table', {'class': 'ed-table ed-device-table'}, [head, body])]), footer]),
			E('div', {'class': 'ed-under-note'}, [ed.icon('info'), E('span', ['无法确定的厂商与型号显示“未识别”。DHCP 租约和邻居缓存不能证明设备实时在线。'])])
		]));
		drawRows(); return view;
	},
	adb: function(ctx) {
		var state = ctx.state, snapshot = state.snapshots.adb, all = records(snapshot), filter = state.adbFilter;
		var body = E('tbody'), footer = E('div', {'class': 'ed-table-footer'}), search, protocol;
		function clear() { filter.query = ''; filter.protocol = 'all'; filter.page = 1; search.querySelector('input').value = ''; protocol.value = 'all'; drawRows(); }
		function drawRows() {
			var query = filter.query.toLowerCase().trim();
			var filtered = all.filter(function(endpoint) {
				var device = linkedDevice(endpoint, state);
				return (filter.protocol === 'all' || endpoint.protocol === filter.protocol) && (!query ||
					[endpoint.instance, endpoint.address, endpoint.host, device && recordName(device)].join(' ').toLowerCase().indexOf(query) >= 0);
			});
			var paged = paginate(filtered, filter);
			var rows = paged.rows.map(function(endpoint) {
				var device = linkedDevice(endpoint, state);
				return E('tr', [
					ed.cell([E('div', {'class': 'ed-device'}, [E('span', {'class': 'ed-device-icon'}, [ed.icon('terminal')]), E('div', [
						E('strong', [ed.text(endpoint.instance, '未命名实例')]), E('div', {'class': 'ed-sub'}, [ed.text(endpoint.host, '无线调试连接')])])])]),
					ed.cell(endpoint.address, 'ed-mono'), ed.cell(endpoint.port, 'ed-mono'), ed.cell([ed.badge(ed.text(endpoint.protocol), endpoint.protocol === 'IPv6' ? 'blue' : '')]),
					ed.cell(endpoint.iface, 'ed-mono'), ed.cell([device ? ed.button(recordName(device), function() { ctx.actions.detail(device); }, {kind: 'text'}) : E('span', {'class': 'ed-muted'}, ['未关联'])]),
					ed.cell([ed.button('复制', function() { return ed.copy(ed.endpoint(endpoint)); }, {kind: 'text', icon: 'copy'})])
				]);
			});
			body.replaceChildren.apply(body, rows.length ? rows : [emptyRow(7, snapshot, all.length > 0, clear)]);
			pagination(footer, filtered.length, all.length, filter, paged, drawRows, '个端点');
		}
		search = ed.search('搜索实例名称或端点地址', filter.query, function(value) { filter.query = value; filter.page = 1; drawRows(); });
		protocol = ed.select('网络协议', [['all', '全部协议'], ['IPv4', 'IPv4'], ['IPv6', 'IPv6']], filter.protocol, function(value) { filter.protocol = value; filter.page = 1; drawRows(); });
		var linked = new Set(); all.forEach(function(endpoint) { var d = linkedDevice(endpoint, state); if (d) linked.add(d.id); });
		var ready = ctx.actions.adbReady(), known = !!state.environment;
		var topNotice = ed.note(known ? (ready ? 'ADB 发现已就绪，Avahi 与 D-Bus 服务运行中。' : 'ADB 发现暂不可用。请确认相关依赖与服务；历史快照仍可查看。') : '组件状态暂不可用，可在运行环境中刷新状态。', known && ready ? 'success' : 'warning',
			ed.button('管理运行环境', function() { ctx.actions.services(); }, {kind: 'text', icon: 'chevron'}));
		var view = E('div', [topNotice, E('div', {'class': 'ed-stats'}, [
			ed.stat('发现的 ADB 端点', all.length, '个', '无线调试连接服务', 'terminal', 'purple'),
			ed.stat('关联设备', linked.size, '台', '基于同网络与相近观测时间', 'phone'),
			ed.stat('网络协议', new Set(all.map(function(e) { return e.protocol; })).size, '种', 'IPv4 / IPv6', 'network', 'green'),
			ed.stat('发现窗口', 8, '秒', '每次主动发现的采集窗口', 'clock', 'orange')]), timestamp(snapshot)]
			.concat(snapshotNotices(ctx, 'adb')).concat([
				E('div', {'class': 'ed-card'}, [ed.section('无线 ADB 端点', '_adb-tls-connect._tcp · 供 EasyADB 客户端连接', E('div', {'class': 'ed-tools'}, [search, protocol])),
					state.busy.adb ? E('div', {'class': 'ed-progress'}) : '',
					E('div', {'class': 'ed-table-scroll'}, [E('table', {'class': 'ed-table ed-adb-table'}, [E('thead', [E('tr', ['ADB 服务实例', '端点地址', '端口', '协议', '网络接口', '关联设备', '操作'].map(function(h) { return E('th', {scope:'col'}, [h]); }))]), body])]), footer]),
				E('div', {'class': 'ed-under-note'}, [ed.icon('info'), E('span', ['发现端点不代表 ADB 已授权。设备关联仅供核对，连接、配对与投屏在 EasyADB 中完成。'])])
			]));
		drawRows(); return view;
	},
	detail: function(device, ctx) {
		var previousFocus = document.activeElement, eps = linkedEndpoints(device, ctx.state), dialog;
		function close() { dialog.close(); }
		function field(label, value) { return [E('dt', [label]), E('dd', Array.isArray(value) ? value : [ed.text(value)])]; }
		var detailRows = [].concat(field('主机名', device.hostname),
			field('设备厂商', [E('span', [device.vendor || '未识别']), E('div', {'class':'ed-sub'}, [sourceName(device.vendor_source)])]),
			field('设备型号', [E('span', [device.model || '未识别']), E('div', {'class':'ed-sub'}, [sourceName(device.model_source)])]),
			field('最后可达', ed.date(device.last_seen)), field('信息采集时间', ed.date(device.last_observed_at)));
		var addressRows = [].concat(field('IPv4 地址', (device.ipv4 || []).join('、')), field('IPv6 地址', (device.ipv6 || []).join('、')),
			field('MAC 地址', device.mac), field('网络范围', networkName(device)), field('网络接口', device.iface));
		dialog = E('dialog', {'class': 'ed-root ed-drawer', 'aria-labelledby': 'ed-detail-title'}, [
			E('div', {'class': 'ed-drawer-head'}, [E('h2', {id: 'ed-detail-title'}, ['设备详情']), ed.button('', close, {kind:'icon-only text', icon:'close', ariaLabel:'关闭详情'})]),
			E('div', {'class': 'ed-drawer-body'}, [E('div', {'class':'ed-detail-hero'}, [E('div', {'class':'ed-device-icon'}, [ed.icon('network')]),
				E('div', [E('h3', [recordName(device)]), statusBadge(device)])]),
				E('h4', ['基本信息']), E('dl', {'class':'ed-detail-grid'}, detailRows),
				E('h4', ['网络信息']), E('dl', {'class':'ed-detail-grid'}, addressRows),
				E('h4', ['信息来源']), E('div', {'class':'ed-chips'}, (Array.isArray(device.sources) ? device.sources : []).map(function(source) { return E('span', {'class':'ed-source-chip'}, [sourceName(source)]); })),
				E('p', {'class':'ed-description'}, ['未提供型号时保持未识别；来源记录保留以便核对。']),
				E('h4', ['关联 ADB 端点 · ' + eps.length]), eps.length ? E('div', eps.map(function(endpoint) { return E('div', {'class':'ed-endpoint'}, [E('div', [
					E('code', [ed.endpoint(endpoint)]), E('div', {'class':'ed-sub'}, [ed.text(endpoint.protocol) + ' · ' + ed.text(endpoint.iface)])]),
					ed.button('', function() { return ed.copy(ed.endpoint(endpoint)); }, {kind:'icon-only text',icon:'copy',ariaLabel:'复制端点'})]); })) : E('p', {'class':'ed-description'}, ['没有满足关联条件的端点。'])]),
			E('div', {'class':'ed-drawer-foot'}, [ed.button('复制设备信息', function() { return ed.copy(JSON.stringify(device, null, 2)); }, {icon:'copy'}),
				eps.length ? ed.button('查看 ADB 端点', function() { close(); ctx.state.adbFilter.query = recordName(device); ctx.state.adbFilter.page = 1; ctx.state.adbFilter.protocol = 'all'; ctx.actions.page('adb'); }, {kind:'primary'}) : ed.button('完成', close, {kind:'primary'})])
		]);
		dialog.addEventListener('close', function() { dialog.remove(); if (previousFocus && previousFocus.isConnected) previousFocus.focus(); });
		dialog.addEventListener('click', function(event) { if (event.target === dialog) { var bounds=dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right) close(); } });
		document.body.appendChild(dialog);
		if (typeof dialog.showModal === 'function') dialog.showModal();
		else { dialog.remove(); ed.modal('设备详情', [E('pre', {'class':'ed-code'}, [JSON.stringify(device, null, 2)])]); }
	},
	records: records
});
