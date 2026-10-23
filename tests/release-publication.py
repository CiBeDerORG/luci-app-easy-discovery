#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""发布流程隔离回归；不访问 GitHub，不创建真实 Release。"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publish_release", ROOT / "scripts/publish-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SHA = "a" * 40
APK = "luci-app-easy-discovery-0.1.0-r3.apk"


class Publication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "input"
        self.source.mkdir()
        for name, content in {
            APK: "APK 测试内容", APK + ".json": "{}",
            "public-key.pem": "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----\n",
            "构建信息.txt": f"源码提交：{SHA}\n",
        }.items():
            (self.source / name).write_text(content)
        self.manifest()
        self.env = {"GITHUB_REPOSITORY": "owner/repo", "GITHUB_SHA": SHA,
                    "GITHUB_REF": "refs/heads/main", "GITHUB_RUN_ID": "123",
                    "GITHUB_RUN_ATTEMPT": "1"}

    def manifest(self):
        (self.source / "SHA256SUMS").write_text("".join(
            f"{release.digest(p)}  ./{p.name}\n" for p in sorted(self.source.iterdir()) if p.name != "SHA256SUMS"))

    def prepare(self):
        return release.prepare_assets(self.source, self.root / "output", SHA)

    def test_bundle_alias_and_checksums(self):
        self.assertEqual(self.prepare(), "0.1.0-r3")
        output = self.root / "output"
        self.assertTrue(all(p.name.isascii() for p in output.iterdir()))
        self.assertEqual((output / "build-info.txt").read_bytes(), (self.source / "构建信息.txt").read_bytes())
        self.assertEqual((output / "luci-app-easy-discovery.apk").read_bytes(), (self.source / APK).read_bytes())
        with zipfile.ZipFile(output / "easy-discovery.zip") as archive:
            self.assertEqual(set(archive.namelist()), {p.name for p in self.source.iterdir()})
            self.assertEqual(archive.read("SHA256SUMS"), (self.source / "SHA256SUMS").read_bytes())
        for line in (output / "SHA256SUMS").read_text().splitlines():
            checksum, name = line.split("  ", 1)
            self.assertEqual(checksum, release.digest(output / name))

    def test_tampered_artifact_rejected(self):
        (self.source / APK).write_text("changed")
        with self.assertRaises(ValueError): self.prepare()

    def test_unexpected_private_key_rejected(self):
        (self.source / "private-key.pem").write_text("PRIVATE")
        self.manifest()
        with self.assertRaises(ValueError): self.prepare()

    def test_private_content_in_public_key_rejected(self):
        (self.source / "public-key.pem").write_text("-----BEGIN PRIVATE KEY-----")
        self.manifest()
        with self.assertRaises(ValueError): self.prepare()

    def test_symlink_rejected(self):
        (self.source / APK).unlink()
        (self.root / "other").write_text("APK 测试内容")
        (self.source / APK).symlink_to(self.root / "other")
        with self.assertRaises(ValueError): self.prepare()

    def test_other_commit_rejected(self):
        (self.source / "构建信息.txt").write_text("源码提交：" + "b" * 40)
        self.manifest()
        with self.assertRaises(ValueError): self.prepare()

    def test_missing_manifest_entry_rejected(self):
        lines = (self.source / "SHA256SUMS").read_text().splitlines()
        (self.source / "SHA256SUMS").write_text("\n".join(lines[:-1]))
        with self.assertRaises(ValueError): self.prepare()

    def test_path_traversal_rejected(self):
        (self.source / "SHA256SUMS").write_text("0" * 64 + "  ../secret\n")
        with self.assertRaises(ValueError): self.prepare()

    def run_publish(self, head=SHA, upload_fails=False, missing_asset=False):
        calls, uploaded = [], []
        def fake_gh(*args):
            calls.append(args)
            if args[:2] == ("release", "upload"):
                if upload_fails: raise subprocess.CalledProcessError(1, ["gh"])
                uploaded.extend({"name": Path(p).name, "size": Path(p).stat().st_size} for p in args[5:])
            if args[:2] == ("release", "view"):
                return json.dumps({"url": "https://github.com/owner/repo/releases/tag/test", "isDraft": True,
                                   "assets": uploaded[:-1] if missing_asset else uploaded})
            if args[0] == "api": return json.dumps({"object": {"sha": head}})
            return ""
        with patch.object(release, "gh", side_effect=fake_gh):
            try:
                release.publish(self.source, self.env)
            finally:
                self.calls = calls
        return calls

    def test_main_publishes_only_after_upload(self):
        calls = self.run_publish()
        self.assertEqual([c[1] for c in calls], ["create", "upload", "view", "repos/owner/repo/git/ref/heads/main", "edit"])
        self.assertIn("--draft", calls[0]); self.assertIn("--latest=true", calls[-1])
        self.assertIn(SHA, calls[0])

    def test_feature_branch_is_prerelease(self):
        self.env["GITHUB_REF"] = "refs/heads/feat/test"
        calls = self.run_publish()
        self.assertIn("--prerelease=true", calls[-1]); self.assertIn("--latest=false", calls[-1])
        self.assertFalse(any(c[0] == "api" for c in calls))

    def test_old_main_does_not_replace_latest(self):
        self.assertIn("--latest=false", self.run_publish(head="b" * 40)[-1])

    def test_upload_failure_keeps_draft(self):
        with self.assertRaises(subprocess.CalledProcessError): self.run_publish(upload_fails=True)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.calls))

    def test_incomplete_upload_keeps_draft(self):
        with self.assertRaises(ValueError): self.run_publish(missing_asset=True)
        self.assertFalse(any(c[:2] == ("release", "edit") for c in self.calls))

    def test_rerun_creates_separate_release(self):
        self.env["GITHUB_RUN_ATTEMPT"] = "2"
        self.assertEqual(self.run_publish()[0][2], "v0.1.0-r3-build.123.2")

    def test_invalid_repository_rejected(self):
        self.env["GITHUB_REPOSITORY"] = "../bad"
        with self.assertRaises(ValueError): self.run_publish()


if __name__ == "__main__":
    unittest.main(verbosity=2)
