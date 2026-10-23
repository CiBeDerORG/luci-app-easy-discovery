#!/usr/bin/env python3
"""Isolated discovery normalization checks. No ubus, scans or router writes.

Usage: python3 tests/discovery-fixtures.py /path/to/ucode
The supplied ucode must have its fs module available.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FORMAT = ROOT / "root/usr/share/easy-discovery/discovery/format.uc"
UCODE = sys.argv[1] if len(sys.argv) == 2 else "ucode"


def call(action, work, *args, expected=0):
    proc = subprocess.run(
        [UCODE, str(FORMAT), action, str(work), *map(str, args)],
        capture_output=True, text=True, timeout=8, check=False,
    )
    assert proc.returncode == expected, (action, proc.returncode, proc.stderr)
    return json.loads(proc.stdout) if action != "arp-plan" else proc.stdout


def write(work, name, value, rc=None):
    (work / name).write_text(json.dumps(value) if isinstance(value, (dict, list)) else value)
    if rc is not None:
        (work / (name + ".rc")).write_text(str(rc))


def scope(work, networks=None):
    networks = networks or [{"name": "lan", "iface": "br-lan", "ipv4": [{"address": "192.168.1.1", "mask": 24}],
                             "ipv6": [{"address": "fd00::1", "mask": 64}], "own": ["192.168.1.1", "fd00::1"]}]
    value = {"networks": networks, "arp_enabled": False}
    write(work, "scope.json", value)
    return value


def sources(work):
    write(work, "neighbors4", "", 0)
    write(work, "neighbors6", "", 0)
    write(work, "leases", {"dhcp_leases": [], "dhcp6_leases": []}, 0)
    write(work, "host-hints", {}, 0)


with tempfile.TemporaryDirectory(prefix="easy-discovery-fixtures-") as temp:
    work = Path(temp)
    old = work / "previous.json"
    scope(work)
    sources(work)

    # Out-of-scope WAN, invalid ports, duplicate endpoints, IPv4/IPv6 mismatch.
    line = r"=;br-lan;IPv4;Phone\032A\059test;_adb-tls-connect._tcp;local;phone.local;192.168.1.21;37001;"
    write(work, "adb", "\n".join([
        line, line,
        "=;eth-wan;IPv4;WAN;_adb-tls-connect._tcp;local;wan.local;192.168.1.22;37001;",
        "=;br-lan;IPv4;BadPort;_adb-tls-connect._tcp;local;bad.local;192.168.1.22;65536;",
        "=;br-lan;IPv6;BadFamily;_adb-tls-connect._tcp;local;bad.local;192.168.1.22;37001;",
    ]))
    adb = call("adb", work)
    assert adb["count"] == 1 and adb["devices"][0]["instance"] == "Phone A;test"
    assert adb["status"] == "ok" and adb["has_snapshot"] is True
    write(work, "adb", "\n".join(
        f"=;br-lan;IPv4;Phone{i};_adb-tls-connect._tcp;local;p.local;192.168.1.{i+2};37001;" for i in range(40)
    ))
    capped = call("adb", work)
    assert capped["count"] == 32 and capped["truncated"] is True

    # Production captures each selected interface separately and combines them.
    (work / "adb").unlink()
    write(work, "adb-1", line, 124)
    write(work, "adb-2", line, 0)
    scoped_adb = call("adb", work)
    assert scoped_adb["count"] == 1

    # Same MAC has several addresses; stale hints and leases do not imply online.
    write(work, "neighbors4", "192.168.1.21 dev br-lan lladdr 02:11:22:33:44:55 REACHABLE\n", 0)
    write(work, "neighbors6", "fd00:0:0:0:0:0:0:21 dev br-lan lladdr 02:11:22:33:44:55 STALE\n", 0)
    write(work, "leases", {"dhcp_leases": [
        {"ipaddr": "192.168.1.21", "macaddr": "02:11:22:33:44:55", "hostname": "phone"},
        {"ipaddr": "192.168.1.50", "macaddr": "06:11:22:33:44:66", "hostname": "lease-only"},
    ], "dhcp6_leases": []}, 0)
    collected = call("devices", work, old)
    assert collected["count"] == 2
    phone = next(d for d in collected["devices"] if d["mac"] == "02:11:22:33:44:55")
    lease = next(d for d in collected["devices"] if d["name"] == "lease-only")
    assert phone["ipv6"] == ["fd00::21"] and phone["observation"] == "recent"
    assert lease["observation"] == "lease" and lease["last_seen"] is None
    assert lease["model"] is None and lease["vendor"] is None

    # A zero process status with invalid JSON is a source failure. File fallback
    # still provides lease records, while partial/error diagnostics stay honest.
    write(work, "leases", "{invalid", 0)
    write(work, "host-hints", "[]", 0)
    write(work, "dhcp-file", "0 06:11:22:33:44:66 192.168.1.50 fallback-host *\n", 0)
    recovered = call("devices", work, old)
    source_status = {s["source"]: s["status"] for s in recovered["sources"]}
    assert recovered["status"] == "partial"
    assert source_status["dhcp"] == source_status["host-hints"] == "error"
    assert source_status["dhcp-file"] == "ok"
    assert any(d["name"] == "fallback-host" and d["last_seen"] is None for d in recovered["devices"])
    (work / "dhcp-file").unlink()
    (work / "dhcp-file.rc").unlink()
    write(work, "leases", {"dhcp_leases": [], "dhcp6_leases": []}, 0)
    write(work, "host-hints", {}, 0)

    # Explicit TXT manufacturer/model enrich known devices; semicolons remain data.
    write(work, "mdns", '=;br-lan;IPv4;Device;_device-info._tcp;local;phone.local;192.168.1.21;9;"model=Example; Model" "manufacturer=Example Corp"\n', 0)
    enriched = call("devices", work, old)
    phone = next(d for d in enriched["devices"] if d["mac"] == "02:11:22:33:44:55")
    assert phone["model"] == "Example; Model" and phone["vendor"] == "Example Corp"
    assert phone["model_source"] == "mdns:_device-info._tcp"

    # Failure response returns old time and data; list is a pure snapshot read.
    write(work, "previous.json", enriched)
    before = old.read_bytes()
    listed = call("list", old, "devices")
    failed = call("error", old, "unavailable", "source failed", "devices")
    assert listed["scanned_at"] == enriched["scanned_at"]
    assert failed["status"] == "error" and failed["scanned_at"] == enriched["scanned_at"]
    assert old.read_bytes() == before
    for name in ["neighbors4", "neighbors6", "leases", "host-hints", "mdns"]:
        write(work, name, "", 1)
    all_failed = call("devices", work, old, expected=3)
    assert all_failed["status"] == "error" and all_failed["scanned_at"] == enriched["scanned_at"]

    # Identical IP/MAC in two network scopes are never merged.
    networks = [
        {"name": n, "iface": i, "ipv4": [{"address": "192.168.1.1", "mask": 24}], "ipv6": [], "own": ["192.168.1.1"]}
        for n, i in [("lan", "br-lan"), ("guest", "br-guest")]
    ]
    scope(work, networks)
    sources(work)
    (work / "mdns.rc").unlink()
    write(work, "neighbors4", "192.168.1.21 dev br-lan lladdr 02:11:22:33:44:55 REACHABLE\n192.168.1.21 dev br-guest lladdr 02:11:22:33:44:55 REACHABLE\n", 0)
    scoped = call("devices", work, work / "absent.json")
    assert scoped["count"] == 2 and len({d["id"] for d in scoped["devices"]}) == 2
    write(work, "networks", "lan wan\n")
    write(work, "arp-enabled", "0\n")
    write(work, "interfaces", {"interface": [
        {"interface": n, "up": True, "l3_device": i, "ipv4-address": [{"address": a, "mask": 24}]}
        for n, i, a in [("lan", "br-lan", "192.168.1.1"), ("wan", "eth0", "192.0.2.1")]
    ]})
    topology = call("scope", work)
    assert [n["name"] for n in topology["networks"]] == ["lan"]
    assert call("arp-plan", work).splitlines() == ["br-lan 192.168.1.0/24", "br-guest 192.168.1.0/24"]

print("通过：发现范围、ADB 兼容上限、地址归一化、缓存语义、来源富化与失败保留。")
