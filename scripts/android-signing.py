#!/usr/bin/env python3
"""Local-terminal-only key custody and release launcher. Never run via agent PTY."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
KEY_DIR = Path.home() / ".local/share/oraculum-signing"
CONFIG = KEY_DIR / "release-signing.json"
TOOLS = Path(os.environ.get("ORACULUM_TOOLS", str(Path.home() / ".local/share/oraculum-tools")))
ALIAS = "oraculum-release"


def tool_environment():
    environment = os.environ.copy()
    # Only the short-lived signing tool reads passwords from the real console.
    # Remove inherited shell/JVM hooks and obsolete Gradle signing inputs.
    for name in list(environment):
        if name.startswith("ORACULUM_RELEASE_") or name in {"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS", "JAVA_OPTS", "GRADLE_OPTS"}:
            environment.pop(name, None)
    environment["JAVA_HOME"] = str(TOOLS / "jdk-21")
    environment["PATH"] = str(TOOLS / "jdk-21/bin") + os.pathsep + environment.get("PATH", "/usr/bin:/bin")
    return environment


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_path(path, directory=False):
    require(path.is_absolute() and path == path.resolve(), "Signing paths must be absolute and contain no symlinks")
    require(not path.is_relative_to(ROOT), "Signing material must remain outside the repository")
    info = path.lstat()
    require(info.st_uid == os.getuid(), "Signing files/directories must belong to the current user")
    require(stat.S_IMODE(info.st_mode) == (0o700 if directory else 0o600), "Signing directory/file permissions must be 0700/0600")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), "Unexpected signing path type")
    require(directory or info.st_nlink == 1, "Signing files must not be hard-linked")


def private_directory(path):
    require(path.is_absolute() and path == path.resolve(), "Use an absolute directory without symlinks")
    require(not path.is_relative_to(ROOT), "Signing material must remain outside the repository")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_path(path, directory=True)


def store_hash(path):
    private_path(path)
    with path.open("rb") as stream:
        require(stream.read(4) == bytes.fromhex("feedfeed"), "Expected a real JKS store, not an extension-renamed PKCS12 file")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_config():
    private_path(KEY_DIR, directory=True)
    private_path(CONFIG)
    config = json.loads(CONFIG.read_text())
    require(set(config) == {"keystore", "alias", "backup", "certificateSha256", "backupVerified"}, "Unexpected signing configuration fields")
    require(config["alias"] == ALIAS and config["backupVerified"] is True, "A dedicated, verified release key backup is required")
    require(len(config["certificateSha256"]) == 64 and all(c in "0123456789abcdef" for c in config["certificateSha256"]), "Invalid public certificate fingerprint")
    primary, backup = Path(config["keystore"]), Path(config["backup"])
    require(primary == KEY_DIR / "oraculum-release.jks", "Unexpected primary release key path")
    private_path(primary.parent, directory=True)
    private_path(backup.parent, directory=True)
    require(primary != backup and not backup.is_relative_to(KEY_DIR), "Backup must be independent from the primary key directory")
    require(store_hash(primary) == store_hash(backup), "Primary and backup differ; stop and inspect locally")
    require((primary.stat().st_dev, primary.stat().st_ino) != (backup.stat().st_dev, backup.stat().st_ino), "Backup must be a separate file")
    return config


def initialize(resume=False):
    private_directory(KEY_DIR)
    primary = KEY_DIR / "oraculum-release.jks"
    require(not os.path.lexists(CONFIG), "Existing release configuration preserved")
    if resume:
        store_hash(primary)
    else:
        require(not os.path.lexists(primary), "Existing release key preserved; use resume to verify/complete its backup")
    print("Passwords stay in this terminal. Disable terminal recording and shell tracing first.")
    print("Choose a private backup directory on media you control and can keep offline; no cloud-synced folder.")
    backup_directory = Path(input("Absolute backup directory: ").strip())
    require(not backup_directory.is_relative_to(KEY_DIR), "Backup must be outside the primary key directory")
    private_directory(backup_directory)
    backup = backup_directory / "oraculum-release.jks"
    if not resume:
        require(not os.path.lexists(backup), "Existing backup preserved; select its original key instead of overwriting")
        subprocess.run([str(TOOLS / "jdk-21/bin/keytool"), "-genkeypair", "-storetype", "JKS", "-alias", ALIAS,
                        "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-dname", "CN=Oraculum Release",
                        "-keystore", str(primary)], env=tool_environment(), check=True)
    private_path(primary)
    if not os.path.lexists(backup):
        with primary.open("rb") as source, backup.open("xb") as destination:
            shutil.copyfileobj(source, destination)
            destination.flush()
            os.fsync(destination.fileno())
    require(store_hash(primary) == store_hash(backup), "Backup byte comparison failed")
    require((primary.stat().st_dev, primary.stat().st_ino) != (backup.stat().st_dev, backup.stat().st_ino), "Backup must be a separate file")
    # Inherit the real terminal for Console.readPassword; only the public
    # certificate digest is returned through a short-lived private directory.
    with tempfile.TemporaryDirectory(prefix="verify-", dir=KEY_DIR) as temporary:
        result = Path(temporary) / "certificate-sha256.txt"
        subprocess.run([str(TOOLS / "jdk-21/bin/java"), str(ROOT / "scripts/SigningKeyCheck.java"),
                        str(primary), str(backup), ALIAS, str(result)], env=tool_environment(), check=True)
        fingerprint = result.read_text().strip()
    require(input("Confirm this verified backup is under your offline custody (type OFFLINE): ").strip() == "OFFLINE",
            "Offline custody not confirmed. Key and backup were preserved; do not regenerate them")
    config = {"keystore": str(primary), "alias": ALIAS, "backup": str(backup),
              "certificateSha256": fingerprint, "backupVerified": True}
    with tempfile.NamedTemporaryFile(mode="w", dir=KEY_DIR, prefix="config-", delete=False) as output:
        temporary_config = Path(output.name)
        json.dump(config, output, indent=2); output.write("\n")
        output.flush(); os.fsync(output.fileno())
    try:
        os.link(temporary_config, CONFIG)  # atomic, fails if any destination already exists
    finally:
        temporary_config.unlink()
    private_path(CONFIG)
    print("Release key and verified backup prepared. No app was installed.")


def release():
    config = validate_config()
    require(not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip(), "Commit the reviewed source before producing the release artifact")
    metadata = json.loads((ROOT / "release.json").read_text())
    target = ROOT / "dist/android" / f"oraculum-{metadata['version']}-{metadata['androidVersionCode']}.apk"
    if os.path.lexists(target):
        require(target.is_file() and not target.is_symlink(), "Existing artifact path preserved; inspect it locally")
        subprocess.run(["node", "scripts/verify-apk.mjs", str(target), "--expected-cert", config["certificateSha256"]], cwd=ROOT, env=tool_environment(), check=True)
        with zipfile.ZipFile(target) as archive:
            embedded = json.loads(archive.read("assets/oraculum-build.json"))
        current_git = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        require(embedded["sourceGit"] == current_git, "Existing version belongs to another source commit; increment the release version instead of overwriting")
        print(f"Existing signed release APK verified: {target}")
        return
    environment = tool_environment()
    subprocess.run(["bash", "scripts/android-release-build.sh", "--unsigned"], cwd=ROOT, env=environment, check=True)
    source = ROOT / "apps/android/app/build/outputs/apk/release/app-release-unsigned.apk"
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".signed-", dir=target.parent) as temporary:
        candidate = Path(temporary) / target.name
        # No password flags/env/files: apksigner defaults to Console.readPassword.
        # Explicit --out leaves the aligned unsigned input unchanged.
        subprocess.run([str(TOOLS / "android-sdk/build-tools/35.0.0/apksigner"), "sign",
                        "--ks", config["keystore"], "--ks-key-alias", config["alias"], "--ks-type", "JKS",
                        "--v4-signing-enabled", "false", "--out", str(candidate), str(source)],
                       env=environment, check=True)
        subprocess.run(["node", "scripts/verify-apk.mjs", str(candidate), "--expected-cert", config["certificateSha256"]], cwd=ROOT, env=environment, check=True)
        with candidate.open("rb") as completed:
            os.fsync(completed.fileno())
        os.link(candidate, target)  # publish a complete verified artifact; never overwrite
    subprocess.run(["node", "scripts/verify-apk.mjs", str(target), "--expected-cert", config["certificateSha256"]], cwd=ROOT, env=environment, check=True)
    print(f"Signed release APK: {target}")


if __name__ == "__main__":
    try:
        require(sys.stdin.isatty() and sys.stdout.isatty(), "Run in your own local terminal, never a captured agent terminal or pipe")
        require(len(sys.argv) == 2 and sys.argv[1] in {"init", "resume", "release"}, "Usage: python3 scripts/android-signing.py init|resume|release")
        os.umask(0o077)
        if sys.argv[1] == "release":
            release()
        else:
            initialize(resume=sys.argv[1] == "resume")
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError, KeyboardInterrupt, EOFError, StopIteration) as error:
        # Do not print subprocess argv/env, exception data, or private key contents.
        print(str(error) if isinstance(error, RuntimeError) else "Local signing stopped; existing keys are preserved. Inspect the terminal error above.", file=sys.stderr)
        sys.exit(1)
