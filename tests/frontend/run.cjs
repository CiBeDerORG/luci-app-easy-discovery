// SPDX-License-Identifier: Apache-2.0
// Executes the production LuCI modules in a real jsdom DOM. Only LuCI's module
// loader, E()/UI bridge and RPC transport are adapted; no router is contacted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../..');
const RESOURCES = path.join(ROOT, 'htdocs/luci-static/resources');
const NOW = 1792756800;
const JOB = 'a'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));
const snapshot = (devices, extras = {}) => ({
  status: 'ok', schema_version: 1, has_snapshot: true, scanned_at: NOW,
  source: 'network-aggregate', count: devices.length, storage: 'volatile',
  devices, errors: [], sources: [], networks: [], truncated: false, ...extras
});
function device(name, address, mac, network = 'lan', observation = 'recent') {
  return { id: network + '@br-' + network + '/' + mac, name, hostname: name,
    mac, ipv4: [address], ipv6: [], iface: 'br-' + network, network,
    vendor: null, model: null, vendor_source: null, model_source: null,
    sources: ['neighbor'], observation, last_seen: NOW, last_observed_at: NOW };
}
function component(id, installed = 'installed', running = false) {
  return { id, name: id, installed, packages: [{ name: id, installed: installed === 'installed', version: '1.0' }],
    has_service: id !== 'arp' && installed === 'installed', running, enabled: false };
}
function environment(extras = {}) {
  return { status: 'ok', package_manager: 'apk', components: [component('avahi', 'installed', true), component('dbus', 'installed', true), component('arp', 'missing')],
    settings: { networks: ['lan'], arp_scan: false }, job: null, ...extras };
}
function auth(extras = {}) {
  return { status: 'ok', state: 'managed', username: 'easyadb',
    permissions: { deviceList: true, deviceScan: false, adbList: true, adbScan: false },
    legacy_adb_scan: false, legacy_only: false, suspended: false, recovery_required: false, ...extras };
}
function task(state = 'running') {
  return { id: JOB, state, component: 'avahi', action: 'install', message: '测试任务 ' + state, output: '' };
}

async function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="notifications"></div></body></html>', {
    url: 'https://router.example/cgi-bin/luci/admin/services/easy-discovery', runScripts: 'outside-only'
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', e => { errors.push(e.error || new Error(e.message)); e.preventDefault(); });
  const pendingTimers = new Map();
  let timerId = 0;
  window.setTimeout = (fn, delay) => { pendingTimers.set(++timerId, { fn, delay }); return timerId; };
  window.clearTimeout = id => pendingTimers.delete(id);
  // jsdom supplies the native element type but not dialog visibility methods.
  // These adapters cover its lifecycle only, not application behavior or layout.
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };

  function E(tag, attributes, children) {
    if (Array.isArray(attributes) || attributes instanceof window.Node || typeof attributes === 'string' || typeof attributes === 'number') {
      children = attributes; attributes = {};
    }
    const element = window.document.createElement(tag);
    Object.entries(attributes || {}).forEach(([name, value]) => {
      if (typeof value === 'function') element.addEventListener(name, value);
      else if (value != null) element.setAttribute(name, String(value));
    });
    function append(value) {
      if (value == null) return;
      if (Array.isArray(value)) return value.forEach(append);
      element.appendChild(value instanceof window.Node ? value : window.document.createTextNode(String(value)));
    }
    append(children);
    return element;
  }
  const calls = [], queues = new Map();
  const state = {
    devices: options.devices || snapshot([device('Pixel 8', '192.168.1.21', '02:11:22:33:44:55')]),
    adb: options.adb || snapshot([], { source: 'avahi' }),
    environment: options.environment || environment(), authorization: options.authorization || auth()
  };
  const queue = (key, ...values) => queues.set(key, values);
  async function reply(key, fallback) {
    calls.push(key);
    const values = queues.get(key);
    let result = values && values.length ? values.shift() : fallback();
    if (typeof result === 'function') result = await result(state);
    if (result instanceof Error) throw result;
    return clone(result);
  }
  const rpc = { declare(spec) { return () => {
    const kind = spec.object === 'easy-discovery.devices' ? 'devices' : 'adb';
    return reply(kind + '.' + spec.method, () => state[kind]);
  }; } };
  const transport = { exec(command, args) {
    const kind = command.endsWith('-auth') ? 'auth' : 'environment';
    const key = kind + ' ' + args.join(' ');
    return reply(key, () => {
      if (kind === 'auth') return state.authorization;
      if (args[0] === 'status') return state.environment;
      if (args[0] === 'package' && args[1] === 'plan') return { status: 'ok', output: '组件变更计划', message: '确认组件变更' };
      if (args[0] === 'package' && args[1] === 'job') return { status: 'ok', job: state.environment.job || task() };
      return { status: 'ok', message: '测试操作完成' };
    }).then(result => result.__rawExec || ({ code: result.status === 'error' ? 1 : 0, stdout: JSON.stringify(result), stderr: '' }));
  } };
  let activeModal = null;
  const ui = {
    showModal(title, children) {
      this.hideModal();
      activeModal = E('section', { class: 'luci-modal', role: 'dialog' }, [E('h2', [title]), children]);
      window.document.body.append(activeModal);
    },
    hideModal() { if (activeModal) activeModal.remove(); activeModal = null; },
    addNotification(_, content, kind) { window.document.getElementById('notifications').append(E('div', { 'data-kind': kind }, [content])); }
  };
  // LuCI passes hideModal as a callback without a receiver.
  ui.hideModal = ui.hideModal.bind(ui);
  const globals = {
    E, L: { env: { ubuspath: '/ubus' }, resource: name => '/luci-static/resources/' + name,
      hasViewPermission: () => options.permission === undefined ? true : options.permission },
    baseclass: { extend: value => value }, view: { extend: value => value }, ui, rpc, fs: transport
  };
  function load(name) {
    const source = fs.readFileSync(path.join(RESOURCES, name + '.js'), 'utf8');
    return window.Function(...Object.keys(globals), source)(...Object.values(globals));
  }
  globals.ed = load('easy-discovery/common');
  globals.api = load('easy-discovery/api');
  globals.discovery = load('easy-discovery/discovery');
  globals.environment = load('easy-discovery/environment');
  globals.authorization = load('easy-discovery/authorization');
  const view = load('view/easy-discovery/overview');
  const root = view.render(await view.load());
  window.document.body.append(root);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); if (errors.length) throw errors.shift(); };
  const button = (label, within = window.document) => {
    const result = [...within.querySelectorAll('button')].find(el => {
      const copy = el.cloneNode(true);
      if (el.getAttribute('role') === 'tab') copy.querySelectorAll('.ed-count').forEach(count => count.remove());
      return copy.textContent.trim() === label;
    });
    assert.ok(result, '找不到按钮：' + label); return result;
  };
  const click = async (label, within) => { button(label, within).click(); await flush(); };
  const select = async (label, value) => {
    const el = root.querySelector('select[aria-label="' + label + '"]'); assert.ok(el, '找不到筛选：' + label);
    el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); await flush();
  };
  const search = async value => {
    const el = root.querySelector('input[type="search"]'); assert.ok(el);
    el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); await flush(); return el;
  };
  const rows = () => [...root.querySelectorAll('tbody tr')];
  const tick = async () => {
    const entry = [...pendingTimers].find(([, task]) => task.delay === 2000);
    assert.ok(entry, '没有等待中的任务进度轮询'); pendingTimers.delete(entry[0]); entry[1].fn(); await flush();
  };
  const close = () => { window.dispatchEvent(new window.Event('pagehide')); dom.window.close(); };
  return { dom, window, root, calls, state, queue, pendingTimers, click, button, select, search, rows, tick, flush, close, modules: globals };
}

test('初始加载与四个页签只读取状态，不自动扫描或安装', async t => {
  const h = await harness(); t.after(h.close);
  assert.deepEqual(h.calls.sort(), ['adb.list', 'auth status', 'devices.list', 'environment status']);
  assert.equal(h.root.querySelectorAll('[role="tab"]').length, 4);
  for (const label of ['ADB 发现', '运行环境', '接口授权', '设备发现']) {
    await h.click(label, h.root.querySelector('[role="tablist"]'));
    assert.equal(h.root.querySelector('[role="tab"][aria-selected="true"]').textContent.trim().replace(/\d+$/, '').trim(), label);
  }
  assert.equal(h.calls.length, 4);
  assert.equal(h.pendingTimers.size, 0);
});

test('设备按关键词、逻辑网络和观测状态筛选，清空后恢复', async t => {
  const phone = { ...device('Pixel 8', '192.168.1.21', '02:11:22:33:44:55'), model: 'Google Pixel' };
  const tv = device('客厅电视', '192.168.1.22', '02:11:22:33:44:66', 'lan', 'lease');
  const guest = device('访客手机', '192.168.9.10', '02:11:22:33:44:77', 'guest', 'cached');
  const h = await harness({ devices: snapshot([phone, tv, guest]) }); t.after(h.close);
  assert.equal(h.rows().length, 3);
  await h.search('google pixel'); assert.equal(h.rows().length, 1); assert.match(h.rows()[0].textContent, /Pixel 8/);
  await h.search(''); await h.select('网络范围', 'guest'); assert.match(h.rows()[0].textContent, /访客手机/);
  await h.select('网络范围', 'all'); await h.select('发现状态', 'lease'); assert.match(h.rows()[0].textContent, /客厅电视/);
  await h.search('不存在'); assert.match(h.rows()[0].textContent, /没有匹配的记录/);
  await h.click('清空筛选'); assert.equal(h.rows().length, 3);
});

test('超过一页的设备可分页，不把筛选后空列表当作扫描失败', async t => {
  const devices = Array.from({ length: 17 }, (_, i) => device('设备 ' + i, '192.168.1.' + (20 + i), '02:00:00:00:00:' + i.toString(16).padStart(2, '0')));
  const h = await harness({ devices: snapshot(devices) }); t.after(h.close);
  assert.equal(h.rows().length, 15);
  await h.click('下一页'); assert.equal(h.rows().length, 2);
  await h.search('不存在'); assert.match(h.rows()[0].textContent, /没有匹配的记录/);
  assert.doesNotMatch(h.root.textContent, /本次发现失败/);
});

test('发现字符串作为文本呈现，不能注入 HTML', async t => {
  const hostile = '<img src=x onerror="window.injected=true">';
  const h = await harness({ devices: snapshot([device(hostile, '192.168.1.21', '02:11:22:33:44:55')]) }); t.after(h.close);
  assert.ok(h.root.textContent.includes(hostile));
  assert.equal(h.root.querySelectorAll('img').length, 0);
  assert.equal(h.window.injected, undefined);
  await h.click('详情');
  assert.ok(h.window.document.querySelector('dialog[open]').textContent.includes(hostile));
  assert.equal(h.window.document.querySelectorAll('img').length, 0);
});

test('ADB 协议筛选及端点与设备关联采用实际快照', async t => {
  const endpoint = { iface: 'br-lan', network: 'lan', protocol: 'IPv4', instance: 'Pixel 无线调试', service: '_adb-tls-connect._tcp', host: 'pixel.local', address: '192.168.1.21', port: 37001 };
  const h = await harness({ adb: snapshot([endpoint, { ...endpoint, protocol: 'IPv6', address: 'fd00::21', instance: 'IPv6 端点' }], { source: 'avahi' }) }); t.after(h.close);
  await h.click('ADB 发现', h.root.querySelector('[role="tablist"]'));
  assert.equal(h.rows().length, 2); assert.match(h.rows()[0].textContent, /Pixel 8/);
  await h.select('网络协议', 'IPv6'); assert.equal(h.rows().length, 1); assert.match(h.rows()[0].textContent, /fd00::21/);
  assert.equal(h.modules.ed.endpoint({ address: 'fe80::21', iface: 'br-lan', port: 37001 }), '[fe80::21%br-lan]:37001');
});

test('刷新列表不会发起发现；扫描错误保留服务端明确返回的旧快照', async t => {
  const h = await harness(); t.after(h.close);
  await h.click('刷新列表');
  assert.equal(h.calls.filter(key => key === 'devices.list').length, 2);
  assert.equal(h.calls.filter(key => key.endsWith('.scan')).length, 0);
  h.queue('devices.scan', { ...h.state.devices, status: 'error', message: '采集失败，保留快照', last_attempt_at: NOW + 60 });
  await h.click('立即发现设备');
  assert.equal(h.calls.filter(key => key === 'devices.scan').length, 1);
  assert.match(h.root.textContent, /采集失败，保留快照/);
  assert.match(h.rows()[0].textContent, /Pixel 8/);
});

for (const permission of [false, null]) {
  test('权限为 ' + permission + ' 时所有修改入口禁用，状态仍可刷新', async t => {
    const h = await harness({ permission }); t.after(h.close);
    assert.equal(h.button('立即发现设备').disabled, true);
    assert.equal(h.button('刷新列表').disabled, false);
    await h.click('运行环境', h.root.querySelector('[role="tablist"]'));
    assert.equal(h.button('检查更新').disabled, true);
    const serviceTab = h.root.querySelectorAll('.ed-env-step')[1]; serviceTab.click(); await h.flush();
    assert.ok([...h.root.querySelectorAll('[role="switch"]')].every(el => el.disabled));
    await h.click('接口授权', h.root.querySelector('[role="tablist"]'));
    assert.equal(h.button('编辑权限').disabled, true);
    assert.equal(h.button('重新生成密钥').disabled, true);
    assert.equal(h.button('撤销授权').disabled, true);
    assert.equal(h.calls.length, 4);
  });
}

test('包安装立即返回成功时回读组件，不启动进度轮询', async t => {
  const h = await harness({ environment: environment({ components: [component('avahi', 'missing'), component('dbus'), component('arp', 'missing')] }) }); t.after(h.close);
  h.queue('environment package apply install avahi', state => {
    state.environment.components[0] = component('avahi'); state.environment.job = task('succeeded');
    return { status: 'ok', job: state.environment.job };
  });
  await h.click('运行环境', h.root.querySelector('[role="tablist"]'));
  await h.click('安装', h.rows()[0]);
  assert.equal(h.calls.filter(key => key.includes('package apply')).length, 0);
  await h.click('确认安装');
  assert.match(h.root.textContent, /软件包任务 · 已完成/);
  assert.match(h.rows()[0].textContent, /已安装/);
  assert.equal(h.button('检查更新', h.rows()[0]).disabled, false);
  assert.equal(h.calls.filter(key => key.startsWith('environment package job')).length, 0);
  assert.equal(h.pendingTimers.size, 0);
});

test('包安装立即失败时展示失败与实际组件状态', async t => {
  const h = await harness({ environment: environment({ components: [component('avahi', 'missing'), component('dbus'), component('arp', 'missing')] }) }); t.after(h.close);
  h.queue('environment package apply install avahi', state => {
    state.environment.job = task('failed'); return { status: 'ok', job: state.environment.job };
  });
  await h.click('运行环境', h.root.querySelector('[role="tablist"]'));
  await h.click('安装', h.rows()[0]); await h.click('确认安装');
  assert.match(h.root.textContent, /软件包任务 · 执行失败/);
  assert.match(h.rows()[0].textContent, /未安装/);
  assert.equal(h.button('安装', h.rows()[0]).disabled, false);
  assert.equal(h.pendingTimers.size, 0);
});

test('任务消失时停止旧轮询并解除按钮锁定', async t => {
  const h = await harness({ environment: environment({ job: task() }) }); t.after(h.close);
  await h.click('运行环境', h.root.querySelector('[role="tablist"]'));
  await h.click('继续查看进度'); assert.equal(h.pendingTimers.size, 1);
  h.state.environment.job = null;
  await h.click('刷新组件状态');
  assert.equal(h.pendingTimers.size, 0);
  assert.doesNotMatch(h.root.textContent, /软件包任务 · 正在执行/);
  assert.equal(h.button('检查更新', h.rows()[0]).disabled, false);
});

test('后台安装进度更新不会重建其他页的搜索框或丢失焦点', async t => {
  const h = await harness({ environment: environment({ job: task() }) }); t.after(h.close);
  await h.click('运行环境', h.root.querySelector('[role="tablist"]')); await h.click('继续查看进度');
  await h.click('设备发现', h.root.querySelector('[role="tablist"]'));
  const input = await h.search('Pixel'); input.focus();
  await h.tick();
  assert.equal(h.window.document.activeElement, input);
  assert.equal(h.root.querySelector('input[type="search"]'), input);
  assert.equal(input.value, 'Pixel');
});

test('授权创建默认仅选择两种列表，并只在成功后展示一次性密钥', async t => {
  const h = await harness({ authorization: auth({ state: 'absent' }) }); t.after(h.close);
  h.queue('auth create 5', state => { state.authorization = auth(); return { ...state.authorization, password: 'b'.repeat(64), message: '创建完成' }; });
  await h.click('接口授权', h.root.querySelector('[role="tablist"]')); await h.click('创建客户端授权');
  const checked = [...h.window.document.querySelectorAll('.luci-modal input:checked')].map(el => Number(el.value));
  assert.deepEqual(checked, [1, 4]);
  await h.click('生成访问凭据');
  assert.ok(h.calls.includes('auth create 5'));
  assert.equal(h.window.document.querySelector('.ed-secret').textContent, 'b'.repeat(64));
  await h.click('已保存，关闭');
  assert.equal(h.window.document.querySelector('.ed-secret'), null);
  assert.equal(h.window.document.body.textContent.includes('b'.repeat(64)), false);
});

test('授权操作失败不展示密钥，并回读暂停状态限制后续编辑', async t => {
  const h = await harness({ authorization: auth({ state: 'absent' }) }); t.after(h.close);
  h.queue('auth create 5', state => {
    state.authorization = auth({ suspended: true, recovery_required: true });
    return { status: 'error', message: '专用账号会话清理失败', recovery_required: true, error: { code: 'session_cleanup_failed' } };
  });
  await h.click('接口授权', h.root.querySelector('[role="tablist"]')); await h.click('创建客户端授权'); await h.click('生成访问凭据');
  assert.match(h.root.textContent, /专用账号会话清理失败/);
  assert.match(h.root.textContent, /账号已暂停/);
  assert.equal(h.window.document.querySelector('.ed-secret'), null);
  assert.equal(h.button('编辑权限').disabled, true);
  assert.equal(h.button('重新生成密钥').disabled, false);
  assert.equal(h.button('撤销授权').disabled, false);
});

test('后端状态返回不可解析 JSON 时显示错误并保持页面可用', async t => {
  const h = await harness(); t.after(h.close);
  h.queue('auth status', { __rawExec: { code: 0, stdout: 'not JSON', stderr: '' } });
  await h.click('接口授权', h.root.querySelector('[role="tablist"]')); await h.click('刷新授权状态');
  assert.match(h.root.textContent, /授权状态读取失败：后端没有返回有效的 JSON 结果/);
  assert.equal(h.button('刷新授权状态').disabled, false);
});

for (const code of ['auth_suspended', 'auth_unavailable']) {
  test(code + ' 返回空结果时清除页面旧快照', async t => {
    const h = await harness(); t.after(h.close);
    h.queue('devices.list', snapshot([], { status: 'error', has_snapshot: false, scanned_at: null,
      errors: [{ source: 'auth', code, message: '授权状态暂不可用' }], message: '发现接口已暂时锁定' }));
    await h.click('刷新列表');
    assert.match(h.root.textContent, /发现接口已暂时锁定/);
    assert.doesNotMatch(h.rows()[0].textContent, /Pixel 8/);
    assert.equal(h.calls.filter(key => key.endsWith('.scan')).length, 0);
  });
}
