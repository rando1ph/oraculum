#!/usr/bin/env python3
"""Isolated updater tests: only fixture DEBs/SQLite; no host package/service writes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('bridge_update', Path(__file__).with_name('bridge-update.py'))
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


def result(stdout='', code=0):
    return subprocess.CompletedProcess([], code, stdout, '')


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='oraculum-updater-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.profile = self.root / 'profile'
        self.profile.mkdir(mode=0o700)
        (self.profile / 'Preferences').write_text('{"theme":"retained"}')
        self.db = sqlite3.connect(self.state / 'trust.sqlite')
        self.addCleanup(self.db.close)
        self.db.executescript('PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE devices(id TEXT); INSERT INTO devices VALUES("paired"); CREATE TABLE send_receipts(id TEXT); INSERT INTO send_receipts VALUES("before");')
        (self.state / 'trust.sqlite').chmod(0o600)
        self.config = self.root / 'runtime.json'
        self.config.write_text(json.dumps({'ORACULUM_STATE_DIR': str(self.state), 'ORACULUM_USER_DATA_DIR': str(self.profile)}))
        self.config.chmod(0o600)
        self.selected = u.load_config({'HOME': str(self.root), 'ORACULUM_CONFIG_FILE': str(self.config)})
        self.selected.update(unit={}, active=False)

    def snapshot(self, name='backup'):
        path = self.root / name
        u.backup(self.selected, path)
        return path

    def candidate(self, version='0.2.1', **build):
        return {'path': self.root / f'bridge-{version}.deb', 'version': version, 'runtime': self.root / 'runtime',
                'build': {'schemaMin': 0, 'schemaMax': 1, **build}}

    def test_wal_backup_preserves_pairing_receipts_and_profile(self):
        snapshot = self.snapshot()
        copied = sqlite3.connect(snapshot / 'state/trust.sqlite')
        self.addCleanup(copied.close)
        self.assertEqual(copied.execute('SELECT * FROM devices').fetchall(), [('paired',)])
        self.assertEqual(copied.execute('SELECT * FROM send_receipts').fetchall(), [('before',)])
        self.assertEqual((snapshot / 'desktop-profile/Preferences').read_text(), '{"theme":"retained"}')
        self.assertFalse((snapshot / 'state/trust.sqlite-wal').exists())
        self.assertEqual(u.database_info(snapshot / 'state/trust.sqlite')['schemaVersion'], 1)
        self.assertEqual((snapshot / 'state/trust.sqlite').stat().st_mode & 0o777, 0o600)

    def test_backup_refuses_active_service_existing_destination_and_overlap(self):
        self.selected['active'] = True
        with self.assertRaisesRegex(u.Refused, 'Stop the Bridge'):
            self.snapshot()
        self.selected['active'] = False
        with self.assertRaisesRegex(u.Refused, 'already exists'):
            u.backup(self.selected, self.state)
        with self.assertRaisesRegex(u.Refused, 'outside'):
            u.backup(self.selected, self.state / 'backup')

    def test_backup_rejects_symlink_and_public_data(self):
        (self.state / 'redirect').symlink_to(self.profile)
        with self.assertRaisesRegex(u.Refused, 'symlink'):
            self.snapshot()
        self.assertTrue((self.root / 'backup/INCOMPLETE').exists())
        (self.state / 'redirect').unlink()
        self.state.chmod(0o755)
        with self.assertRaisesRegex(u.Refused, 'private'):
            self.snapshot('second')

    def test_runtime_config_environment_precedence_and_invalid_config(self):
        selected = u.load_config({'HOME': str(self.root), 'ORACULUM_CONFIG_FILE': str(self.config), 'ORACULUM_STATE_DIR': '/explicit/override'})
        self.assertEqual(selected['state'], Path('/explicit/override'))
        self.config.write_text('{"ORACULUM_INIT_STATE":"1"}')
        with self.assertRaisesRegex(u.Refused, 'Invalid runtime'):
            u.load_config({'HOME': str(self.root), 'ORACULUM_CONFIG_FILE': str(self.config)})

    def test_effective_service_environment_files_override_manager_unit_and_config(self):
        environment = self.root / 'service.env'
        environment.write_text(f'ORACULUM_STATE_DIR="{self.state}"\n# no execution\nORACULUM_PORT=17991\n')
        environment.chmod(0o600)
        def runner(args, **_):
            if 'show-environment' in args:
                return result(f'HOME={self.root}\nORACULUM_CONFIG_FILE={self.config}\nORACULUM_PORT=17989\n')
            return result(f'ActiveState=inactive\nMainPID=0\nEnvironment=ORACULUM_PORT=17990\nEnvironmentFiles={environment} (ignore_errors=no)\n')
        selected = u.discover(runner)
        self.assertEqual(selected['environment']['ORACULUM_PORT'], '17991')
        self.assertEqual(selected['profile'], self.profile)

    def test_environment_file_never_executes_shell(self):
        environment = self.root / 'service.env'
        environment.write_text('ORACULUM_WORKSPACE=$(touch /unwanted)\n')
        with self.assertRaises(u.Refused):
            u.environment_file(environment)
        environment.write_text('ORACULUM_WORKSPACE="$(touch /unwanted)"\n')
        self.assertEqual(u.environment_file(environment)['ORACULUM_WORKSPACE'], '$(touch /unwanted)')

    def test_candidate_preflight_uses_copy_and_rejects_future_schema(self):
        snapshot = self.snapshot()
        calls = []
        def runner(args, **kwargs):
            calls.append((args, kwargs))
            return result('{"compatible":true}')
        u.preflight(self.candidate(), self.selected, snapshot, runner)
        environment = calls[0][1]['env']
        self.assertEqual(environment['ORACULUM_STATE_DIR'], str(snapshot / 'state'))
        self.assertNotIn('ORACULUM_INIT_STATE', environment)
        self.assertEqual(environment['ORACULUM_WEB_DIR'], str(self.root / 'runtime/apps/web/dist'))
        self.db.execute('PRAGMA user_version=2')
        with self.assertRaisesRegex(u.Refused, 'incompatible'):
            u.preflight(self.candidate(), self.selected, self.snapshot('future'), runner)
        self.assertEqual(len(calls), 1)

    def test_preflight_rejects_modification_to_copy(self):
        snapshot = self.snapshot()
        def runner(args, **kwargs):
            connection = sqlite3.connect(Path(kwargs['env']['ORACULUM_STATE_DIR']) / 'trust.sqlite')
            connection.execute('INSERT INTO send_receipts VALUES("unexpected")')
            connection.commit()
            connection.close()
            return result()
        with self.assertRaisesRegex(u.Refused, 'changed copied state'):
            u.preflight(self.candidate(), self.selected, snapshot, runner)
        self.assertEqual(self.db.execute('SELECT * FROM send_receipts').fetchall(), [('before',)])

    def test_install_never_calls_systemctl_or_initializes_database(self):
        calls = []
        version = [None]
        def runner(args, **kwargs):
            calls.append(args)
            if args[0] == 'dpkg-query':
                return result(f'installed\n{version[0]}\n') if version[0] else result(code=1)
            if 'apt-get' in args:
                version[0] = '0.2.1'
            return result()
        report = u.apply_package('install', self.candidate(), self.selected, self.snapshot(), runner=runner)
        self.assertEqual(report['version'], '0.2.1')
        self.assertFalse(report['serviceChanged'])
        self.assertFalse(any('systemctl' in args for args in calls))

    def test_update_requires_current_verified_previous_package(self):
        def runner(args, **_):
            return result('installed\n0.2.0\n')
        with self.assertRaisesRegex(u.Refused, 'previous DEB'):
            u.apply_package('update', self.candidate(), self.selected, self.snapshot(), runner=runner)

    def test_apt_failure_restores_binary_but_preserves_latest_receipts(self):
        snapshot = self.snapshot()
        current = ['0.2.0']
        apt_calls = []
        def runner(args, **kwargs):
            if args[0] == 'dpkg-query':
                return result(f'installed\n{current[0]}\n')
            if 'apt-get' in args:
                apt_calls.append(args)
                if len(apt_calls) == 1:
                    # Model an interrupted unpack after new writes occurred.
                    self.db.execute('INSERT INTO send_receipts VALUES("new-after-backup")')
                    self.db.commit()
                    current[0] = '0.2.1'
                    return result(code=100)
                current[0] = '0.2.0'
            return result()
        with self.assertRaisesRegex(u.Refused, 'previous package restored; latest state retained'):
            u.apply_package('update', self.candidate(), self.selected, snapshot, self.candidate('0.2.0'), runner)
        self.assertEqual(len(apt_calls), 2)
        self.assertIn('--allow-downgrades', apt_calls[1])
        self.assertEqual(self.db.execute('SELECT * FROM send_receipts').fetchall(), [('before',), ('new-after-backup',)])
        self.assertEqual(current[0], '0.2.0')

    def test_failed_upgrade_with_new_incompatible_schema_blocks_binary_recovery(self):
        snapshot = self.snapshot()
        calls = []
        def runner(args, **kwargs):
            if args[0] == 'dpkg-query':
                return result('installed\n0.2.0\n')
            if 'apt-get' in args:
                calls.append(args)
                self.db.execute('PRAGMA user_version=2')
                return result(code=100)
            return result()
        with self.assertRaisesRegex(u.Refused, 'incompatible'):
            u.apply_package('update', self.candidate(), self.selected, snapshot, self.candidate('0.2.0'), runner)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.db.execute('PRAGMA user_version').fetchone()[0], 2)

    def test_rollback_validates_latest_state_and_keeps_new_receipts(self):
        self.db.execute('INSERT INTO send_receipts VALUES("latest")')
        self.db.commit()
        current = ['0.2.1']
        def runner(args, **kwargs):
            if args[0] == 'dpkg-query':
                return result(f'installed\n{current[0]}\n')
            if 'apt-get' in args:
                self.assertIn('--allow-downgrades', args)
                current[0] = '0.2.0'
            return result()
        report = u.apply_package('rollback', self.candidate('0.2.0'), self.selected, self.snapshot(), self.candidate('0.2.1'), runner)
        self.assertFalse(report['stateRestored'])
        self.assertEqual(self.db.execute('SELECT count(*) FROM send_receipts').fetchone()[0], 2)

    def test_service_switch_preserves_legacy_link_and_dropin_without_starting(self):
        unit_dir = self.root / '.config/systemd/user'
        unit_dir.mkdir(parents=True, mode=0o700)
        old_fragment = self.root / 'legacy-runtime.service'
        old_fragment.write_text('[Service]\nExecStart=/old/runtime/bin/oraculum-bridge\n')
        user_unit = unit_dir / u.UNIT
        user_unit.symlink_to(old_fragment)
        dropin = unit_dir / (u.UNIT + '.d')
        dropin.mkdir(mode=0o700)
        old_override = dropin / 'override.conf'
        old_override.write_text('[Service]\nEnvironment=ORACULUM_PORT=17991\n')
        self.selected['unit'] = {'FragmentPath': str(old_fragment), 'DropInPaths': str(old_override)}
        binary = self.root / 'bridge-entry'
        binary.write_text('fixture')
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[0] == 'dpkg-query':
                return result('installed\n0.2.0\n')
            if '--property=ExecStart' in args:
                return result('{ path=/usr/bin/oraculum-bridge ; argv[]=/usr/bin/oraculum-bridge ; }')
            if '--property=ActiveState' in args:
                return result('inactive\n')
            return result()
        with patch.object(u, 'ENTRY', str(binary)):
            report = u.service_switch(self.selected, self.root / 'service-backup', runner)
        self.assertFalse(report['started'])
        self.assertFalse(user_unit.is_symlink())
        self.assertEqual(old_override.read_text(), '[Service]\nEnvironment=ORACULUM_PORT=17991\n')
        u.service_restore(self.root / 'service-backup', runner)
        self.assertEqual(user_unit.readlink(), old_fragment)
        self.assertFalse((dropin / u.MANAGED_DROPIN).exists())
        self.assertFalse(any(any(word in args for word in ('start', 'stop', 'restart', 'enable')) for args in calls))

    def test_release_rejects_draft_foreign_source_wrong_hash_identity(self):
        version = '0.2.0'
        tag = 'bridge-v0.2.0'
        name = 'oraculum-bridge_0.2.0_amd64.deb'
        release = {'tag_name': tag, 'draft': False, 'prerelease': False, 'published_at': '2026-11-05', 'assets': [
            {'name': asset, 'browser_download_url': f'https://github.com/{u.REPOSITORY}/releases/download/{tag}/{asset}'}
            for asset in ('bridge-release.json', name)]}
        manifest = {'format': 1, 'component': 'bridge', 'version': version, 'tag': tag,
                    'sourceRepository': u.REPOSITORY, 'sourceGit': 'a' * 40, 'protocolVersion': 1, 'stateSchemaVersion': 1,
                    'artifacts': [{'name': name, 'architecture': 'amd64', 'sha256': '0' * 64, 'size': 3}]}
        def downloader(url, path):
            path.write_text(json.dumps(manifest)) if path.name.endswith('.json') else path.write_bytes(b'deb')
        path, digest, _ = u.release_candidate(version, self.root, 'amd64', lambda _: release, downloader)
        self.assertEqual(path.name, name)
        self.assertEqual(digest, '0' * 64)
        release['draft'] = True
        with self.assertRaisesRegex(u.Refused, 'published stable'):
            u.release_candidate(version, self.root, 'amd64', lambda _: release, downloader)
        release['draft'] = False
        release['assets'][0]['browser_download_url'] = 'https://evil.example/bridge-release.json'
        with self.assertRaisesRegex(u.Refused, 'approved repository'):
            u.release_candidate(version, self.root, 'amd64', lambda _: release, downloader)

    def test_preflight_detects_same_count_database_value_change(self):
        snapshot = self.snapshot()
        def runner(args, **kwargs):
            copied = sqlite3.connect(Path(kwargs['env']['ORACULUM_STATE_DIR']) / 'trust.sqlite')
            copied.execute('UPDATE send_receipts SET id="changed-with-same-row-count"')
            copied.commit()
            copied.close()
            return result()
        with self.assertRaisesRegex(u.Refused, 'changed copied state'):
            u.preflight(self.candidate(), self.selected, snapshot, runner)

    def test_legacy_resource_overrides_block_install_switch_and_desktop_upgrade(self):
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            return result()
        for key, suffix in [('ORACULUM_WEB_DIR', 'apps/web/dist'), ('ORACULUM_THEME_SOURCE_DIR', 'themes')]:
            self.selected['environment'][key] = '/usr/lib/oraculum/resources/runtime/' + suffix
            for operation in (lambda: u.preflight(self.candidate(), self.selected, self.root / 'unused', runner),
                              lambda: u.apply_package('install', self.candidate(), self.selected, None, runner=runner),
                              lambda: u.service_switch(self.selected, self.root / 'unused-backup', runner),
                              lambda: u.desktop_preflight(self.selected, runner)):
                with self.assertRaisesRegex(u.Refused, 'legacy packaged resources'):
                    operation()
            del self.selected['environment'][key]
        self.assertEqual(calls, [])
        self.assertFalse((self.root / 'unused-backup').exists())

    def test_missing_custom_resources_are_rejected_before_candidate_executes(self):
        snapshot = self.snapshot()
        for key in ('ORACULUM_WEB_DIR', 'ORACULUM_THEME_SOURCE_DIR'):
            self.selected['environment'][key] = str(self.root / 'missing-custom')
            with self.assertRaisesRegex(u.Refused, 'missing custom resources'):
                u.preflight(self.candidate(), self.selected, snapshot, lambda *args, **kwargs: self.fail('candidate executed'))
            del self.selected['environment'][key]
        empty_web = self.root / 'empty-web'
        empty_web.mkdir()
        self.selected['environment']['ORACULUM_WEB_DIR'] = str(empty_web)
        with self.assertRaisesRegex(u.Refused, 'missing custom resources'):
            u.resource_overrides(self.selected)

    def test_valid_custom_resources_are_retained_in_candidate_preflight(self):
        web = self.root / 'custom-web'
        web.mkdir()
        (web / 'index.html').write_text('<html>custom</html>')
        themes = self.root / 'custom-themes'
        themes.mkdir()
        self.selected['environment'].update(ORACULUM_WEB_DIR=str(web), ORACULUM_THEME_SOURCE_DIR=str(themes), ORACULUM_RESOURCE_DIR='/old/resource/root')
        environments = []
        def runner(args, **kwargs):
            environments.append(kwargs['env'])
            return result()
        u.preflight(self.candidate(), self.selected, self.snapshot(), runner)
        self.assertEqual(environments[0]['ORACULUM_WEB_DIR'], str(web))
        self.assertEqual(environments[0]['ORACULUM_THEME_SOURCE_DIR'], str(themes))
        self.assertEqual(environments[0]['ORACULUM_RESOURCE_DIR'], str(self.root / 'runtime'))
        self.assertEqual(self.selected['environment']['ORACULUM_RESOURCE_DIR'], '/old/resource/root')

    def test_desktop_preflight_requires_independent_package_and_effective_entry(self):
        def missing(args, **kwargs):
            return result(code=1)
        with self.assertRaisesRegex(u.Refused, 'missing'):
            u.desktop_preflight(self.selected, missing)
        def installed(args, **kwargs):
            return result('installed\n0.2.0\n')
        self.selected['unit'] = {'ExecStart': '{ path=/usr/lib/oraculum/resources/runtime/bin/oraculum-bridge ; }'}
        with self.assertRaisesRegex(u.Refused, 'Legacy'):
            u.desktop_preflight(self.selected, installed)
        self.selected['unit'] = {'ExecStart': '{ path=/bin/other ; }'}
        with self.assertRaisesRegex(u.Refused, 'Effective user service'):
            u.desktop_preflight(self.selected, installed)

    def test_desktop_preflight_validates_copy_without_service_or_state_changes(self):
        runtime = self.root / 'installed-runtime'
        runtime.mkdir()
        (runtime / 'build.json').write_text(json.dumps({'component': 'bridge', 'packageName': u.PACKAGE,
            'version': '0.2.0', 'protocolVersion': 1, 'schemaMin': 0, 'schemaMax': 1}))
        self.selected['unit'] = {'ExecStart': '{ path=/usr/bin/oraculum-bridge ; }', 'FragmentPath': str(self.root / 'unit')}
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[0] == 'dpkg-query':
                return result('installed\n0.2.0\n')
            self.assertNotEqual(kwargs['env']['ORACULUM_STATE_DIR'], str(self.state))
            return result()
        before = self.db.execute('SELECT * FROM send_receipts').fetchall()
        with patch.object(u, 'INSTALLED_RUNTIME', runtime):
            report = u.desktop_preflight(self.selected, runner)
        self.assertTrue(report['desktopUpgradeReady'])
        self.assertFalse(any('systemctl' in args or 'apt-get' in args for args in calls))
        self.assertEqual(self.db.execute('SELECT * FROM send_receipts').fetchall(), before)

    def test_desktop_preflight_accepts_the_packaged_default_unit_entry(self):
        runtime = self.root / 'installed-runtime'
        runtime.mkdir()
        (runtime / 'build.json').write_text(json.dumps({'component': 'bridge', 'packageName': u.PACKAGE,
            'version': '0.2.0', 'protocolVersion': 1, 'schemaMin': 0, 'schemaMax': 1}))
        self.selected['unit'] = {'ExecStart': '{ path=/usr/lib/oraculum-bridge/bin/oraculum-bridge ; }',
                                 'FragmentPath': '/usr/lib/systemd/user/oraculum-bridge.service'}
        def runner(args, **kwargs):
            return result('installed\n0.2.0\n') if args[0] == 'dpkg-query' else result()
        with patch.object(u, 'INSTALLED_RUNTIME', runtime):
            report = u.desktop_preflight(self.selected, runner)
        self.assertTrue(report['desktopUpgradeReady'])
        self.assertEqual(report['entry'], '/usr/lib/oraculum-bridge/bin/oraculum-bridge')
        self.selected['unit']['ExecStart'] += ' { path=/usr/bin/oraculum-bridge ; }'
        with self.assertRaisesRegex(u.Refused, 'exactly one approved'):
            u.desktop_preflight(self.selected, runner)

    def test_unsupported_service_environment_controls_fail_closed(self):
        def runner(args, **kwargs):
            return result('ActiveState=inactive\nUnsetEnvironment=ORACULUM_STATE_DIR\n')
        with self.assertRaisesRegex(u.Refused, 'UnsetEnvironment'):
            u.discover(runner)

    def test_actual_deb_identity_hash_source_and_maintainer_scripts(self):
        if not shutil.which('dpkg-deb'):
            self.skipTest('dpkg-deb required')
        package = self.root / 'deb-tree'
        control = package / 'DEBIAN'
        control.mkdir(parents=True)
        (control / 'control').write_text('Package: oraculum-bridge\nVersion: 0.2.0\nArchitecture: amd64\nMaintainer: Test <test@example.invalid>\nDescription: Isolated fixture\n')
        runtime = package / 'usr/lib/oraculum-bridge'
        runtime.mkdir(parents=True)
        build = {'component': 'bridge', 'packageName': u.PACKAGE, 'version': '0.2.0', 'architecture': 'amd64',
                 'git': 'a' * 40, 'sourceDirty': False, 'schemaMin': 0, 'schemaMax': 1, 'stateSchemaVersion': 1, 'protocolVersion': 1}
        (runtime / 'build.json').write_text(json.dumps(build))
        deb = self.root / 'fixture.deb'
        subprocess.run(['dpkg-deb', '--build', str(package), str(deb)], check=True, capture_output=True)
        directory = self.root / 'validated'
        directory.mkdir()
        candidate = u.validate_deb(deb, u.sha256(deb), '0.2.0', directory, expected_git='a' * 40)
        self.assertEqual(candidate['version'], '0.2.0')
        self.assertEqual(candidate['path'], directory / 'validated.deb')
        with self.assertRaisesRegex(u.Refused, 'SHA256'):
            u.validate_deb(deb, 'f' * 64, '0.2.0', self.root / 'unused')
        directory2 = self.root / 'bad-control'
        directory2.mkdir()
        (control / 'postinst').write_text('#!/bin/sh\nexit 0\n')
        (control / 'postinst').chmod(0o755)
        subprocess.run(['dpkg-deb', '--build', str(package), str(deb)], check=True, capture_output=True)
        with self.assertRaisesRegex(u.Refused, 'maintainer scripts'):
            u.validate_deb(deb, u.sha256(deb), '0.2.0', directory2)


if __name__ == '__main__':
    unittest.main()
