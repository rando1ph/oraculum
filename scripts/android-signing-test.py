"""Key-free launcher tests: fabricated store header and mocked external tools only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import zipfile
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("signing", Path(__file__).with_name("android-signing.py"))
signing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signing)


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="oraculum-signing-test-")
        self.root = Path(self.temporary.name)
        self.keys = self.root / "keys"
        self.keys.mkdir(mode=0o700)
        self.primary = self.keys / "oraculum-release.jks"
        # Deliberately not a usable key or credential.
        self.primary.write_bytes(bytes.fromhex("feedfeed") + b"not-a-keystore-test-fixture")
        self.primary.chmod(0o600)
        self.backup = self.root / "offline" / self.primary.name
        self.config = {"keystore": str(self.primary), "alias": signing.ALIAS,
                       "backup": str(self.backup), "certificateSha256": "a" * 64,
                       "backupVerified": True}
        self.config_file = self.keys / "release-signing.json"
        self.write_config()
        self.overrides = patch.multiple(signing, KEY_DIR=self.keys, CONFIG=self.config_file,
                                        ARTIFACT_DIR=self.root / "repo/dist/android")
        self.overrides.start()

    def tearDown(self):
        self.overrides.stop()
        self.temporary.cleanup()

    def write_config(self):
        self.config_file.write_text(json.dumps(self.config))
        self.config_file.chmod(0o600)

    def test_daily_validation_does_not_touch_offline_backup(self):
        original = signing.private_path
        def guard(path, directory=False):
            self.assertFalse(path.is_relative_to(self.backup.parent), "daily signing accessed offline media")
            return original(path, directory)
        with patch.object(signing, "private_path", side_effect=guard):
            self.assertEqual(signing.validate_config(), self.config)

    def test_explicit_backup_check_requires_separate_matching_copy(self):
        self.backup.parent.mkdir(mode=0o700)
        self.backup.write_bytes(self.primary.read_bytes())
        self.backup.chmod(0o600)
        self.assertEqual(signing.validate_config(check_backup=True), self.config)
        self.backup.write_bytes(bytes.fromhex("feedfeed") + b"different-test-fixture")
        with self.assertRaisesRegex(RuntimeError, "differ"):
            signing.validate_config(check_backup=True)

    def test_unverified_backup_attestation_rejected(self):
        self.config["backupVerified"] = False
        self.write_config()
        with self.assertRaises(RuntimeError):
            signing.validate_config()

    def test_loose_primary_permissions_rejected(self):
        self.primary.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "permissions"):
            signing.validate_config()

    def test_primary_symlink_rejected(self):
        self.primary.unlink()
        self.primary.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            signing.validate_config()

    def test_primary_hardlink_rejected(self):
        import os
        os.link(self.primary, self.root / "linked")
        with self.assertRaisesRegex(RuntimeError, "hard-linked"):
            signing.validate_config()

    def test_invalid_certificate_rejected(self):
        self.config["certificateSha256"] = "invalid"
        self.write_config()
        with self.assertRaisesRegex(RuntimeError, "fingerprint"):
            signing.validate_config()

    def test_sign_prebuilt_apk_without_gradle_or_backup(self):
        repository = self.root / "repo"
        repository.mkdir()
        (repository / "release.json").write_text(json.dumps({"version": "0.1.2", "androidVersionCode": 4}))
        source = repository / "reviewed-unsigned.apk"
        identity = {"sourceGit": "b" * 40, "sourceDirty": False, "version": "0.1.2", "versionCode": 4}
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("assets/oraculum-build.json", json.dumps(identity))
        original_bytes = source.read_bytes()
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command[1:2] == ["sign"]:
                Path(command[command.index("--out") + 1]).write_bytes(Path(command[-1]).read_bytes())
        with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run", side_effect=run), \
                patch.object(signing.subprocess, "check_output", return_value=""):
            signing.release(source)
            signing.release(source)  # existing verified result is preserved
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertTrue((repository / "dist/android/oraculum-0.1.2-4.apk").is_file())
        self.assertEqual(sum(command[1:2] == ["sign"] for command in commands), 1)
        self.assertFalse(any(command[0] == "bash" for command in commands))
        verify = [command for command in commands if command[0] == "node"]
        self.assertTrue(any("--unsigned" in command for command in verify))
        self.assertTrue(all("--expected-cert" in command for command in verify if "--unsigned" not in command))
        signing_command = next(command for command in commands if command[1:2] == ["sign"])
        self.assertNotIn("--ks-pass", signing_command)
        self.assertNotIn("--key-pass", signing_command)

    def test_password_and_jvm_hooks_are_removed_from_tool_environment(self):
        with patch.dict(signing.os.environ, {"ORACULUM_RELEASE_STORE_PASSWORD": "unused-test-value", "JAVA_TOOL_OPTIONS": "unused-test-hook"}):
            environment = signing.tool_environment()
        self.assertNotIn("ORACULUM_RELEASE_STORE_PASSWORD", environment)
        self.assertNotIn("JAVA_TOOL_OPTIONS", environment)

    def test_dirty_apk_never_reaches_signer(self):
        repository = self.root / "repo"
        repository.mkdir()
        (repository / "release.json").write_text(json.dumps({"version": "0.1.2", "androidVersionCode": 4}))
        source = repository / "dirty.apk"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("assets/oraculum-build.json", json.dumps({"sourceDirty": True, "version": "0.1.2", "versionCode": 4}))
        with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run") as run, \
                patch.object(signing.subprocess, "check_output", return_value=""):
            with self.assertRaisesRegex(RuntimeError, "clean build"):
                signing.release(source)
            run.assert_not_called()

    def test_failed_unsigned_verification_never_reaches_signer(self):
        repository = self.root / "repo"
        repository.mkdir()
        (repository / "release.json").write_text(json.dumps({"version": "0.1.2", "androidVersionCode": 4}))
        source = repository / "invalid.apk"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("assets/oraculum-build.json", json.dumps({"sourceGit": "b" * 40, "sourceDirty": False, "version": "0.1.2", "versionCode": 4}))
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if "--unsigned" in command:
                raise signing.subprocess.CalledProcessError(1, command)
        with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run", side_effect=run), \
                patch.object(signing.subprocess, "check_output", return_value=""):
            with self.assertRaises(signing.subprocess.CalledProcessError):
                signing.release(source)
        self.assertFalse(any(command[1:2] == ["sign"] for command in commands))
        self.assertFalse((repository / "dist/android/oraculum-0.1.2-4.apk").exists())

    def prepare_release(self):
        repository = self.root / "repo"
        repository.mkdir()
        (repository / "release.json").write_text(json.dumps({"version": "0.1.2", "androidVersionCode": 4}))
        source = repository / "reviewed-unsigned.apk"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("assets/oraculum-build.json", json.dumps({
                "sourceGit": "b" * 40, "sourceDirty": False, "version": "0.1.2", "versionCode": 4}))
        return repository, source

    def test_auto_release_uses_only_stdin_and_preserves_existing_output(self):
        repository, source = self.prepare_release()
        original = source.read_bytes()
        key_bytes = self.primary.read_bytes()
        commands = []
        # Distinct fabricated passwords, including meaningful whitespace.
        credentials = {"jks-store": b" fake store ", "jks-key": b"different fake key"}
        def run(command, **kwargs):
            commands.append((command, kwargs))
            if command[0] == "secret-tool":
                self.assertEqual(command[:-1], ["secret-tool", "lookup", "app", "oraculum", "type"])
                self.assertEqual(kwargs["stdin"], subprocess.DEVNULL)
                self.assertEqual(kwargs["stdout"], subprocess.PIPE)
                self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
                return subprocess.CompletedProcess(command, 0, credentials[command[-1]])
            if command[1:2] == ["sign"]:
                self.assertEqual(kwargs["input"], b" fake store \ndifferent fake key\n")
                self.assertEqual(command[command.index("--ks-pass") + 1], "stdin")
                self.assertEqual(command[command.index("--key-pass") + 1], "stdin")
                self.assertEqual(kwargs["stdout"], subprocess.DEVNULL)
                self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
                Path(command[command.index("--out") + 1]).write_bytes(Path(command[-1]).read_bytes())
            else:
                self.assertNotIn("input", kwargs)
            for secret in credentials.values():
                self.assertNotIn(secret.decode(), repr(command))
                self.assertNotIn(secret.decode(), repr(kwargs.get("env", {})))
        with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run", side_effect=run), \
                patch.object(signing.subprocess, "check_output", return_value=""):
            signing.release(source, auto=True)
            target = signing.ARTIFACT_DIR / "oraculum-0.1.2-4.apk"
            before = target.stat()
            signing.release(source, auto=True)
            self.assertEqual(target.stat().st_ino, before.st_ino)
            self.assertEqual(target.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.primary.read_bytes(), key_bytes)
        self.assertFalse(self.backup.parent.exists())
        self.assertEqual(sum(cmd[0] == "secret-tool" for cmd, _ in commands), 2)
        self.assertEqual(sum(cmd[1:2] == ["sign"] for cmd, _ in commands), 1)
        self.assertFalse(any(cmd[0] == "bash" for cmd, _ in commands))
        for command, _ in commands:
            if command[0] == "node":
                self.assertIn("--expected-git", command)
                self.assertTrue("--unsigned" in command or "--expected-cert" in command)

    def test_secret_lookup_fails_closed_without_echoing_credentials(self):
        command = ["secret-tool", "lookup", "app", "oraculum", "type", "jks-store"]
        failures = [
            subprocess.CompletedProcess(command, 1, b"fake sensitive diagnostic"),
            FileNotFoundError("fake sensitive diagnostic"),
            subprocess.TimeoutExpired(command, 15, output=b"fake sensitive diagnostic"),
        ]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                kwargs = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
                with patch.object(signing.subprocess, "run", **kwargs):
                    with self.assertRaises(RuntimeError) as caught:
                        signing.secret_password("jks-store", {})
                self.assertNotIn("sensitive", str(caught.exception))

    def test_empty_or_multiline_secret_is_rejected_without_normalization(self):
        for secret in [b"", b"line\n", b"line\r", b"line\0", b"one\ntwo"]:
            with self.subTest(secret=secret), patch.object(signing.subprocess, "run",
                    return_value=subprocess.CompletedProcess([], 0, secret)):
                with self.assertRaises(RuntimeError):
                    signing.secret_password("jks-key", {})

    def test_auto_failure_does_not_publish_or_preserve_partial_candidate(self):
        for stage in ["lookup", "sign", "certificate"]:
            with self.subTest(stage=stage):
                repository = self.root / "repo"
                if repository.exists():
                    signing.shutil.rmtree(repository)
                repository, source = self.prepare_release()
                def run(command, **kwargs):
                    if command[0] == "secret-tool":
                        # A missing second secret must prevent apksigner entirely.
                        if stage == "lookup" and command[-1] == "jks-key":
                            return subprocess.CompletedProcess(command, 1, b"")
                        return subprocess.CompletedProcess(command, 0, b"fake-test-password")
                    if command[1:2] == ["sign"]:
                        self.assertNotEqual(stage, "lookup")
                        Path(command[command.index("--out") + 1]).write_bytes(source.read_bytes())
                        if stage == "sign":
                            raise subprocess.CalledProcessError(1, command, stderr=b"fake-test-password")
                    if stage == "certificate" and "--expected-cert" in command:
                        raise subprocess.CalledProcessError(1, command)
                with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run", side_effect=run), \
                        patch.object(signing.subprocess, "check_output", return_value=""):
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)) as caught:
                        signing.release(source, auto=True)
                self.assertNotIn("fake-test-password", str(caught.exception))
                self.assertEqual(list(signing.ARTIFACT_DIR.iterdir()), [])

    def test_auto_cli_does_not_require_tty_or_ask_for_confirmation(self):
        with patch.object(signing.sys.stdin, "isatty", return_value=False), \
                patch.object(signing.sys.stdout, "isatty", return_value=False), \
                patch.object(signing, "release") as release, patch("builtins.input", side_effect=AssertionError("prompt")):
            signing.main(["release", "--auto", "--apk", "/reviewed.apk"])
            release.assert_called_once_with(Path("/reviewed.apk"), auto=True)

    def test_interactive_cli_still_requires_tty(self):
        with patch.object(signing.sys.stdin, "isatty", return_value=False), patch.object(signing, "release") as release:
            with self.assertRaisesRegex(RuntimeError, "terminal"):
                signing.main(["release"])
            release.assert_not_called()
        with patch.object(signing.sys.stdin, "isatty", return_value=True), \
                patch.object(signing.sys.stdout, "isatty", return_value=True), patch.object(signing, "release") as release:
            signing.main(["release"])
            release.assert_called_once_with(None, auto=False)

    def test_auto_is_only_valid_for_release(self):
        for command in ["init", "resume", "verify-backup"]:
            with self.subTest(command=command), patch.object(signing, "initialize") as initialize:
                with self.assertRaisesRegex(RuntimeError, "only valid with release"):
                    signing.main([command, "--auto"])
                initialize.assert_not_called()

    def test_auto_builds_unsigned_before_reading_any_credentials(self):
        repository, fixture = self.prepare_release()
        built = repository / "apps/android/app/build/outputs/apk/release/app-release-unsigned.apk"
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command[0] == "bash":
                self.assertEqual(command, ["bash", "scripts/android-release-build.sh", "--unsigned"])
                self.assertNotIn("input", kwargs)
                built.parent.mkdir(parents=True)
                built.write_bytes(fixture.read_bytes())
            if command[0] == "secret-tool":
                self.assertTrue(any("--unsigned" in cmd and cmd[0] == "node" for cmd in commands))
                return subprocess.CompletedProcess(command, 0, b"fake-test-password")
            if command[1:2] == ["sign"]:
                Path(command[command.index("--out") + 1]).write_bytes(Path(command[-1]).read_bytes())
        def check_output(command, **kwargs):
            return "b" * 40 if command[1:2] == ["rev-parse"] else ""
        with patch.object(signing, "ROOT", repository), patch.object(signing.subprocess, "run", side_effect=run), \
                patch.object(signing.subprocess, "check_output", side_effect=check_output):
            signing.release(auto=True)
        self.assertTrue((signing.ARTIFACT_DIR / "oraculum-0.1.2-4.apk").is_file())
        self.assertEqual(built.read_bytes(), fixture.read_bytes())

    def test_signer_timeout_does_not_echo_captured_data(self):
        with patch.object(signing, "secret_password", return_value=b"fake-test-password"), \
                patch.object(signing.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                    ["apksigner"], 120, output=b"fake-test-password", stderr=b"fake-test-password")):
            with self.assertRaisesRegex(RuntimeError, "diagnostics suppressed") as caught:
                signing.sign_apk(["apksigner", "sign", "input.apk"], {}, auto=True)
            self.assertNotIn("fake-test-password", str(caught.exception))

    def test_dirty_repository_never_reads_credentials_or_signs(self):
        with patch.object(signing.subprocess, "check_output", return_value=" M user-change"), \
                patch.object(signing.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "Commit the reviewed source"):
                signing.release(auto=True)
            run.assert_not_called()

    def test_only_untracked_stitch_originals_are_excluded_from_source_gate(self):
        repository, source = self.prepare_release()
        def check_output(command, **kwargs):
            if command[1:2] == ["ls-files"]:
                return "upgrade/stitch_oraculum_android_workspace/original.html\0"
            return ""
        with patch.object(signing, "ROOT", repository), \
                patch.object(signing.subprocess, "check_output", side_effect=check_output), \
                patch.object(signing.subprocess, "run", side_effect=RuntimeError("reached verifier")):
            with self.assertRaisesRegex(RuntimeError, "reached verifier"):
                signing.release(source, auto=True)
        for filename in ["source.kt", "upgrade/stitch_oraculum_android_workspace-other/source.kt"]:
            def check_output(command, **kwargs):
                return filename + "\0" if command[1:2] == ["ls-files"] else ""
            with patch.object(signing, "ROOT", repository), \
                    patch.object(signing.subprocess, "check_output", side_effect=check_output), \
                    patch.object(signing.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Commit all source files"):
                    signing.release(source, auto=True)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
