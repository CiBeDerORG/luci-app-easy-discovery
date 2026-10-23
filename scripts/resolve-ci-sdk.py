#!/usr/bin/env python3
"""Resolve one official SDK and record the exact checksum used by this run."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def fetch(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "Easy-Discovery-CI"})
    with urllib.request.urlopen(request, timeout=30) as response:
        final = urllib.parse.urlsplit(response.url)
        if final.scheme != "https" or final.hostname not in {
            "downloads.openwrt.org", "downloads.immortalwrt.org"
        }:
            raise ValueError("SDK 元数据重定向到了非官方地址")
        data = response.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise ValueError("SDK 元数据超过读取上限")
    return data.decode("utf-8", errors="strict")


def main() -> None:
    parser = argparse.ArgumentParser(description="解析官方 SDK 与本次构建校验值")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    profile = json.loads((ROOT / "ci/sdk-profile.json").read_text())
    base = profile["base_url"]
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme != "https" or parsed.hostname not in {
        "downloads.openwrt.org", "downloads.immortalwrt.org"
    } or parsed.username or parsed.password or parsed.port or parsed.query
        or parsed.fragment or not parsed.path.endswith("/")):
        raise ValueError("SDK 基础地址必须为官方 HTTPS 目录")
    pattern = re.compile(re.escape(profile["sdk_prefix"]) +
                         r"[A-Za-z0-9_.+-]+\.Linux-x86_64\.tar\.(?:xz|zst)")
    candidates = []
    for line in fetch(base + "sha256sums").splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) != 2:
            continue
        digest, filename = fields[0], fields[1].lstrip("*")
        if re.fullmatch(r"[0-9a-fA-F]{64}", digest) and pattern.fullmatch(filename):
            candidates.append((filename, digest.lower()))
    if len(candidates) != 1:
        raise ValueError(f"预期一个匹配 SDK，实际发现 {len(candidates)} 个")
    filename, digest = candidates[0]
    version = fetch(base + "version.buildinfo").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.+ -]{1,160}", version):
        raise ValueError("SDK 版本信息格式无效")
    result = {
        **profile,
        "sdk_url": base + filename,
        "sdk_sha256": digest,
        "sdk_version": version,
        "feeds_buildinfo": fetch(base + "feeds.buildinfo"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    output_file = os.environ.get("GITHUB_OUTPUT")
    if output_file:
        with open(output_file, "a", encoding="utf-8") as output:
            for key in ("sdk_url", "sdk_sha256", "sdk_version"):
                output.write(f"{key}={result[key]}\n")
    print(f"SDK: {profile['name']} / {version}")
    print(f"SHA256: {digest}")
    print(f"构建记录: {args.output}")


if __name__ == "__main__":
    main()
