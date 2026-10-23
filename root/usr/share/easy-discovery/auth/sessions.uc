// SPDX-License-Identifier: Apache-2.0
// This helper has no external ACL. The owner invokes it locally after closing
// the easyadb login gate. Session IDs and their ACL/data are never printed.
import { connect } from 'ubus';

const USERNAME = 'easyadb';
const DEFAULT_SESSION = '00000000000000000000000000000000';
const MAX_SESSIONS = 1024;
const MAX_SECONDS = 15;
const mode = ARGV[0];
let conn = null;

function fail(code, message) {
    printf('%J\n', { status: 'error', error: { code, message }, message });
    if (conn)
        conn.disconnect();
    exit(1);
}

if (length(ARGV) != 1 || (mode != 'inspect' && mode != 'clear'))
    fail('invalid_argument', '无效的会话管理操作');

conn = connect(null, 3);
if (!conn)
    fail('session_unavailable', '无法连接会话管理服务');

const started = time();

function read_targets() {
    // true requests all replies; default call() would keep only the first one.
    const replies = conn.call('session', 'list', {}, true);
    if (conn.error(true) || type(replies) != 'array' || !length(replies))
        fail('session_list_failed', '无法完整枚举 RPCD 会话');
    if (length(replies) > MAX_SESSIONS)
        fail('session_limit', '会话数量超过安全处理上限');

    let targets = [];
    let seen = {};
    for (let reply in replies) {
        if (type(reply) != 'object' || type(reply.ubus_rpc_session) != 'string' ||
            !match(reply.ubus_rpc_session, /^[0-9a-fA-F]{32}$/) ||
            type(reply.data) != 'object')
            fail('session_shape', 'RPCD 会话返回格式异常');
        if (reply.data.username != USERNAME)
            continue;
        const sid = reply.ubus_rpc_session;
        if (sid == DEFAULT_SESSION || seen[sid])
            fail('session_identity', 'RPCD 会话标识异常');
        seen[sid] = true;
        push(targets, sid);
    }
    return targets;
}

const targets = read_targets();
if (mode == 'inspect') {
    printf('%J\n', { status: 'ok', target_sessions: length(targets) });
    conn.disconnect();
    exit(0);
}

let destroyed = 0;
for (let sid in targets) {
    if (time() - started > MAX_SECONDS)
        fail('session_timeout', '清理专用账号会话超时');
    conn.call('session', 'destroy', { ubus_rpc_session: sid });
    const err = conn.error(true);
    // A session can expire between enumeration and destruction. NOT_FOUND is
    // safe, but only the final complete enumeration proves that cleanup ended.
    if (err && err != 4)
        fail('session_destroy_failed', '销毁专用账号会话失败');
    if (!err)
        destroyed++;
}

if (length(read_targets()))
    fail('session_remains', '专用账号仍有残留会话，保持暂停登录');

printf('%J\n', { status: 'ok', destroyed_sessions: destroyed });
conn.disconnect();
