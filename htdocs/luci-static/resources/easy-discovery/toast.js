'use strict';
'require baseclass';

var layer = null;
var entries = [];

function clear() {
	entries.slice().forEach(function(entry) { entry.close(); });
	if (layer) layer.remove();
	layer = null;
}

function ensureLayer() {
	if (!document.getElementById('easy-discovery-toast-style'))
		document.head.appendChild(E('link', {id: 'easy-discovery-toast-style', rel: 'stylesheet', href: L.resource('easy-discovery/toast.css')}));
	// A native dialog is in the browser top layer; keep its copy feedback visible.
	var host = document.querySelector('dialog[open]') || document.body;
	if (!layer || !layer.isConnected || layer.parentNode !== host) {
		clear();
		layer = E('div', {'class': 'ed-root ed-toast-layer', 'aria-label': '操作提示'});
		host.appendChild(layer);
	}
	return layer;
}

function show(message, warning) {
	var host = ensureLayer(), value = String(message), duration = warning ? 6000 : 4000;
	var previous = entries.filter(function(entry) { return entry.message === value && entry.warning === !!warning; })[0];
	if (previous) { previous.restart(); return previous.node; }
	while (entries.length >= 3) entries[0].close();
	var timer = null, closed = false, entry;
	var close = function() {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		node.remove();
		entries = entries.filter(function(item) { return item !== entry; });
	};
	var restart = function() { clearTimeout(timer); timer = setTimeout(close, duration); };
	var node = E('div', {'class': 'ed-toast ' + (warning ? 'warning' : 'success')}, [
		E('span', {'class': 'ed-toast-symbol', 'aria-hidden': 'true'}, [warning ? '!' : '✓']),
		E('span', {'class': 'ed-toast-message', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'}, [value]),
		E('button', {type: 'button', 'class': 'ed-toast-close', 'aria-label': '关闭提示', click: close}, ['×'])
	]);
	// All text is inserted as text nodes; discovered names can never become HTML.
	entry = {node: node, message: value, warning: !!warning, close: close, restart: restart};
	entries.push(entry);
	host.appendChild(node);
	restart();
	return node;
}

window.addEventListener('pagehide', clear);
return baseclass.extend({show: show, clear: clear});
