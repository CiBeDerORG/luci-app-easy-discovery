// SPDX-License-Identifier: Apache-2.0
// Test transport only. The production sessions.uc is executed unchanged except
// that its ubus import points here. No real ubus socket is opened.
import { readfile, writefile } from 'fs';

export function connect() {
    const path = getenv('ED_TEST_SESSION_STATE');
    const configPath = getenv('ED_TEST_RPCD_CONFIG');
    let state = json(readfile(path)), errorCode = 0;
    function save() { writefile(path, sprintf('%J', state)); }
    if (state.connection_error) return null;
    return {
        call: function(object, method, args, multiple) {
            errorCode = 0;
            if (object != 'session') { errorCode = 3; return null; }
            if (method == 'list') {
                state.list_calls = (state.list_calls || 0) + 1;
                save();
                if (state.list_error) { errorCode = 7; return null; }
                if (state.malformed) return [ { data: {} } ];
                return multiple ? state.sessions : state.sessions[0];
            }
            if (method == 'destroy') {
                state.destroyed ??= [];
                push(state.destroyed, args.ubus_rpc_session);
                state.gates ??= [];
                push(state.gates, !!match(readfile(configPath) || '', /easy_discovery_suspended\s+'1'/));
                if (state.fail_destroy) { errorCode = 6; save(); return null; }
                if (!state.keep_sessions)
                    state.sessions = filter(state.sessions, s => s.ubus_rpc_session != args.ubus_rpc_session);
                save();
                return {};
            }
            errorCode = 3;
            return null;
        },
        error: function() { let value = errorCode; errorCode = 0; return value; },
        disconnect: function() {}
    };
}
