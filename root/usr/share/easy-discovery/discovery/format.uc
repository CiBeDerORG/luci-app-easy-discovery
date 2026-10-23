// SPDX-License-Identifier: Apache-2.0
// Pure bounded normalization. Inputs are private files created by common.sh;
// no discovered hostname, address, TXT value or API parameter reaches a shell.
'use strict';
import { readfile } from 'fs';

const MAX_INPUT = 2097152;
const DEVICE_LIMIT = 256;
const ADDRESS_LIMIT = 8;
const NOW = time();

function text(value, limit) {
	if (type(value) != 'string') return null;
	// POSIX regular expressions stop at NUL. Filter bounded labels bytewise so
	// malformed advertisements cannot truncate everything after a control byte.
	let output = '', maximum = limit || 128;
	for (let i = 0; i < length(value) && length(output) < maximum; i++) {
		let character = substr(value, i, 1), code = ord(character);
		if (code < 32 || code == 127) character = ' ';
		if (character == ' ' && !length(output)) continue;
		output += character;
	}
	output = trim(output);
	return length(output) ? output : null;
}
function array(value) { return type(value) == 'array' ? value : []; }
function object(value) { return type(value) == 'object' ? value : {}; }
function read(path) {
	let value = readfile(path, MAX_INPUT + 1);
	if (value == null) return null;
	if (length(value) > MAX_INPUT) die('Input exceeds discovery limit');
	return value;
}
function readjson(path) {
	let value = read(path);
	if (value == null || !length(trim(value))) return null;
	try { return json(value); } catch (e) { return null; }
}
function emit(value) { printf('%J\n', value); }
function base(kind) {
	return { status: 'ok', schema_version: 1, has_snapshot: false, scanned_at: null,
		source: kind == 'adb' ? 'avahi' : 'network-aggregate', storage: 'volatile',
		devices: [], count: 0, truncated: false, errors: [], sources: [], networks: [] };
}
function snapshot(path, kind) {
	let previous = readjson(path);
	if (type(previous) != 'object' || previous.schema_version != 1 ||
		type(previous.devices) != 'array' || length(previous.devices) > (kind == 'adb' ? 32 : DEVICE_LIMIT) ||
		(previous.status != 'ok' && previous.status != 'partial')) return null;
	previous.count = length(previous.devices);
	return previous;
}
function errorResult(path, kind, code, message, errors) {
	let result = snapshot(path, kind) || base(kind);
	result.status = 'error';
	result.message = message;
	result.errors = errors || [{ source: kind, code, message }];
	result.last_attempt_at = NOW;
	return result;
}
function ipv4(value) {
	if (type(value) != 'string' || !match(value, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) return null;
	let parts = split(value, '.');
	let result = 0;
	for (let part in parts) {
		if (length(part) > 3 || int(part, 10) > 255) return null;
		result = result * 256 + int(part, 10);
	}
	if (int(parts[0], 10) == 0 || int(parts[0], 10) == 127 || int(parts[0], 10) >= 224) return null;
	return { address: join('.', map(parts, p => '' + int(p, 10))), words: result, family: 4 };
}
function ipv6(value) {
	if (type(value) != 'string' || length(value) > 128) return null;
	value = lc(value);
	// Zone identifiers are only accepted separately as a validated interface.
	if (index(value, '%') >= 0 || !match(value, /^[0-9a-f:.]+$/)) return null;
	let sections = split(value, '::');
	if (length(sections) > 2) return null;
	function side(s) {
		if (s == '') return [];
		let parts = split(s, ':');
		let words = [];
		for (let i = 0; i < length(parts); i++) {
			let part = parts[i];
			if (index(part, '.') >= 0) {
				let v4 = ipv4(part);
				if (!v4 || i != length(parts) - 1) return null;
				push(words, (v4.words >> 16) & 65535, v4.words & 65535);
			} else {
				if (!match(part, /^[0-9a-f]{1,4}$/)) return null;
				push(words, int(part, 16));
			}
		}
		return words;
	}
	let left = side(sections[0]), right = length(sections) == 2 ? side(sections[1]) : [];
	if (left == null || right == null) return null;
	let missing = 8 - length(left) - length(right);
	if ((length(sections) == 1 && missing != 0) || (length(sections) == 2 && missing < 1)) return null;
	let words = [];
	for (let w in left) push(words, w);
	for (let i = 0; i < missing; i++) push(words, 0);
	for (let w in right) push(words, w);
	if (length(words) != 8 || (words[0] & 65280) == 65280) return null;
	let any = 0; for (let w in words) any |= w;
	if (!any || (any == 1 && words[7] == 1 && !length(filter(slice(words, 0, 7), w => w != 0)))) return null;
	let bestStart = -1, bestLength = 1;
	for (let i = 0; i < 8;) {
		if (words[i] != 0) { i++; continue; }
		let start = i; while (i < 8 && words[i] == 0) i++;
		if (i - start > bestLength) { bestStart = start; bestLength = i - start; }
	}
	let printable = map(words, w => sprintf('%x', w));
	let address = bestStart < 0 ? join(':', printable) :
		join(':', slice(printable, 0, bestStart)) + '::' + join(':', slice(printable, bestStart + bestLength));
	return { address, words, family: 6, linklocal: (words[0] & 65472) == 65152 };
}
function ip(value) {
	if (type(value) != 'string') return null;
	value = split(value, '/')[0];
	return index(value, ':') >= 0 ? ipv6(value) : ipv4(value);
}
function mac(value) {
	if (type(value) != 'string' || !match(value, /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/)) return null;
	value = lc(value);
	if (value == '00:00:00:00:00:00' || (int(substr(value, 0, 2), 16) & 1)) return null;
	return value;
}
function validName(value) { return type(value) == 'string' && match(value, /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,31}$/); }
function within(address, prefix) {
	let candidate = ip(prefix.address);
	let bits = int(prefix.mask);
	if (!candidate || candidate.family != address.family || prefix.mask == null || bits == null || bits < 0 || bits > (address.family == 4 ? 32 : 128)) return false;
	if (address.family == 4) {
		return bits == 0 || (address.words >> (32 - bits)) == (candidate.words >> (32 - bits));
	}
	for (let i = 0; i < 8; i++) {
		let n = bits > 16 ? 16 : bits;
		if (n > 0 && (address.words[i] >> (16 - n)) != (candidate.words[i] >> (16 - n))) return false;
		bits -= n;
		if (bits <= 0) break;
	}
	return true;
}
function resolveScope(work) {
	let wanted = split(trim(read(work + '/networks') || ''), /\s+/);
	let dump = readjson(work + '/interfaces');
	let scopes = [], seen = {};
	for (let name in wanted) {
		if (!validName(name) || match(lc(name), /^wan[0-9]*$/) || seen[name] || length(scopes) >= 8) continue;
		seen[name] = true;
		for (let current in array(dump?.interface)) {
			if (current.interface != name || current.up != true) continue;
			let iface = current.l3_device || current.device;
			if (!validName(iface) || iface == 'lo') continue;
			let v4 = [], v6 = [], own = [];
			for (let a in array(current['ipv4-address'])) {
				let parsed = ipv4(a.address);
				if (parsed && a.mask != null && int(a.mask) >= 1 && int(a.mask) <= 32) {
					push(v4, { address: parsed.address, mask: int(a.mask) });
					push(own, parsed.address);
				}
			}
			for (let a in array(current['ipv6-address'])) {
				let parsed = ipv6(a.address);
				if (parsed && a.mask != null && int(a.mask) >= 1 && int(a.mask) <= 128) {
					push(v6, { address: parsed.address, mask: int(a.mask) });
					push(own, parsed.address);
				}
			}
			for (let a in array(current['ipv6-prefix-assignment'])) {
				let parsed = ipv6(a.address);
				if (parsed && a.mask != null && int(a.mask) >= 1 && int(a.mask) <= 128) push(v6, { address: parsed.address, mask: int(a.mask) });
				let localAddress = ipv6(a['local-address']?.address);
				if (localAddress) push(own, localAddress.address);
			}
			push(scopes, { name, iface, ipv4: v4, ipv6: v6, own });
		}
	}
	return { networks: scopes, arp_enabled: trim(read(work + '/arp-enabled') || '') == '1' };
}
function findScope(scopes, address, iface) {
	let candidates = [];
	for (let scope in scopes) {
		if (iface && scope.iface != iface && scope.name != iface) continue;
		if (index(scope.own, address.address) >= 0) continue;
		let prefixes = address.family == 4 ? scope.ipv4 : scope.ipv6;
		let belongs = length(filter(prefixes, p => within(address, p))) > 0;
		if (belongs || (iface && address.family == 6 && address.linklocal)) push(candidates, scope);
	}
	return length(candidates) == 1 ? candidates[0] : null;
}
function fields(line) {
	// Only the first nine separators are structural: TXT data may contain ';'.
	let out = [], value = '';
	for (let i = 0; i < length(line); i++) {
		let c = substr(line, i, 1);
		if (c == '\\' && i + 1 < length(line)) value += c + substr(line, ++i, 1);
		else if (c == ';' && length(out) < 9) { push(out, value); value = ''; }
		else value += c;
	}
	push(out, value);
	return out;
}
function unescapeLabel(value) {
	return replace(value, /\\([0-9]{3}|.)/g, (whole, escaped) =>
		match(escaped, /^[0-9]{3}$/) ? chr(int(escaped, 10)) : escaped);
}
function browseRecord(line, scopes, adbOnly) {
	if (length(line) > 8192) return null;
	let f = fields(line);
	if (length(f) < 9 || f[0] != '=' || !validName(f[1]) ||
		(f[2] != 'IPv4' && f[2] != 'IPv6') || (adbOnly && f[4] != '_adb-tls-connect._tcp') ||
		!match(f[8], /^[0-9]{1,5}$/) || int(f[8], 10) < 1 || int(f[8], 10) > 65535) return null;
	let address = ip(f[7]);
	if (!address || (f[2] == 'IPv4' ? 4 : 6) != address.family) return null;
	let scope = findScope(scopes, address, f[1]);
	if (!scope) return null;
	let instance = text(unescapeLabel(f[3]), 256), host = text(unescapeLabel(f[6]), 253);
	if (!instance || !host) return null;
	return { iface: scope.iface, network: scope.name, protocol: f[2], instance,
		service: text(f[4], 128), host, address: address.address, port: int(f[8], 10), txt: f[9] || '' };
}
function txtFields(value) {
	let result = {}, quoted = false, chunk = '';
	for (let i = 0; i < length(value); i++) {
		let c = substr(value, i, 1);
		if (c == '\\' && quoted && i + 1 < length(value)) { chunk += substr(value, ++i, 1); continue; }
		if (c == '"') {
			if (quoted) {
				let sep = index(chunk, '=');
				if (sep > 0 && sep <= 32) result[lc(substr(chunk, 0, sep))] = text(substr(chunk, sep + 1), 128);
				chunk = '';
			}
			quoted = !quoted;
		} else if (quoted) chunk += c;
	}
	return result;
}
function arpPlan(scope) {
	let targets = [], seen = {};
	for (let network in scope.networks) {
		for (let a in network.ipv4) {
			if (a.mask < 24 || a.mask > 30 || length(targets) >= 2) continue;
			let address = ipv4(a.address), shift = 32 - a.mask;
			let prefix = (address.words >> shift) << shift;
			let cidr = sprintf('%d.%d.%d.%d/%d', (prefix >> 24) & 255, (prefix >> 16) & 255, (prefix >> 8) & 255, prefix & 255, a.mask);
			let key = network.iface + '/' + cidr;
			if (seen[key]) continue;
			seen[key] = true;
			push(targets, { iface: network.iface, cidr });
		}
	}
	return targets;
}
function inputFiles(work, prefix) {
	// Production captures one bounded Avahi stream and filters every record by
	// interface and subnet. Retain suffixed input support for existing fixtures.
	if (read(work + '/' + prefix + '.rc') != null || read(work + '/' + prefix) != null) return [prefix];
	let files = [];
	for (let i = 1; i <= 8; i++) if (read(work + '/' + prefix + '-' + i + '.rc') != null) push(files, prefix + '-' + i);
	return files;
}
function adb(work) {
	let scope = object(readjson(work + '/scope.json'));
	let result = base('adb'), seen = {};
	result.has_snapshot = true;
	result.scanned_at = NOW;
	result.networks = scope.networks;
	result.sources = [{ source: 'avahi', status: 'ok' }];
	for (let file in inputFiles(work, 'adb')) for (let line in split(read(work + '/' + file) || '', '\n')) {
		let record = browseRecord(line, array(scope.networks), true);
		if (!record) continue;
		delete record.txt;
		let key = record.iface + '\x1f' + record.protocol + '\x1f' + record.instance + '\x1f' + record.address + '\x1f' + record.port;
		if (seen[key]) continue;
		seen[key] = true;
		if (length(result.devices) >= 32) {
			result.truncated = true;
			result.count = length(result.devices);
			return result;
		}
		push(result.devices, record);
	}
	result.count = length(result.devices);
	return result;
}
function devices(work, oldPath) {
	let scope = object(readjson(work + '/scope.json'));
	let scopes = array(scope.networks), result = base('devices');
	let records = {}, addrIndex = {}, successfulSources = 0, current = {};
	let old = snapshot(oldPath, 'devices');
	result.has_snapshot = true;
	result.scanned_at = NOW;
	result.networks = scopes;
	function source(name, file, optional, timeoutOK) {
		let raw = read(work + '/' + file + '.rc');
		if (raw == null && optional) { push(result.sources, { source: name, status: 'unavailable' }); return false; }
		let rc = raw == null ? -1 : int(trim(raw));
		if (rc == 0 || (rc == 124 && timeoutOK)) {
			push(result.sources, { source: name, status: 'ok' });
			successfulSources++;
			return true;
		}
		push(result.sources, { source: name, status: 'error' });
		let label = name == 'mdns' || match(name, /^mdns-[1-8]$/) ? 'mDNS 服务信息' : name;
		let detail = text(read(work + '/' + file + '.stderr'), 240);
		push(result.errors, { source: name, code: rc == 124 ? 'timeout' : 'source_unavailable',
			exit_code: rc, message: label + '读取失败（退出码 ' + rc + '）' +
			(detail ? '：' + detail : '') + '；其他来源仍可使用' });
		return false;
	}
	function invalidSource(name, message) {
		for (let item in result.sources) if (item.source == name && item.status == 'ok') {
			item.status = 'error';
			successfulSources--;
			break;
		}
		push(result.errors, { source: name, code: 'invalid_response', message });
	}
	function add(addressValue, macValue, iface, origin, observation, hostname) {
		let address = ip(addressValue);
		if (!address) return null;
		let network = findScope(scopes, address, iface);
		if (!network) return null;
		let hardware = mac(macValue), prefix = network.name + '@' + network.iface + '/';
		let addressId = prefix + address.address;
		let id = hardware ? prefix + hardware : prefix + 'ip:' + address.address;
		if (!hardware && length(array(addrIndex[addressId])) == 1) id = addrIndex[addressId][0];
		if (!records[id]) {
			if (length(records) >= DEVICE_LIMIT) { result.truncated = true; return null; }
			records[id] = { id, name: null, hostname: null, mac: hardware, ipv4: [], ipv6: [],
				iface: network.iface, network: network.name, vendor: null, model: null,
				vendor_source: null, model_source: null, sources: [], observation,
				last_seen: null, last_observed_at: NOW };
		}
		let record = records[id], addresses = address.family == 4 ? record.ipv4 : record.ipv6;
		if (index(addresses, address.address) < 0) {
			if (length(addresses) < ADDRESS_LIMIT) push(addresses, address.address);
			else result.truncated = true;
		}
		addrIndex[addressId] ??= [];
		if (index(addrIndex[addressId], id) < 0) push(addrIndex[addressId], id);
		if (index(record.sources, origin) < 0) push(record.sources, origin);
		if (observation == 'recent') { record.observation = 'recent'; record.last_seen = NOW; }
		else if (observation == 'lease' && record.observation != 'recent') record.observation = 'lease';
		let name = text(hostname, 128);
		if (name && name != '*' && !record.hostname) { record.hostname = name; record.name = name; }
		current[id] = true;
		return record;
	}
	for (let family in [4, 6]) {
		let file = 'neighbors' + family;
		if (!source('neighbors' + family, file, false, false)) continue;
		for (let line in split(read(work + '/' + file) || '', '\n')) {
			let f = split(trim(line), /\s+/), dev = index(f, 'dev'), lladdr = index(f, 'lladdr');
			if (dev < 0 || lladdr < 0 || index(f, 'FAILED') >= 0 || index(f, 'INCOMPLETE') >= 0) continue;
			add(f[0], f[lladdr + 1], f[dev + 1], 'neighbor', index(f, 'REACHABLE') >= 0 ? 'recent' : 'cached', null);
		}
	}
	let validLeases = false;
	if (source('dhcp', 'leases', false, false)) {
		let leases = readjson(work + '/leases');
		if (type(leases) != 'object' || (type(leases.dhcp_leases) != 'array' && type(leases.dhcp6_leases) != 'array')) {
			invalidSource('dhcp', 'DHCP 返回格式无效');
		} else {
			validLeases = true;
			for (let lease in array(leases.dhcp_leases)) add(lease.ipaddr, lease.macaddr, lease.interface, 'dhcp', 'lease', lease.hostname);
			for (let lease in array(leases.dhcp6_leases)) {
				let addresses = array(lease.ip6addrs);
				if (lease.ip6addr) addresses = [lease.ip6addr, ...addresses];
				for (let address in addresses) add(address, lease.macaddr, lease.interface, 'dhcp6', 'lease', lease.hostname);
			}
		}
	}
	if (!validLeases && source('dhcp-file', 'dhcp-file', true, false)) {
		for (let line in split(read(work + '/dhcp-file') || '', '\n')) {
			let f = split(trim(line), /\s+/);
			if (length(f) < 4 || !match(f[0], /^[0-9]+$/)) continue;
			if (int(f[0]) != 0 && int(f[0]) < NOW) continue;
			add(f[2], f[1], null, 'dhcp', 'lease', f[3]);
		}
	}
	if (source('host-hints', 'host-hints', false, false)) {
		let hints = readjson(work + '/host-hints');
		if (type(hints) != 'object') {
			invalidSource('host-hints', '主机提示返回格式无效');
		}
		else for (let hardware, hint in hints) {
			for (let address in array(hint.ipaddrs)) add(address, hardware, null, 'host-hints', 'cached', hint.name);
			for (let address in array(hint.ip6addrs)) add(address, hardware, null, 'host-hints', 'cached', hint.name);
		}
	}
	if (scope.arp_enabled) {
		let plan = arpPlan(scope);
		if (read(work + '/arp-missing.rc') != null) {
			push(result.errors, { source: 'arp', code: 'dependency_missing', message: '已启用 ARP 增强，但尚未安装 arp-scan' });
			push(result.sources, { source: 'arp', status: 'unavailable' });
		} else {
			let skipped = 0, eligible = 0;
			for (let network in scopes) for (let prefix in network.ipv4) {
				if (prefix.mask < 24 || prefix.mask > 30) skipped++;
				else eligible++;
			}
			if (eligible > 2) skipped++;
			if (!length(plan) || skipped) push(result.errors, { source: 'arp', code: 'scope_limited', message: 'ARP 仅扫描最多两个 /24 至 /30 的本地网段，其他范围使用被动发现信息' });
			for (let i = 1; i <= length(plan); i++) {
				if (!source('arp:' + plan[i - 1].iface, 'arp-' + i, false, false)) continue;
				for (let line in split(read(work + '/arp-' + i) || '', '\n')) {
					let f = split(trim(line), /\s+/);
					if (length(f) >= 2) add(f[0], f[1], plan[i - 1].iface, 'arp', 'recent', null);
				}
			}
		}
	} else push(result.sources, { source: 'arp', status: 'disabled' });
	let mdnsFiles = inputFiles(work, 'mdns');
	if (!length(mdnsFiles)) push(result.sources, { source: 'mdns', status: 'unavailable' });
	for (let file in mdnsFiles) if (source(file, file, true, true)) {
		for (let line in split(read(work + '/' + file) || '', '\n')) {
			let r = browseRecord(line, scopes, false);
			if (!r) continue;
			let record = add(r.address, null, r.iface, 'mdns', 'cached', r.host);
			if (!record) continue;
			let info = txtFields(r.txt);
			let model = info.model || info.modelname || (r.service == '_googlecast._tcp' ? info.md : null);
			let vendor = info.manufacturer || info.vendor;
			if (model && !record.model) { record.model = model; record.model_source = 'mdns:' + r.service; }
			if (vendor && !record.vendor) { record.vendor = vendor; record.vendor_source = 'mdns:' + r.service; }
		}
	}
	if (!successfulSources) {
		let failure = errorResult(oldPath, 'devices', 'sources_unavailable', '所有发现来源均不可用，已保留上次成功结果', result.errors);
		failure.sources = result.sources;
		emit(failure);
		exit(3);
	}
	for (let previous in array(old?.devices)) {
		if (!previous.id || !length(filter(scopes, n => n.name == previous.network && n.iface == previous.iface))) continue;
		let record = records[previous.id];
		if (record) {
			if (record.last_seen == null) record.last_seen = previous.last_seen;
			// A hostname/model learned earlier remains useful but keeps its source.
			if (!record.hostname) { record.hostname = previous.hostname; record.name = previous.name; }
			for (let field in ['vendor', 'model', 'vendor_source', 'model_source']) if (!record[field]) record[field] = previous[field] || null;
		} else if (NOW - (previous.last_observed_at || old.scanned_at || 0) <= 86400) {
			if (length(records) >= DEVICE_LIMIT) { result.truncated = true; continue; }
			previous.observation = 'cached';
			records[previous.id] = previous;
		}
	}
	for (let id, record in records) {
		record.name ||= record.hostname || record.mac || record.ipv4[0] || record.ipv6[0] || '未命名设备';
		push(result.devices, record);
	}
	const ranks = { recent: 0, lease: 1, cached: 2 };
	sort(result.devices, (a, b) => ranks[a.observation] - ranks[b.observation] || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	result.count = length(result.devices);
	result.observed_count = length(current);
	result.reachable_count = length(filter(result.devices, d => d.observation == 'recent'));
	result.status = length(result.errors) ? 'partial' : 'ok';
	return result;
}

const action = ARGV[0], location = ARGV[1];
switch (action) {
	case 'scope': {
		let scope = resolveScope(location);
		if (!length(scope.networks)) exit(1);
		emit(scope);
		break;
	}
	case 'arp-plan':
		for (let target in arpPlan(object(readjson(location + '/scope.json')))) printf('%s %s\n', target.iface, target.cidr);
		break;
	case 'ifaces': {
		let seen = {};
		for (let network in array(readjson(location + '/scope.json')?.networks)) {
			if (validName(network.iface) && !seen[network.iface]) { printf('%s\n', network.iface); seen[network.iface] = true; }
		}
		break;
	}
	case 'adb': emit(adb(location)); break;
	case 'devices': emit(devices(location, ARGV[2])); break;
	case 'list': {
		let kind = ARGV[2], result = snapshot(location, kind);
		if (result) emit(result);
		else if (read(location) != null) emit(errorResult(location, kind, 'invalid_snapshot', '发现快照损坏，请重新发起发现'));
		else emit(base(kind));
		break;
	}
	case 'error': emit(errorResult(location, ARGV[4], ARGV[2], ARGV[3])); break;
	default: exit(1);
}
