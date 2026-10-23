#!/usr/bin/env python3
"""Isolated behavior tests of the real auth/environment shell and session helper.

UCI, jshn, OpenSSL, BusyBox ash and ucode run natively. Only absolute storage
paths/host uid guards are relocated in temporary script copies. ubus transport,
package manager and init services are stateful test doubles. No host /etc files,
package installs, service operations, or network scans are performed.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--runtime', required=True, type=Path)
parser.add_argument('--ucode', required=True, type=Path)
parser.add_argument('--busybox', default=shutil.which('busybox'), type=Path)
ARGS = parser.parse_args()
ARGS.runtime = ARGS.runtime.resolve()
ARGS.ucode = ARGS.ucode.resolve()
if not ARGS.busybox or not ARGS.busybox.is_file():
    raise SystemExit('BusyBox (ash) is required; install the CI busybox dependency')
ARGS.busybox = ARGS.busybox.resolve()
for path in [ARGS.ucode, ARGS.runtime/'bin/uci', ARGS.runtime/'bin/jshn', ARGS.runtime/'share/libubox/jshn.sh']:
    if not path.is_file(): raise SystemExit(f'Missing test dependency: {path}')

ADMIN = 'a' * 32
CLIENT = 'b' * 32
OTHER = 'c' * 32
PERMISSIONS = ('deviceList', 'deviceScan', 'adbList', 'adbScan')

MOCK = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['ED_TEST_PACKAGE_STATE'])
s = json.loads(p.read_text())
kind, args = sys.argv[1], sys.argv[2:]
def save(): p.write_text(json.dumps(s))
def fail(code=1): save(); raise SystemExit(code)
if kind == 'pidof':
    target = {'avahi-daemon':'avahi','dbus-daemon':'dbus'}.get(args[0])
    if target in s['running']: print(12345); raise SystemExit(0)
    raise SystemExit(1)
if kind == 'service':
    target, action = args
    s['commands'].append(['service',target,action])
    if action == 'enabled': fail(0 if target in s['enabled'] else 1)
    field = 'enabled' if action in ('enable','disable') else 'running'
    if action in ('start','restart','enable') and target not in s[field]: s[field].append(target)
    if action in ('stop','disable') and target in s[field]: s[field].remove(target)
    save(); raise SystemExit(0)
if kind != 'apk': raise SystemExit(2)
if args[:2] == ['info','-e']: raise SystemExit(0 if args[2] in s['installed'] else 1)
if args[:3] == ['list','--installed','--manifest']:
    if args[3] in s['installed']: print(args[3]+' 1.0-r1')
    raise SystemExit(0)
s['commands'].append(['apk']+args)
plan = bool(args and args[0] == '--simulate')
if plan: args = args[1:]
verb, packages = args[0], args[1:]
if verb not in ('add','upgrade','del'): fail(2)
if plan:
    if s.get('plan_error'): print('repository unavailable'); fail(1)
    for package in packages: print('(1/1) '+('Purging' if verb=='del' else 'Installing')+' '+package+' (1.0-r1)')
    if verb=='del' and s.get('cascade'): print('(2/2) Purging unrelated-service (1.0-r1)')
else:
    if s.get('apply_error'): print('package download failed'); fail(1)
    for package in packages:
        if verb=='del' and package in s['installed']: s['installed'].remove(package)
        if verb=='add' and package not in s['installed']: s['installed'].append(package)
save()
'''


class Backend(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='easy-discovery-backend-test-')
        self.base = Path(self.temp.name)
        self.bin = self.base/'bin'
        self.config = self.base/'etc/config'
        self.delta = self.base/'delta'
        for p in (self.bin, self.config, self.delta, self.base/'tmp', self.base/'etc/init.d'):
            p.mkdir(parents=True, exist_ok=True)
        self.env = os.environ.copy()
        self.env.update(ED_TEST_SESSION_STATE=str(self.base/'sessions.json'),
                        ED_TEST_RPCD_CONFIG=str(self.config/'rpcd'),
                        ED_TEST_PACKAGE_STATE=str(self.base/'packages.json'))
        self.write(self.config/'rpcd', "config login 'admin'\n option username 'root'\n option password '$p$root'\n list read '*'\n list write '*'\n")
        self.write(self.config/'easy-discovery', "config discovery 'settings'\n list network 'lan'\n option arp_scan '0'\n")
        self.sessions = {'sessions': [
            {'ubus_rpc_session':'0'*32,'data':{}},
            {'ubus_rpc_session':ADMIN,'data':{'username':'root'}},
            {'ubus_rpc_session':OTHER,'data':{'username':'other-app'}}], 'destroyed':[]}
        self.save_sessions()
        self.packages = {'installed':['avahi-dbus-daemon','avahi-utils','dbus','arp-scan'],
                         'running':[], 'enabled':[], 'commands':[]}
        self.save_packages()
        self.write(self.bin/'uci', '#!/bin/sh\nexec '+shlex.quote(str(ARGS.runtime/'bin/uci'))+' -c '+shlex.quote(str(self.config))+' -t '+shlex.quote(str(self.delta))+' "$@"\n', True)
        self.write(self.bin/'mock.py', MOCK, True)
        for name in ('apk','pidof'):
            self.write(self.bin/name, '#!/bin/sh\nexec '+shlex.quote(shutil.which('python3'))+' '+shlex.quote(str(self.bin/'mock.py'))+' '+name+' "$@"\n', True)
        for name in ('avahi-daemon','avahi-browse','dbus-daemon','arp-scan'):
            self.write(self.bin/name, '#!/bin/sh\nexit 0\n', True)
        for component,name in [('avahi','avahi-daemon'),('dbus','dbus')]:
            self.write(self.base/'etc/init.d'/name, '#!/bin/sh\nexec '+shlex.quote(shutil.which('python3'))+' '+shlex.quote(str(self.bin/'mock.py'))+' service '+component+' "$@"\n', True)
        fake = ROOT/'tests/backend/fake-ubus.uc'
        helper = (ROOT/'root/usr/share/easy-discovery/auth/sessions.uc').read_text()
        self.write(self.base/'sessions.uc', helper.replace("from 'ubus'", 'from '+json.dumps(str(fake))))
        mappings = {
            '/usr/share/libubox/jshn.sh': str(ARGS.runtime/'share/libubox/jshn.sh'),
            '/usr/share/easy-discovery/auth/sessions.uc': str(self.base/'sessions.uc'),
            '/usr/share/easy-discovery/environment.sh': str(self.base/'environment.sh'),
            '/usr/libexec/luci-easy-discovery-job': str(self.base/'job'),
            '/usr/bin/ucode': str(ARGS.ucode),
            '/sbin/uci': str(self.bin/'uci'),
            '/etc/config': str(self.config),
            '/etc/init.d': str(self.base/'etc/init.d'),
            '/tmp/': str(self.base/'tmp')+'/',
        }
        # Replace longest source literals in a single regex pass. Replacing
        # recursively could accidentally alter temporary paths beginning /tmp.
        pattern = re.compile('|'.join(re.escape(k) for k in sorted(mappings,key=len,reverse=True)))
        for source,target in [
            ('root/usr/libexec/luci-easy-discovery-auth','auth'),
            ('root/usr/share/easy-discovery/environment.sh','environment.sh'),
            ('root/usr/libexec/luci-easy-discovery','environment'),
            ('root/usr/libexec/luci-easy-discovery-job','job')]:
            text = pattern.sub(lambda m:mappings[m[0]], (ROOT/source).read_text())
            text = text.replace('#!/bin/sh', '#!'+str(ARGS.busybox)+' ash', 1)
            text = text.replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin',
                                'PATH='+str(self.bin)+':'+str(ARGS.runtime/'bin')+':/usr/sbin:/usr/bin:/sbin:/bin')
            # BusyBox ash may prefer its own pidof applet over PATH, so bind
            # this external process-inspection boundary explicitly to the fake.
            text = text.replace('pidof avahi-daemon',str(self.bin/'pidof')+' avahi-daemon')
            text = text.replace('pidof dbus-daemon',str(self.bin/'pidof')+' dbus-daemon')
            # Adapt only owner identity to the unprivileged CI user. Production
            # root access enforcement itself is outside these isolated tests.
            text = text.replace('"$(id -u)" = 0', '"$(id -u)" = '+str(os.getuid()))
            text = text.replace('"$_ed_owner" = 0', '"$_ed_owner" = '+str(os.getuid()))
            text = text.replace("awk '{ print $3 }')\" = 0", "awk '{ print $3 }')\" = "+str(os.getuid()))
            self.write(self.base/target, text, True)

    def tearDown(self): self.temp.cleanup()
    def write(self,path,text,executable=False):
        path.write_text(text);path.chmod(0o700 if executable else 0o600)
    def save_sessions(self): self.write(self.base/'sessions.json',json.dumps(self.sessions))
    def save_packages(self): self.write(self.base/'packages.json',json.dumps(self.packages))
    def read_sessions(self): return json.loads((self.base/'sessions.json').read_text())
    def read_packages(self): return json.loads((self.base/'packages.json').read_text())
    def call(self,kind,*args,ok=True):
        p=subprocess.run([str(ARGS.busybox),'ash',str(self.base/kind),*args],env=self.env,capture_output=True,text=True,timeout=12)
        self.assertEqual(p.returncode,0 if ok else 1,(kind,args,p.stderr,p.stdout))
        try: return json.loads(p.stdout)
        except ValueError: self.fail(f'{kind} returned invalid JSON: {p.stdout!r}; stderr={p.stderr!r}')
    def uci(self,*args):
        p=subprocess.run([str(self.bin/'uci'),*args],env=self.env,capture_output=True,text=True,check=True)
        return p.stdout.strip()
    def client_session(self):
        self.sessions=self.read_sessions()
        self.sessions['sessions'].append({'ubus_rpc_session':CLIENT,'data':{'username':'easyadb'}})
        self.save_sessions()
    def legacy(self):
        digest=subprocess.run(['openssl','passwd','-6','-stdin'],input='fixture-only-secret\n',capture_output=True,text=True,check=True).stdout.strip()
        with (self.config/'rpcd').open('a') as f:
            f.write("\nconfig login 'easyadb'\n option username 'easyadb'\n option password '"+digest+"'\n list read 'luci-avahi-easyadb'\n")
        return digest
    def assert_only_client_destroyed(self):
        state=self.read_sessions()
        self.assertEqual(state['destroyed'],[CLIENT])
        self.assertEqual({s['ubus_rpc_session'] for s in state['sessions']},{'0'*32,ADMIN,OTHER})
        self.assertEqual(state['gates'],[True])

    def test_create_readonly_and_status_secret_absence(self):
        result=self.call('auth','create','5')
        self.assertRegex(result['password'],r'^[0-9a-f]{64}$')
        self.assertEqual(result['permissions'],dict(zip(PERMISSIONS,[True,False,True,False])))
        self.assertFalse(result['legacy_adb_scan'])
        status=self.call('auth','status')
        self.assertNotIn('password',status)
        self.assertNotIn(result['password'],(self.config/'rpcd').read_text())
        self.assertRegex(self.uci('get','rpcd.easyadb.password'),r'^\$6\$')

    def test_all_permission_masks(self):
        self.call('auth','create','1')
        for mask in range(1,16):
            with self.subTest(mask=mask):
                result=self.call('auth','permissions',str(mask))
                self.assertEqual(result['permissions'],{p:bool(mask&(1<<i)) for i,p in enumerate(PERMISSIONS)})
                self.assertEqual(result['legacy_adb_scan'],bool(mask&8))

    def test_invalid_mask_and_conflict_preserve_configuration(self):
        before=(self.config/'rpcd').read_bytes()
        for value in ('0','16','1;touch /tmp/unsafe','01'):
            self.assertEqual(self.call('auth','create',value,ok=False)['error']['code'],'invalid_argument')
            self.assertEqual((self.config/'rpcd').read_bytes(),before)
        self.legacy(); self.uci('add_list','rpcd.easyadb.write=*'); self.uci('commit','rpcd')
        before=(self.config/'rpcd').read_bytes()
        self.assertEqual(self.call('auth','rotate',ok=False)['error']['code'],'configuration_conflict')
        self.assertEqual((self.config/'rpcd').read_bytes(),before)

    def test_legacy_rotation_preserves_roles_and_only_revokes_client(self):
        previous=self.legacy();self.client_session()
        result=self.call('auth','rotate')
        self.assertTrue(result['legacy_only']);self.assertFalse(any(result['permissions'].values()))
        self.assertEqual(self.uci('get','rpcd.easyadb.read'),'luci-avahi-easyadb')
        self.assertNotEqual(previous,self.uci('get','rpcd.easyadb.password'))
        self.assert_only_client_destroyed()

    def test_permission_reduction_revokes_existing_client(self):
        self.call('auth','create','15');self.client_session()
        original=self.uci('get','rpcd.easyadb.password')
        result=self.call('auth','permissions','1')
        self.assertFalse(result['legacy_adb_scan'])
        self.assertEqual(self.uci('get','rpcd.easyadb.password'),original)
        self.assert_only_client_destroyed()

    def test_cleanup_failure_stays_suspended_and_rotation_recovers(self):
        self.call('auth','create','15');self.client_session()
        self.sessions=self.read_sessions();self.sessions['fail_destroy']=True;self.save_sessions()
        result=self.call('auth','permissions','1',ok=False)
        self.assertTrue(result['recovery_required'])
        self.assertEqual(self.uci('get','rpcd.easyadb.password'),'!')
        self.assertTrue(self.call('auth','status')['suspended'])
        self.assertEqual(self.call('auth','permissions','1',ok=False)['error']['code'],'recovery_required')
        self.sessions=self.read_sessions();self.sessions['fail_destroy']=False;self.save_sessions()
        recovered=self.call('auth','rotate')
        self.assertFalse(recovered['suspended']);self.assertTrue(all(recovered['permissions'].values()))
        self.assertEqual({s['ubus_rpc_session'] for s in self.read_sessions()['sessions']},{'0'*32,ADMIN,OTHER})

    def test_revoke_keeps_other_accounts_and_sessions(self):
        self.legacy();self.client_session()
        self.assertEqual(self.call('auth','revoke')['state'],'absent')
        self.assertEqual(self.uci('get','rpcd.admin.username'),'root')
        self.assert_only_client_destroyed()

    def test_invalid_session_reply_preserves_config_before_gate(self):
        self.legacy();before=(self.config/'rpcd').read_bytes()
        self.sessions['malformed']=True;self.save_sessions()
        self.assertEqual(self.call('auth','rotate',ok=False)['error']['code'],'session_unavailable')
        self.assertEqual((self.config/'rpcd').read_bytes(),before)

    def test_pending_uci_changes_are_not_committed_or_discarded(self):
        self.legacy();before=(self.config/'rpcd').read_bytes()
        self.uci('set','rpcd.admin.label=waiting')
        self.assertEqual(self.call('auth','rotate',ok=False)['error']['code'],'pending_changes')
        self.assertEqual((self.config/'rpcd').read_bytes(),before)
        self.assertIn('waiting',self.uci('changes','rpcd'))

    def test_environment_install_run_and_autostart_are_separate(self):
        status=self.call('environment','status')
        avahi=next(c for c in status['components'] if c['id']=='avahi')
        self.assertEqual(avahi['installed'],'installed');self.assertFalse(avahi['running']);self.assertFalse(avahi['enabled'])
        self.call('environment','service','avahi','start')
        self.assertEqual(self.read_packages()['running'],['dbus','avahi'])
        self.assertEqual(self.read_packages()['enabled'],[])
        self.call('environment','service','avahi','enable')
        self.assertEqual(self.read_packages()['enabled'],['dbus','avahi'])

    def test_dependency_removal_preconditions(self):
        self.packages['running']=['dbus','avahi'];self.save_packages()
        for name in ('avahi','dbus'):
            self.assertEqual(self.call('environment','package','plan','remove',name,ok=False)['error']['code'],'dependency_in_use')
        self.call('environment','discovery','arp','1')
        self.assertEqual(self.call('environment','package','plan','remove','arp',ok=False)['error']['code'],'dependency_in_use')
        (self.bin/'arp-scan').unlink()
        self.call('environment','discovery','arp','0')
        self.assertEqual(self.uci('get','easy-discovery.settings.arp_scan'),'0')

    def test_remove_plan_rejects_dependency_cascade(self):
        self.packages['cascade']=True;self.save_packages()
        self.assertEqual(self.call('environment','package','plan','remove','avahi',ok=False)['error']['code'],'dependency_in_use')
        self.assertFalse(any(c[:2]==['apk','del'] for c in self.read_packages()['commands']))

    def test_package_background_success_and_failure(self):
        for should_fail in (False,True):
            with self.subTest(fail=should_fail):
                self.packages=self.read_packages();self.packages['apply_error']=should_fail;self.save_packages()
                job=self.call('environment','package','apply','install','arp')['job']
                deadline=time.monotonic()+8
                while job['state']=='running' and time.monotonic()<deadline:
                    time.sleep(.05)
                    job=self.call('environment','package','job',job['id'])['job']
                self.assertEqual(job['state'],'failed' if should_fail else 'succeeded')
                if should_fail:self.assertIn('package download failed',job['output'])
                deadline=time.monotonic()+2
                while (self.base/'tmp/easy-discovery/environment/operation.lock').exists() and time.monotonic()<deadline:time.sleep(.02)
                self.assertFalse((self.base/'tmp/easy-discovery/environment/operation.lock').exists())

    def test_interrupted_job_is_reported_failed(self):
        state=self.base/'tmp/easy-discovery/environment';state.mkdir(parents=True)
        jobid='d'*32;job=state/('job-'+jobid);job.mkdir()
        for name,value in {'state':'running','action':'install','component':'arp','pid':'2147483647','message':'pending','output':''}.items():self.write(job/name,value)
        result=self.call('environment','package','job',jobid)
        self.assertEqual(result['job']['state'],'failed')


if __name__=='__main__':
    unittest.main(argv=[__file__],verbosity=2)
