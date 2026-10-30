"""Key-free launcher tests: fabricated store header and mocked external tools only."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
        self.overrides = patch.multiple(signing, KEY_DIR=self.keys, CONFIG=self.config_file)
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


if __name__ == "__main__":
    unittest.main()
