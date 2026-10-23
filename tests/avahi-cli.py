#!/usr/bin/env python3
"""Exercise real ash and GNU/BusyBox timeout; never scan a real network.

The avahi-browse substitute accepts only the supported option combinations and
returns controlled output. No ubus, UCI, router service or package is modified.
"""
from pathlib import Path
import os
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
COMMON = ROOT / 'root/usr/share/easy-discovery/discovery/common.sh'
BUSYBOX = shutil.which('busybox')
TIMEOUT = shutil.which('timeout')
if not BUSYBOX or not TIMEOUT:
    raise SystemExit('需要安装 BusyBox 和 GNU timeout')

with tempfile.TemporaryDirectory(prefix='easy-discovery-avahi-cli-') as directory:
    work = Path(directory)
    binary = work / 'bin'
    binary.mkdir()
    avahi = binary / 'avahi-browse'
    avahi.write_text('''#!/usr/bin/env python3
import os, sys, time
from pathlib import Path
args = sys.argv[1:]
Path(os.environ['ARG_LOG']).write_text(' '.join(args))
if args not in [['-rp', '_adb-tls-connect._tcp'], ['-arp']]:
    sys.stderr.write('invalid option\\n')
    sys.exit(2)
mode = os.environ.get('SCENARIO', 'success')
if mode == 'failure':
    sys.stderr.write('Failed to create client: Daemon not running\\n')
    sys.exit(1)
if mode == 'early-signal':
    sys.exit(143)
if mode != 'empty-window':
    print('=;br-lan;IPv4;Phone;_adb-tls-connect._tcp;local;phone.local;192.168.1.21;37001;', flush=True)
if mode in ('window', 'empty-window'):
    time.sleep(30)
''')
    avahi.chmod(0o755)
    cases = 0
    for engine in ('gnu', 'busybox'):
        runner = binary / 'timeout'
        command = f'"{TIMEOUT}"' if engine == 'gnu' else f'"{BUSYBOX}" timeout'
        runner.write_text(f'#!/bin/sh\nexec {command} "$@"\n')
        runner.chmod(0o755)
        for kind in ('adb', 'mdns'):
            for scenario, expected in [('success', 0), ('failure', 1), ('early-signal', 143), ('window', 124)]:
                output = work / 'result'
                env = dict(os.environ, ARG_LOG=str(work / 'args'), SCENARIO=scenario)
                proc = subprocess.run([BUSYBOX, 'ash', '-ec',
                    '. "$1"; PATH="$2:$PATH"; export PATH; ed_browse "$3" 3 "$4"',
                    'case', str(COMMON), str(binary), str(output), kind], env=env,
                    capture_output=True, text=True, timeout=8)
                assert proc.returncode == 0, (engine, kind, scenario, proc.stderr)
                rc = int((work / 'result.rc').read_text())
                assert rc == expected, (engine, kind, scenario, rc)
                if scenario == 'failure':
                    assert 'Daemon not running' in (work / 'result.stderr').read_text()
                if scenario in ('success', 'window'):
                    assert '192.168.1.21;37001' in output.read_text()
                expected_args = '-rp _adb-tls-connect._tcp' if kind == 'adb' else '-arp'
                assert (work / 'args').read_text() == expected_args
                cases += 1
        # A completed observation window with no broadcasts is not a source error.
        env = dict(os.environ, ARG_LOG=str(work / 'args'), SCENARIO='empty-window')
        subprocess.run([BUSYBOX, 'ash', '-ec',
            '. "$1"; PATH="$2:$PATH"; export PATH; ed_browse "$3" 3 mdns',
            'case', str(COMMON), str(binary), str(work / 'result')], env=env,
            capture_output=True, text=True, timeout=8, check=True)
        assert int((work / 'result.rc').read_text()) == 124
        assert (work / 'result').read_text() == ''
        cases += 1

# Production entry points use one shared collector and retain the legacy window.
adb = (ROOT / 'root/usr/libexec/luci-easy-discovery-adb').read_text()
devices = (ROOT / 'root/usr/libexec/luci-easy-discovery-devices').read_text()
assert 'ed_browse "$ED_WORK/adb" 8 adb' in adb
assert 'ed_browse "$ED_WORK/mdns" 3 mdns' in devices
assert 'avahi-browse -i' not in adb + devices + COMMON.read_text()
print(f'通过：{cases} 个 Avahi 命令与超时用例；使用真实 BusyBox ash、GNU/BusyBox timeout。')
