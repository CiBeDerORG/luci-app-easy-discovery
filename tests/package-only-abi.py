#!/usr/bin/env python3
"""Check package-only fallback decisions with the supplied SDK's real parser.

Usage: python3 tests/package-only-abi.py /path/to/sdk/scripts
No dependency is vendored; this runs the SDK metadata.pm through Perl.
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-package-only-abi.pl"
APP = "luci-app-easy-discovery"
DEPENDS = [
    "libc", "luci-base", "rpcd-mod-file", "rpcd-mod-luci", "jshn", "jsonfilter",
    "uhttpd-mod-ubus", "openssl-util", "ucode", "ucode-mod-fs", "ucode-mod-ubus", "ip",
]
EMPTY_HOOKS = """# Empty hooks for a script-only application.
define Build/Configure
endef

define Build/Compile
endef
"""


def record(name, *, depends="", provides="", abi=None, build=None, extra="", description="Fixture"):
    lines = [f"Source-Makefile: package/{name}/Makefile"]
    for kind, value in (build or {}).items():
        lines.append(f"Build-Depends{kind}: {value}")
    lines += [f"Package: {name}", "Version: 1", f"Depends: {depends}", f"Provides: {provides}"]
    if abi is not None:
        lines.append(f"ABI-Version: {abi}")
    if extra:
        lines.append(extra)
    lines += ["Type: ipkg", f"Description: {description}", "@@", ""]
    return "\n".join(lines)


def metadata(*, app_depends=None, direct_abi=None, virtual_abi=None, missing=None,
             with_app=True, with_abi=True, app_build=None, app_extra="", description="Fixture",
             virtual_provides="ip"):
    parts = []
    if with_app:
        parts.append(record(
            APP, depends=" ".join("+" + dep for dep in DEPENDS) if app_depends is None else app_depends,
            build=app_build, extra=app_extra,
        ))
    # A transitive ABI dependency must not prevent a script-only app from being
    # packaged. Each installed runtime package owns its own library constraints.
    if with_abi:
        parts.append(record("libucode", abi="20261009"))
    for name in DEPENDS:
        if name in ("ip", missing):
            continue
        parts.append(record(
            name, depends="+libucode" if name == "ucode" else "",
            abi=(direct_abi or {}).get(name), description=description,
        ))
    if missing != "ip":
        parts.append(record("ip-tiny", provides="ip"))
        parts.append(record("ip-full", provides=virtual_provides, abi=virtual_abi))
    return "\n".join(parts)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("用法：python3 tests/package-only-abi.py <SDK scripts 目录>")
    sdk_scripts = Path(sys.argv[1]).resolve()
    if not (sdk_scripts / "metadata.pm").is_file():
        raise SystemExit("SDK scripts 目录中缺少真实 metadata.pm")

    executions = 0
    with tempfile.TemporaryDirectory(prefix="easy-discovery-package-only-") as temp:
        work = Path(temp)

        def check(label, info, *, makefile=EMPTY_HOOKS, allowed=False, reason="", absent=None):
            nonlocal executions
            info_path = work / ".packageinfo"
            makefile_path = work / "Makefile"
            info_path.write_text(info, encoding="utf-8")
            makefile_path.write_text(makefile, encoding="utf-8")
            if absent == "info":
                info_path.unlink()
            if absent == "makefile":
                makefile_path.unlink()
            proc = subprocess.run(
                ["perl", "-I", str(sdk_scripts), str(CHECKER), str(info_path), str(makefile_path)],
                capture_output=True, text=True, encoding="utf-8", timeout=10, check=False,
            )
            executions += 1
            assert (proc.returncode == 0) == allowed, (label, proc.returncode, proc.stdout, proc.stderr)
            if allowed:
                assert "允许仅构建应用" in proc.stdout and not proc.stderr, (label, proc.stdout, proc.stderr)
            else:
                assert "回退完整依赖构建" in proc.stderr and not proc.stdout, (label, proc.stdout, proc.stderr)
                assert reason in proc.stderr, (label, reason, proc.stderr)

        check("当前应用及所有直接依赖", metadata(), allowed=True,
              makefile=(ROOT / "Makefile").read_text(encoding="utf-8"))
        check("空钩子允许注释和空白", metadata(), allowed=True,
              makefile=EMPTY_HOOKS.replace("define Build/Compile\n", "define Build/Compile\n\t# 不编译二进制\n \t\n"))
        check("SDK 解析器处理多行描述", metadata(description="Fixture\nPackage: fake\nABI-Version: 999"), allowed=True)
        check("虚拟提供项去除前导标记", metadata(virtual_provides="@ip"), allowed=True)
        check("直接依赖 ABI", metadata(direct_abi={"ucode": "20261009"}), reason="提供者 ucode 声明 ABI")
        check("ABI 零不能被视为未定义", metadata(direct_abi={"ucode": "0"}), reason="声明 ABI 0")
        check("虚拟依赖任一提供者有 ABI", metadata(virtual_abi="42"), reason="提供者 ip-full 声明 ABI 42")
        check("隐式 libc 直接依赖有 ABI", metadata(direct_abi={"libc": "7"}), reason="提供者 libc 声明 ABI")
        check("缺少直接依赖提供者", metadata(missing="ucode"), reason="找不到依赖提供者：ucode")
        check("缺少虚拟依赖提供者", metadata(missing="ip"), reason="找不到依赖提供者：ip")
        check("条件依赖保守回退", metadata(app_depends="+libc +CONFIG_FEATURE:ucode"), reason="复杂依赖")
        check("配置条件保守回退", metadata(app_depends="+libc @FEATURE"), reason="复杂依赖")
        check("未知依赖语法", metadata(app_depends="+libc foo|bar"), reason="复杂依赖")
        check("空依赖", metadata(app_depends=""), reason="直接依赖元数据")
        check("缺少应用记录", metadata(with_app=False), reason="直接依赖元数据")
        check("元数据没有 ABI 格式证据", metadata(with_abi=False), reason="ABI-Version")
        check("普通构建依赖", metadata(app_build={"": "lua"}), reason="builddepends 构建依赖")
        check("宿主构建依赖", metadata(app_build={"/host": "lua/host"}), reason="builddepends/host")
        check("其他构建类型依赖", metadata(app_build={"/custom": "tool"}), reason="builddepends/custom")
        check("额外依赖不在 dumpinfo 中", metadata(), makefile=EMPTY_HOOKS + "EXTRA_DEPENDS:=libucode\n",
              reason="EXTRA_DEPENDS")
        check("额外依赖标识也需审核", metadata(), makefile=EMPTY_HOOKS + "# EXTRA_DEPENDS 需重新审核\n",
              reason="EXTRA_DEPENDS")
        check("编译钩子执行命令", metadata(),
              makefile=EMPTY_HOOKS.replace("define Build/Compile\n", "define Build/Compile\n\t$(MAKE)\n"),
              reason="Build/Compile 不是空钩子")
        check("配置钩子调用默认配置", metadata(),
              makefile=EMPTY_HOOKS.replace("define Build/Configure\n", "define Build/Configure\n\t$(call Build/Configure/Default)\n"),
              reason="Build/Configure 不是空钩子")
        check("缺少显式编译钩子", metadata(), makefile="define Build/Configure\nendef\n",
              reason="必须显式定义空的 Build/Compile")
        check("缺少显式配置钩子", metadata(), makefile="define Build/Compile\nendef\n",
              reason="必须显式定义空的 Build/Configure")
        check("编译钩子未闭合", metadata(), makefile=EMPTY_HOOKS.rsplit("endef", 1)[0], reason="结构不完整")
        check("编译钩子重复定义", metadata(), makefile=EMPTY_HOOKS + "define Build/Compile\nendef\n", reason="重复定义")
        check("编译钩子后续重写", metadata(), makefile=EMPTY_HOOKS + "Build/Compile=$(MAKE)\n", reason="定义或引用")
        check("条件定义不能证明钩子为空", metadata(), makefile="ifdef FEATURE\n" + EMPTY_HOOKS + "endif\n",
              reason="无条件的顶层定义")
        check("SDK 解析失败", metadata(app_extra="Require-User: invalid=65536"), reason="元数据解析失败")
        check("元数据文件缺失", metadata(), absent="info", reason="无法读取 SDK")
        check("应用 Makefile 缺失", metadata(), absent="makefile", reason="无法读取应用 Makefile")

    print(f"通过：{executions} 个 package-only 判定用例（使用真实 SDK metadata.pm）；依赖 ABI、虚拟提供者、构建依赖及空钩子保护。")


if __name__ == "__main__":
    main()
