#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""将当前流水线已验签的 APK 产物发布到 GitHub Releases。"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

PACKAGE = "luci-app-easy-discovery"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare_assets(source: Path, output: Path, sha: str) -> str:
    """只接受已列入校验清单的已知文件，不上传私钥或工作目录内容。"""
    packages = list(source.glob(f"{PACKAGE}-*.apk"))
    if len(packages) != 1:
        raise ValueError("发布产物必须且只能包含一个版本化 APK")
    apk = packages[0]
    match = re.fullmatch(r"luci-app-easy-discovery-([0-9][A-Za-z0-9.+_~-]*)\.apk", apk.name)
    if not match:
        raise ValueError("APK 文件名中的版本无效")
    required = {apk.name, apk.name + ".json", "public-key.pem", "构建信息.txt"}
    allowed = required | {"version.buildinfo", "feeds.buildinfo"}
    files = {p.name for p in source.iterdir()}
    if not required.issubset(files) or files - allowed - {"SHA256SUMS"}:
        raise ValueError("发布文件缺失或包含未授权附件")
    if any(p.is_symlink() or not p.is_file() for p in source.iterdir()):
        raise ValueError("发布目录不能包含子目录或符号链接")
    hashes: dict[str, str] = {}
    for line in (source / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        item = re.fullmatch(r"([0-9a-fA-F]{64}) [ *](?:\./)?([^/\\\r\n]+)", line)
        if not item or item[2] not in allowed or item[2] in hashes:
            raise ValueError("校验清单含有非法路径或重复条目")
        hashes[item[2]] = item[1].lower()
    if set(hashes) != files - {"SHA256SUMS"}:
        raise ValueError("校验清单未覆盖全部发布文件")
    for name, expected in hashes.items():
        if digest(source / name) != expected:
            raise ValueError(f"文件校验失败：{name}")
    info = (source / "构建信息.txt").read_text(encoding="utf-8")
    if f"源码提交：{sha}" not in info.splitlines():
        raise ValueError("产物源码提交与当前流水线不一致")
    key = (source / "public-key.pem").read_text(encoding="ascii")
    if "PRIVATE KEY" in key or "-----BEGIN PUBLIC KEY-----" not in key:
        raise ValueError("签名附件不是公钥")
    if output.exists():
        raise ValueError("发布暂存目录必须不存在，防止混入旧文件")
    output.mkdir(parents=True)
    for name in sorted(hashes):
        shutil.copyfile(source / name, output / name)
    shutil.copyfile(apk, output / f"{PACKAGE}.apk")
    # 完整 ZIP 使用原产物及其校验清单，下载一次即可获得相互匹配的包和公钥。
    with zipfile.ZipFile(output / "easy-discovery.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            archive.write(source / name, name)
    checksum = "".join(f"{digest(p)}  {p.name}\n" for p in sorted(output.iterdir()))
    (output / "SHA256SUMS").write_text(checksum, encoding="utf-8")
    return match[1]


def gh(*args: str) -> str:
    # 参数通过列表传递，不将分支名等数据交给 shell 解释。
    result = subprocess.run(["gh", *args], check=True, text=True, capture_output=True, timeout=180)
    return result.stdout.strip()


def publish(source: Path, env: dict[str, str]) -> str:
    repo, sha = env["GITHUB_REPOSITORY"], env["GITHUB_SHA"]
    ref, run, attempt = env["GITHUB_REF"], env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repo):
        raise ValueError("仓库名称无效")
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not ref.startswith("refs/heads/"):
        raise ValueError("仅支持已知提交的分支构建发布")
    if not re.fullmatch(r"[1-9][0-9]*", run) or not re.fullmatch(r"[1-9][0-9]*", attempt):
        raise ValueError("构建编号无效")
    with tempfile.TemporaryDirectory(prefix="easy-discovery-release-") as temp:
        assets = Path(temp) / "assets"
        version = prepare_assets(source, assets, sha)
        # 每次执行/重跑独立标签，绝不覆盖已经公开的版本或其签名公钥。
        tag = f"v{version}-build.{run}.{attempt}"
        branch = ref.removeprefix("refs/heads/")
        prerelease = ref != "refs/heads/main"
        notes = Path(temp) / "notes.md"
        notes.write_text(
            f"## Easy Discovery {version}\n\n"
            f"- 源码提交：`{sha}`\n- 来源分支：`{branch}`\n"
            f"- 构建记录：https://github.com/{repo}/actions/runs/{run}\n\n"
            "测试、APK 构建与签名验证通过后自动发布，尚不代表真实路由器验收。\n\n"
            "直接下载版本化 APK 或 `luci-app-easy-discovery.apk`（两者内容相同）。\n"
            "完整 `easy-discovery.zip` 包含同一次构建的 APK、公钥和原始校验清单。\n"
            "请勿将不同 Release 的 APK 和公钥混用。Release 附件不随 Actions 的 14 天产物保留期清理。\n\n"
            "安装示例（仅放宽签名信任限制，不忽略依赖）：\n\n"
            f"```sh\napk add --allow-untrusted /tmp/{PACKAGE}.apk\n```\n",
            encoding="utf-8",
        )
        gh("release", "create", tag, "--repo", repo, "--target", sha,
           "--draft", "--latest=false", f"--prerelease={str(prerelease).lower()}",
           "--title", f"Easy Discovery {version} · {sha[:7]}", "--notes-file", str(notes))
        paths = sorted(assets.iterdir())
        gh("release", "upload", tag, "--repo", repo, *map(str, paths))
        release = json.loads(gh("release", "view", tag, "--repo", repo, "--json", "assets,url,isDraft"))
        remote = {a["name"]: a["size"] for a in release["assets"]}
        if not release["isDraft"] or remote != {p.name: p.stat().st_size for p in paths}:
            raise ValueError("Release 附件不完整，保留草稿，不更新公开下载")
        latest = False
        if not prerelease:
            head = json.loads(gh("api", f"repos/{repo}/git/ref/heads/main"))["object"]["sha"]
            latest = head == sha  # 旧提交重跑不能把 Latest 倒退。
        gh("release", "edit", tag, "--repo", repo, "--draft=false",
           f"--latest={str(latest).lower()}", f"--prerelease={str(prerelease).lower()}")
        url = f"https://github.com/{repo}/releases/tag/{tag}"
        summary = env.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a", encoding="utf-8") as stream:
                stream.write(f"## 自动发布成功\n\n[本次 Release]({url})\n\n")
                if latest:
                    base = f"https://github.com/{repo}/releases/latest/download"
                    stream.write(f"[APK 固定地址]({base}/{PACKAGE}.apk) · [完整包]({base}/easy-discovery.zip)\n")
        return url


def main() -> int:
    try:
        if len(sys.argv) != 2:
            raise ValueError("用法：python3 scripts/publish-release.py 已验签产物目录")
        print(publish(Path(sys.argv[1]), dict(os.environ)))
        return 0
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"发布失败：{error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
