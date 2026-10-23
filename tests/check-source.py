#!/usr/bin/env python3
"""Source syntax and capability-boundary checks; does not operate a router."""
from pathlib import Path
import ast
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
checks = {"shell": 0, "javascript": 0, "json": 0, "python": 0}
for directory in (ROOT / "root", ROOT / "htdocs", ROOT / "scripts", ROOT / "tests", ROOT / "ci"):
    for path in sorted(directory.rglob("*")):
        if not path.is_file() or "node_modules" in path.parts or "__pycache__" in path.parts:
            continue
        data = path.read_bytes()
        if data.startswith(b"#!/bin/sh"):
            subprocess.run(["sh", "-n", str(path)], check=True)
            checks["shell"] += 1
        if path.suffix in (".js", ".cjs"):
            subprocess.run(["node", "-e", 'new Function(require("fs").readFileSync(process.argv[1], "utf8"));', str(path)], check=True)
            checks["javascript"] += 1
        if path.suffix == ".json":
            json.loads(data)
            checks["json"] += 1
        if path.suffix == ".py":
            ast.parse(data, filename=str(path))
            checks["python"] += 1

acl = json.loads((ROOT / "root/usr/share/rpcd/acl.d/luci-app-easy-discovery.json").read_text())
for kind in ("devices", "adb"):
    for method in ("list", "scan"):
        role = acl[f"easy-discovery-{kind}-{method}"]
        assert role["read"] == {"ubus": {f"easy-discovery.{kind}": [method]}}
        assert not role.get("write"), "外部发现角色不得获得管理员写权限"
legacy = acl["luci-avahi-easyadb"]
assert legacy["read"] == {
    "ubus": {"file": ["exec"]},
    "file": {"/usr/libexec/luci-avahi-scan scan": ["exec"]},
}
assert not legacy.get("write"), "旧兼容角色不得扩权"
for scope in ("read", "write"):
    for command in acl["luci-app-easy-discovery"][scope]["file"]:
        executable = command.split(" ")[0]
        assert executable.startswith("/usr/libexec/") and (ROOT / "root" / executable[1:]).is_file()
        assert executable != "/usr/libexec/luci-easy-discovery-job", "后台执行器不得直接对外授权"
menu = json.loads((ROOT / "root/usr/share/luci/menu.d/luci-app-easy-discovery.json").read_text())
for entry in menu.values():
    action = entry.get("action", {})
    if action.get("type") == "view":
        assert (ROOT / "htdocs/luci-static/resources/view" / (action["path"] + ".js")).is_file()
for path in (ROOT / "htdocs").rglob("*.js"):
    for module in re.findall(r"'require (easy-discovery\.[a-z]+)(?: as [a-z]+)?';", path.read_text()):
        assert (ROOT / "htdocs/luci-static/resources" / (module.replace(".", "/") + ".js")).is_file()
print("通过：源码语法 " + json.dumps(checks, ensure_ascii=False))
print("通过：四项外部能力、旧兼容入口、管理员执行入口与 LuCI 资源契约")
