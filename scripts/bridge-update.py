#!/usr/bin/env python3
"""Thin, explicit APT installer for the independently packaged Oraculum Bridge.

No install/update command starts, stops, enables or edits a service. Run as the
owning desktop user; only apt-get is elevated through sudo. Never restore a
state backup over a live store: rollback always validates the latest state.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone

REPOSITORY = 'rando1ph/oraculum'
PACKAGE = 'oraculum-bridge'
UNIT = 'oraculum-bridge.service'
ENTRY = '/usr/bin/oraculum-bridge'
PACKAGED_ENTRY = '/usr/lib/oraculum-bridge/bin/oraculum-bridge'
INSTALLED_RUNTIME = Path('/usr/lib/oraculum-bridge')
MANAGED_DROPIN = '90-oraculum-independent-bridge.conf'
CONFIG_KEYS = {'ORACULUM_STATE_DIR', 'ORACULUM_WORKSPACE', 'ORACULUM_USER_DATA_DIR',
               'ORACULUM_THEME_DIR', 'ORACULUM_THEME_SOURCE_DIR', 'ORACULUM_CODEX_BIN',
               'ORACULUM_PORT', 'ORACULUM_REMOTE_ORIGIN', 'ORACULUM_REMOTE_BASE_PATH',
               'CODEX_HOME', 'PATH'}

class Refused(RuntimeError):
    pass


def run(args, *, env=None, check=True):
    result = subprocess.run(args, env=env, text=True, capture_output='apt-get' not in args)
    if check and result.returncode:
        # Commands can include a private environment file; do not echo stdout.
        raise Refused(f'{args[0]} failed (exit {result.returncode}); inspect its local diagnostics')
    return result


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def absolute(path, label):
    value = Path(path)
    if not value.is_absolute() or any(ord(char) < 32 or ord(char) == 127 for char in str(value)):
        raise Refused(f'{label} must be an absolute path')
    if '..' in value.parts:
        raise Refused(f'{label} must be canonical')
    return value


def safe_path(path, *, private=False, regular=False):
    path = absolute(path, 'Selected path')
    for part in reversed([path, *path.parents]):
        if part.is_symlink():
            raise Refused('Selected path contains a symlink; select its canonical location explicitly')
    details = path.stat()
    if details.st_uid != os.getuid():
        raise Refused('Selected data must belong to the current user')
    if private and stat.S_IMODE(details.st_mode) & 0o077:
        raise Refused('Selected data must have private permissions')
    if regular and (not path.is_file() or details.st_nlink != 1):
        raise Refused('Selected file must be regular and have one link')
    return path


def load_config(environment):
    environment = dict(environment)
    home = absolute(environment.get('HOME', pwd.getpwuid(os.getuid()).pw_dir), 'HOME')
    config_home = environment.get('XDG_CONFIG_HOME', '')
    config_home = Path(config_home) if Path(config_home).is_absolute() else home / '.config'
    config = absolute(environment.get('ORACULUM_CONFIG_FILE', str(config_home / 'oraculum/runtime.json')), 'ORACULUM_CONFIG_FILE')
    if config.exists() or 'ORACULUM_CONFIG_FILE' in environment:
        safe_path(config, private=True, regular=True)
        values = json.loads(config.read_text())
        if not isinstance(values, dict) or any(key not in CONFIG_KEYS or not isinstance(value, str)
                or any(ord(char) < 32 or ord(char) == 127 for char in value) for key, value in values.items()):
            raise Refused('Invalid runtime configuration')
        for key, value in values.items():
            environment.setdefault(key, value)
    state_home = environment.get('XDG_STATE_HOME', '')
    state_home = Path(state_home) if Path(state_home).is_absolute() else home / '.local/state'
    state = absolute(environment.get('ORACULUM_STATE_DIR', str(state_home / 'oraculum')), 'ORACULUM_STATE_DIR')
    profile = absolute(environment.get('ORACULUM_USER_DATA_DIR', str(config_home / 'oraculum')), 'ORACULUM_USER_DATA_DIR')
    environment['HOME'] = str(home)
    return {'environment': environment, 'config': config, 'state': state, 'profile': profile,
            'theme': absolute(environment.get('ORACULUM_THEME_DIR', str(state / 'themes')), 'ORACULUM_THEME_DIR')}


def assignments(text):
    if '\\' in text:
        raise Refused('Escaped systemd environment values need manual review')
    values = {}
    for assignment in shlex.split(text):
        if '=' not in assignment:
            raise Refused('Unsupported systemd environment syntax; review it manually')
        key, value = assignment.split('=', 1)
        if not re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', key):
            raise Refused('Invalid systemd environment key')
        values[key] = value
    return values


def environment_file(path):
    # The supported conservative subset is deliberately non-executable. Do not
    # source files, expand shell commands, or guess multiline systemd semantics.
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(('#', ';')):
            continue
        if line.endswith('\\'):
            raise Refused('Multiline EnvironmentFile needs manual review')
        values.update(assignments(line))
    return values


def discover(runner=run):
    result = runner(['systemctl', '--user', 'show', UNIT, '--no-pager',
                     '--property=LoadState,ActiveState,FragmentPath,DropInPaths,Environment,EnvironmentFiles,MainPID,ExecStart,UnsetEnvironment,PassEnvironment,PAMName,RootDirectory,RootImage'], check=False)
    if result.returncode:
        raise Refused('Cannot query the user service manager; run from the owning user session')
    unit = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    for key in ('UnsetEnvironment', 'PassEnvironment', 'PAMName', 'RootDirectory', 'RootImage'):
        if unit.get(key):
            raise Refused(f'Unsupported service {key}; review the effective environment manually')
    manager = runner(['systemctl', '--user', 'show-environment'])
    env = assignments(manager.stdout)
    env.setdefault('HOME', pwd.getpwuid(os.getuid()).pw_dir)
    env.update(assignments(unit.get('Environment', '')))
    # `show` prints canonical paths with '(ignore_errors=yes|no)' suffixes.
    files = unit.get('EnvironmentFiles', '')
    matches = list(re.finditer(r'(.+?)\s+\(ignore_errors=(yes|no)\)(?:\s+|$)', files))
    if files and (not matches or ''.join(match.group(0) for match in matches).strip() != files.strip()):
        raise Refused('Unsupported EnvironmentFiles representation; review effective service environment manually')
    for match in matches:
        name = match.group(1).strip()
        if any(char in name for char in ['%', '$', '*', '?', '[']):
            raise Refused('Dynamic EnvironmentFile paths need manual review')
        path = absolute(name, 'EnvironmentFile')
        if not path.exists() and match.group(2) == 'yes':
            continue
        safe_path(path, private=True, regular=True)
        env.update(environment_file(path))
    active = unit.get('ActiveState') not in {'inactive', 'failed', ''}
    pid = int(unit.get('MainPID', '0'))
    if active and pid:
        proc = Path(f'/proc/{pid}')
        if proc.stat().st_uid != os.getuid():
            raise Refused('Bridge PID does not belong to current user')
        raw = (proc / 'environ').read_bytes()
        env = dict(item.decode().split('=', 1) for item in raw.split(b'\0') if b'=' in item)
    selected = load_config(env)
    selected['unit'] = unit
    selected['active'] = active
    return selected


def database_info(path):
    safe_path(path, private=True, regular=True)
    connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    try:
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise Refused('SQLite integrity preflight failed')
        schema = connection.execute('PRAGMA user_version').fetchone()[0]
        counts = {}
        for name in ('devices', 'projects', 'send_receipts', 'native_operations', 'attachments'):
            if connection.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", (name,)).fetchone():
                counts[name] = connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
        return {'schemaVersion': schema, 'rowCounts': counts}
    finally:
        connection.close()


def database_fingerprint(path):
    return {suffix: sha256(Path(str(path) + suffix)) if Path(str(path) + suffix).exists() else None
            for suffix in ('', '-wal', '-shm')}


def copy_private(source, target, *, skip=()):
    """Copy owned data without following symlinks or copying SQLite sidecars."""
    safe_path(source)
    if source.is_dir():
        target.mkdir(mode=0o700)
        for child in source.iterdir():
            if child.name not in skip:
                copy_private(child, target / child.name)
    else:
        safe_path(source, regular=True)
        if not source.is_file():
            raise Refused('Special data file requires manual backup')
        shutil.copyfile(source, target)
        target.chmod(0o600)


def backup(selected, destination):
    if selected['active']:
        raise Refused('Stop the Bridge in an approved maintenance window before backup or package replacement')
    destination = absolute(destination, 'Backup destination')
    if destination.exists():
        raise Refused('Backup destination already exists; use a new private directory')
    safe_path(destination.parent, private=True)
    state = selected['state']
    safe_path(state, private=True)
    info = database_info(state / 'trust.sqlite')
    for source in (state, selected['profile'], selected['theme']):
        if destination == source or source in destination.parents or destination in source.parents:
            raise Refused('Backup destination must be outside every selected data directory')
    destination.mkdir(mode=0o700)
    try:
        # Always use SQLite's Backup API, including WAL-mode stores. Other state
        # and the Desktop profile are copied only while the Bridge is stopped;
        # the user must also close Desktop before taking its profile snapshot.
        copy_private(state, destination / 'state', skip=('trust.sqlite', 'trust.sqlite-wal', 'trust.sqlite-shm'))
        target = destination / 'state/trust.sqlite'
        src = sqlite3.connect((state / 'trust.sqlite').as_uri() + '?mode=ro', uri=True)
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
            # Produce a self-contained portable snapshot, without WAL sidecars.
            dst.execute('PRAGMA journal_mode=DELETE')
        finally:
            src.close()
            dst.close()
        target.chmod(0o600)
        if selected['config'].exists():
            copy_private(selected['config'], destination / 'runtime.json')
        if selected['profile'].exists():
            copy_private(selected['profile'], destination / 'desktop-profile')
        if selected['theme'].exists() and selected['theme'] != state / 'themes':
            copy_private(selected['theme'], destination / 'external-themes')
        unit_files = []
        fragment = selected['unit'].get('FragmentPath', '')
        for index, filename in enumerate(([fragment] if fragment else []) + shlex.split(selected['unit'].get('DropInPaths', ''))):
            path = absolute(filename, 'Unit path')
            # Unit fragments may be root-owned package resources and linked.
            if not path.is_file():
                raise Refused('Service fragment or drop-in is missing')
            output = destination / f'unit-{index}.conf'
            output.write_bytes(path.read_bytes())
            output.chmod(0o600)
            unit_files.append({'path': str(path), 'sha256': sha256(output), 'backup': output.name})
        manifest = {'format': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
                    'state': str(state), 'config': str(selected['config']), 'profile': str(selected['profile']),
                    'theme': str(selected['theme']), 'database': info, 'databaseSha256': sha256(target),
                    'unitFiles': unit_files,
                    'attachmentPolicy': 'Project inboxes stay at original paths; no project or Codex directories are moved or copied.',
                    'restorePolicy': 'Never restore this snapshot over newer Receipts; binary rollback validates the latest database.'}
        (destination / 'backup.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (destination / 'backup.json').chmod(0o600)
        if database_info(target) != info:
            raise Refused('SQLite backup verification failed')
        return manifest
    except Exception:
        # Keep a failed snapshot for diagnosis. It is never used automatically.
        (destination / 'INCOMPLETE').write_text('Backup failed; do not use as a restore source.\n')
        (destination / 'INCOMPLETE').chmod(0o600)
        raise


def get_json(url):
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Oraculum-Bridge-APT'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def trusted_asset_url(url, tag, name):
    expected = f'https://github.com/{REPOSITORY}/releases/download/{tag}/{name}'
    if url != expected:
        raise Refused('Release asset is outside the approved repository/tag')
    return url


def download(url, destination):
    # GitHub serves binaries using HTTPS object-storage redirects. The initial
    # URL is exact-matched above; every redirect must retain HTTPS transport.
    class HTTPSRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            if urllib.parse.urlparse(newurl).scheme != 'https':
                raise Refused('Release download redirected away from HTTPS')
            return super().redirect_request(req, fp, code, msg, headers, newurl)
    opener = urllib.request.build_opener(HTTPSRedirect())
    with opener.open(url, timeout=60) as response, open(destination, 'xb') as output:
        shutil.copyfileobj(response, output)
    destination.chmod(0o600)


def release_candidate(version, directory, architecture, fetch=get_json, downloader=download):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise Refused('An explicit stable Bridge version is required (for example 0.2.0)')
    tag = f'bridge-v{version}'
    release = fetch(f'https://api.github.com/repos/{REPOSITORY}/releases/tags/{tag}')
    if release.get('tag_name') != tag or release.get('draft') is not False or release.get('prerelease') is not False or not release.get('published_at'):
        raise Refused('Only approved published stable Bridge releases may be installed')
    assets = release.get('assets', [])
    manifest_assets = [item for item in assets if item.get('name') == 'bridge-release.json']
    if len(manifest_assets) != 1:
        raise Refused('Release must contain exactly one Bridge manifest')
    manifest_url = trusted_asset_url(manifest_assets[0]['browser_download_url'], tag, 'bridge-release.json')
    manifest_path = directory / 'bridge-release.json'
    downloader(manifest_url, manifest_path)
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get('format') != 1 or manifest.get('component') != 'bridge' or manifest.get('version') != version
            or manifest.get('tag') != tag or manifest.get('sourceRepository') != REPOSITORY
            or not re.fullmatch('[0-9a-f]{40}', manifest.get('sourceGit', ''))
            or manifest.get('protocolVersion') != 1 or not isinstance(manifest.get('stateSchemaVersion'), int)):
        raise Refused('Release manifest identity/source does not match requested Bridge')
    candidates = [item for item in manifest.get('artifacts', []) if item.get('architecture') == architecture]
    if len(candidates) != 1:
        raise Refused('Release does not contain exactly one artifact for this architecture')
    artifact = candidates[0]
    name = f'{PACKAGE}_{version}_{architecture}.deb'
    if artifact.get('name') != name or not re.fullmatch('[0-9a-f]{64}', artifact.get('sha256', '')):
        raise Refused('Invalid Bridge DEB artifact identity/hash')
    matching = [item for item in assets if item.get('name') == name]
    if len(matching) != 1:
        raise Refused('Release DEB asset is missing or duplicated')
    path = directory / name
    downloader(trusted_asset_url(matching[0]['browser_download_url'], tag, name), path)
    if path.stat().st_size != artifact.get('size'):
        raise Refused('Release artifact size mismatch')
    return path, artifact['sha256'], manifest


def validate_deb(path, expected_hash, version, directory, runner=run, expected_git=None, expected_protocol=None, expected_schema=None):
    path = absolute(path, 'DEB path')
    safe_path(path, regular=True)
    if not re.fullmatch('[0-9a-f]{64}', expected_hash) or sha256(path) != expected_hash:
        raise Refused('DEB SHA256 mismatch')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise Refused('Explicit stable DEB version required')
    # A private staged copy closes the source-file replacement window before APT.
    staged = directory / 'validated.deb'
    shutil.copyfile(path, staged)
    staged.chmod(0o600)
    if sha256(staged) != expected_hash:
        raise Refused('DEB changed during validation')
    path = staged
    architecture = runner(['dpkg', '--print-architecture']).stdout.strip()
    if architecture != 'amd64':
        raise Refused('This Bridge release currently supports Ubuntu amd64 only')
    fields = runner(['dpkg-deb', '--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', str(path)]).stdout.splitlines()
    if fields != [PACKAGE, version, architecture]:
        raise Refused('DEB package/version/architecture does not match requested Bridge')
    control = directory / 'control'
    runner(['dpkg-deb', '--control', str(path), str(control)])
    if any(item.name != 'control' for item in control.iterdir()):
        raise Refused('Bridge DEB contains unexpected maintainer scripts or control side effects')
    extracted = directory / 'package'
    runner(['dpkg-deb', '--extract', str(path), str(extracted)])
    runtime = extracted / 'usr/lib/oraculum-bridge'
    build = json.loads((runtime / 'build.json').read_text())
    if (build.get('component') != 'bridge' or build.get('packageName') != PACKAGE or build.get('version') != version
            or build.get('architecture') != architecture or not re.fullmatch('[0-9a-f]{40}', build.get('git', ''))
            or build.get('sourceDirty') is not False or (expected_git and build.get('git') != expected_git)):
        raise Refused('DEB build identity/source is not a clean matching Bridge build')
    if (not isinstance(build.get('schemaMin'), int) or not isinstance(build.get('schemaMax'), int)
            or build['schemaMin'] < 0 or build['schemaMax'] < build['schemaMin']):
        raise Refused('DEB does not declare a supported state schema range')
    if (build.get('protocolVersion') != 1 or build.get('stateSchemaVersion') != build['schemaMax']
            or (expected_protocol is not None and build['protocolVersion'] != expected_protocol)
            or (expected_schema is not None and build['stateSchemaVersion'] != expected_schema)):
        raise Refused('DEB protocol/schema provenance is incompatible or mismatched')
    return {'path': path, 'version': version, 'runtime': runtime, 'build': build, 'sha256': expected_hash}


def resource_overrides(selected):
    # These effective settings survive a service switch. Testing different
    # defaults must not conceal a resource tree removed by the Desktop upgrade.
    legacy = Path('/usr/lib/oraculum/resources/runtime')
    overrides = {}
    for key in ('ORACULUM_WEB_DIR', 'ORACULUM_THEME_SOURCE_DIR'):
        value = selected['environment'].get(key)
        if value is None:
            continue
        path = absolute(value, key)
        resolved = path.resolve()
        if any(candidate == legacy or legacy in candidate.parents for candidate in (path, resolved)):
            raise Refused(f'{key} still selects legacy packaged resources; review and remove that override before replacing packages')
        if resolved != path:
            raise Refused(f'{key} custom resources must use a canonical directory without symlinks')
        if not path.is_dir() or (key == 'ORACULUM_WEB_DIR' and not (path / 'index.html').is_file()):
            raise Refused(f'{key} selects missing custom resources; repair the effective configuration before replacing packages')
        overrides[key] = str(path)
    return overrides


def preflight(candidate, selected, snapshot, runner=run):
    overrides = resource_overrides(selected)
    info = database_info(snapshot / 'state/trust.sqlite')
    before_hash = database_fingerprint(snapshot / 'state/trust.sqlite')
    build = candidate['build']
    if not build['schemaMin'] <= info['schemaVersion'] <= build['schemaMax']:
        raise Refused('Latest database schema is incompatible; automatic binary rollback/replacement is blocked')
    environment = dict(selected['environment'])
    environment.pop('ORACULUM_INIT_STATE', None)
    environment['ORACULUM_STATE_DIR'] = str(snapshot / 'state')
    environment['ORACULUM_RESOURCE_DIR'] = str(candidate['runtime'])
    environment['ORACULUM_WEB_DIR'] = overrides.get('ORACULUM_WEB_DIR', str(candidate['runtime'] / 'apps/web/dist'))
    environment['ORACULUM_THEME_SOURCE_DIR'] = overrides.get('ORACULUM_THEME_SOURCE_DIR', str(candidate['runtime'] / 'themes'))
    # Direct invocation avoids an extracted /usr/bin link resolving against the
    # host. Candidate preflight must never start Codex or write state.
    runner([str(candidate['runtime'] / 'node/bin/node'), str(candidate['runtime'] / 'bridge/preflight.mjs')], env=environment)
    if database_info(snapshot / 'state/trust.sqlite') != info or database_fingerprint(snapshot / 'state/trust.sqlite') != before_hash:
        raise Refused('Candidate preflight unexpectedly changed copied state')
    return info


def installed_version(runner=run):
    result = runner(['dpkg-query', '--show', '--showformat=${db:Status-Status}\n${Version}\n', PACKAGE], check=False)
    fields = result.stdout.splitlines()
    return fields[1] if result.returncode == 0 and len(fields) == 2 and fields[0] == 'installed' else None


def apt_install(candidate, runner=run, *, downgrade=False):
    command = ['apt-get', 'install', '--yes', '--no-install-recommends']
    if downgrade:
        command.append('--allow-downgrades')
    command += ['--', str(candidate['path'])]
    if os.geteuid() != 0:
        command = ['sudo', '--', *command]
    return runner(command, check=False)


def apply_package(action, candidate, selected, snapshot, previous=None, runner=run):
    resource_overrides(selected)
    current = installed_version(runner)
    if action == 'install' and current:
        raise Refused('Bridge is already installed; use update or rollback')
    if action in {'update', 'rollback'} and not current:
        raise Refused('No independently installed Bridge package to update/rollback')
    if action in {'update', 'rollback'}:
        if not previous or previous['version'] != current:
            raise Refused('Replacement requires a verified previous DEB matching the installed version for failure recovery')
    if action == 'update':
        if runner(['dpkg', '--compare-versions', candidate['version'], 'gt', current], check=False).returncode:
            raise Refused('Update version must be newer than the installed Bridge')
    if action == 'rollback' and runner(['dpkg', '--compare-versions', candidate['version'], 'lt', current], check=False).returncode:
        raise Refused('Rollback must select an older version')
    if selected['active']:
        raise Refused('Bridge must be stopped before replacing its package')
    if snapshot:
        preflight(candidate, selected, snapshot, runner)
        if previous:
            preflight(previous, selected, snapshot, runner)
    result = apt_install(candidate, runner, downgrade=action == 'rollback')
    if result.returncode or installed_version(runner) != candidate['version']:
        recovered = False
        if previous:
            # This validates a newly made copy of the latest state if a future
            # maintainer script/service accidentally wrote anything. No old DB
            # snapshot is ever copied back, even during failure recovery.
            with tempfile.TemporaryDirectory(prefix='oraculum-latest-', dir=snapshot.parent) as folder:
                latest = Path(folder) / 'backup'
                backup(selected, latest)
                preflight(previous, selected, latest, runner)
                recovery = apt_install(previous, runner, downgrade=True)
                recovered = recovery.returncode == 0 and installed_version(runner) == current
        raise Refused('APT replacement failed; ' + ('previous package restored; latest state retained' if recovered else 'manual native APT recovery required; state retained'))
    return {'package': PACKAGE, 'version': candidate['version'], 'serviceChanged': False, 'started': False,
            'backup': str(snapshot) if snapshot else None, 'stateRestored': False}


def service_switch(selected, backup_dir, runner=run):
    resource_overrides(selected)
    if selected['active']:
        raise Refused('Stop the existing Bridge before explicitly switching its service entry')
    if installed_version(runner) is None or not Path(ENTRY).is_file():
        raise Refused('Install and verify the independent Bridge package before service switching')
    backup_dir = absolute(backup_dir, 'Service backup')
    backup(selected, backup_dir)
    home = Path(selected['environment']['HOME'])
    config_home = Path(selected['environment'].get('XDG_CONFIG_HOME', str(home / '.config')))
    if not config_home.is_absolute():
        config_home = home / '.config'
    unit_dir = config_home / 'systemd/user'
    safe_path(unit_dir)
    user_unit = unit_dir / UNIT
    dropin_dir = unit_dir / (UNIT + '.d')
    if dropin_dir.exists():
        safe_path(dropin_dir)
    dropin = dropin_dir / MANAGED_DROPIN
    if dropin.exists() or dropin.is_symlink():
        raise Refused('Managed service switch already exists; inspect or restore it first')
    fragment = Path(selected['unit'].get('FragmentPath', ''))
    if not fragment.is_file():
        raise Refused('No existing service fragment to preserve')
    prior = {'unitPath': str(user_unit), 'dropinPath': str(dropin), 'unitExisted': user_unit.exists() or user_unit.is_symlink(),
             'linkTarget': os.readlink(user_unit) if user_unit.is_symlink() else None,
             'unitMode': stat.S_IMODE(user_unit.stat().st_mode) if user_unit.exists() else None}
    if user_unit.exists() and not user_unit.is_symlink():
        safe_path(user_unit, regular=True)
        (backup_dir / 'user-unit').write_bytes(user_unit.read_bytes())
        (backup_dir / 'user-unit').chmod(0o600)
    prior['materializedSha256'] = sha256(fragment)
    (backup_dir / 'service-switch.json').write_text(json.dumps(prior, indent=2) + '\n')
    (backup_dir / 'service-switch.json').chmod(0o600)
    # Materialize the original fragment so a legacy link cannot break when the
    # Desktop package removes its runtime. Existing drop-ins stay untouched.
    content = fragment.read_bytes()
    if user_unit.is_symlink():
        user_unit.unlink()
    user_unit.write_bytes(content)
    user_unit.chmod(0o600)
    dropin_dir.mkdir(mode=0o700, exist_ok=True)
    dropin.write_text('[Service]\nExecStart=\nExecStart=/usr/bin/oraculum-bridge\n')
    dropin.chmod(0o600)
    try:
        runner(['systemctl', '--user', 'daemon-reload'])
        effective = runner(['systemctl', '--user', 'show', UNIT, '--property=ExecStart', '--value']).stdout
        if not re.search(r'path=/usr/bin/oraculum-bridge\s*;', effective):
            raise Refused('Another unit override still selects an old service entry')
    except Exception:
        service_restore(backup_dir, runner, require_inactive=False)
        raise
    return {'serviceChanged': True, 'started': False, 'backup': str(backup_dir), 'entry': ENTRY}


def service_restore(backup_dir, runner=run, require_inactive=True):
    backup_dir = safe_path(backup_dir, private=True)
    if require_inactive:
        state = runner(['systemctl', '--user', 'show', UNIT, '--property=ActiveState', '--value']).stdout.strip()
        if state not in {'inactive', 'failed'}:
            raise Refused('Stop Bridge before restoring its previous unit entry')
    saved = json.loads((backup_dir / 'service-switch.json').read_text())
    user_unit = absolute(saved['unitPath'], 'Saved unit path')
    dropin = absolute(saved['dropinPath'], 'Saved override path')
    if dropin.name != MANAGED_DROPIN or user_unit.name != UNIT:
        raise Refused('Invalid service backup manifest')
    safe_path(user_unit, regular=True)
    if sha256(user_unit) != saved.get('materializedSha256'):
        raise Refused('Service fragment changed since switch; manual review required')
    expected = '[Service]\nExecStart=\nExecStart=/usr/bin/oraculum-bridge\n'
    if dropin.is_symlink() or not dropin.is_file() or dropin.read_text() != expected:
        raise Refused('Service switch changed since backup; manual review required')
    if saved['linkTarget']:
        target = Path(saved['linkTarget'])
        target = target if target.is_absolute() else user_unit.parent / target
        if not target.is_file():
            raise Refused('Legacy service program has been removed; restore the old Desktop package before its service link')
    dropin.unlink()
    user_unit.unlink()
    if saved['linkTarget']:
        user_unit.symlink_to(saved['linkTarget'])
    elif saved['unitExisted']:
        user_unit.write_bytes((backup_dir / 'user-unit').read_bytes())
        user_unit.chmod(saved.get('unitMode', 0o600))
    runner(['systemctl', '--user', 'daemon-reload'])
    return {'serviceRestored': True, 'started': False, 'stateRestored': False}


def desktop_preflight(selected, runner=run):
    resource_overrides(selected)
    version = installed_version(runner)
    if not version:
        raise Refused('Independent Bridge package is missing; install it before upgrading Desktop')
    unit = selected['unit']
    if '/usr/lib/oraculum/resources/runtime' in json.dumps(unit):
        raise Refused('Legacy Bridge service path remains; complete explicit service-switch before upgrading Desktop')
    entries = re.findall(r'path=([^;]+?)\s*;', unit.get('ExecStart', ''))
    if len(entries) != 1 or entries[0] not in {ENTRY, PACKAGED_ENTRY}:
        raise Refused('Effective user service must select exactly one approved independent Bridge entry before Desktop upgrade')
    safe_path(selected['state'], private=True)
    safe_path(selected['profile'], private=True)
    safe_path(selected['config'], private=True, regular=True)
    database_info(selected['state'] / 'trust.sqlite')
    build = json.loads((INSTALLED_RUNTIME / 'build.json').read_text())
    if (build.get('component') != 'bridge' or build.get('packageName') != PACKAGE or build.get('version') != version
            or build.get('protocolVersion') != 1 or not isinstance(build.get('schemaMin'), int)
            or not isinstance(build.get('schemaMax'), int)):
        raise Refused('Installed Bridge identity/schema is invalid or incompatible')
    # Validate only a consistent temporary DB copy. The guard does not migrate,
    # initialize, start, stop, or mutate the selected state/profile/service.
    with tempfile.TemporaryDirectory(prefix='oraculum-desktop-preflight-') as folder:
        snapshot = Path(folder)
        (snapshot / 'state').mkdir(mode=0o700)
        copied = snapshot / 'state/trust.sqlite'
        source = sqlite3.connect((selected['state'] / 'trust.sqlite').as_uri() + '?mode=ro', uri=True)
        target = sqlite3.connect(copied)
        try:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
        finally:
            source.close()
            target.close()
        copied.chmod(0o600)
        preflight({'build': build, 'runtime': INSTALLED_RUNTIME}, selected, snapshot, runner)
    return {'desktopUpgradeReady': True, 'bridgeVersion': version, 'entry': entries[0], 'productionChanges': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status', 'backup', 'install', 'update', 'rollback', 'service-switch', 'service-restore', 'desktop-preflight'])
    parser.add_argument('--version', help='Exact stable Bridge version; no implicit latest')
    parser.add_argument('--deb', type=Path, help='Explicit reviewed local candidate DEB (not a remote source override)')
    parser.add_argument('--sha256', help='Independently reviewed SHA256 for --deb')
    parser.add_argument('--backup-dir', type=Path, help='New private backup directory (or saved switch for service-restore)')
    parser.add_argument('--previous-deb', type=Path)
    parser.add_argument('--previous-sha256')
    parser.add_argument('--previous-version')
    parser.add_argument('--fresh-install', action='store_true', help='Install binaries only with deliberately absent state; never initializes a database')
    args = parser.parse_args(argv)
    os.umask(0o077)
    if os.getuid() == 0:
        raise Refused('Run as the owning desktop user; the tool elevates only APT through sudo')
    if args.action == 'service-restore':
        if not args.backup_dir:
            parser.error('--backup-dir is required')
        return service_restore(args.backup_dir)
    selected = discover()
    if args.action == 'desktop-preflight':
        return desktop_preflight(selected)
    if args.action == 'status':
        database = selected['state'] / 'trust.sqlite'
        return {'package': PACKAGE, 'installedVersion': installed_version(), 'active': selected['active'],
                'config': str(selected['config']), 'state': str(selected['state']), 'profile': str(selected['profile']),
                'unitFragment': selected['unit'].get('FragmentPath'), 'dropIns': shlex.split(selected['unit'].get('DropInPaths', '')),
                'database': database_info(database) if database.exists() else None,
                'productionChanges': False}
    if not args.backup_dir and not (args.action == 'install' and args.fresh_install):
        parser.error('--backup-dir is required')
    if args.action == 'backup':
        return backup(selected, args.backup_dir)
    if args.action == 'service-switch':
        return service_switch(selected, args.backup_dir)
    if not args.version:
        parser.error('--version is required')
    if args.fresh_install and (args.action != 'install' or selected['state'].exists() or selected['active']):
        raise Refused('--fresh-install is only valid for an inactive installation without an existing state directory')
    with tempfile.TemporaryDirectory(prefix='oraculum-apt-') as folder:
        temporary = Path(folder)
        source = None
        if args.deb:
            if not args.sha256:
                parser.error('Local review candidate requires --deb, --sha256 and --version')
            path, digest = args.deb, args.sha256
        else:
            arch = run(['dpkg', '--print-architecture']).stdout.strip()
            path, digest, source = release_candidate(args.version, temporary, arch)
        candidate_dir = temporary / 'candidate'
        candidate_dir.mkdir(mode=0o700)
        candidate = validate_deb(path, digest, args.version, candidate_dir,
                                 expected_git=source['sourceGit'] if source else None,
                                 expected_protocol=source.get('protocolVersion') if source else None,
                                 expected_schema=source.get('stateSchemaVersion') if source else None)
        previous = None
        if any([args.previous_deb, args.previous_sha256, args.previous_version]):
            if not all([args.previous_deb, args.previous_sha256, args.previous_version]):
                parser.error('Previous DEB requires all --previous-deb/--previous-sha256/--previous-version')
            previous_dir = temporary / 'previous'
            previous_dir.mkdir(mode=0o700)
            previous = validate_deb(args.previous_deb, args.previous_sha256, args.previous_version, previous_dir)
        snapshot = None
        if not args.fresh_install:
            snapshot = args.backup_dir
            backup(selected, snapshot)
        return apply_package(args.action, candidate, selected, snapshot, previous)


if __name__ == '__main__':
    try:
        print(json.dumps(main(), indent=2))
    except (Refused, OSError, ValueError, TypeError, sqlite3.Error) as error:
        print(f'Refused: {error}', file=sys.stderr)
        sys.exit(1)
