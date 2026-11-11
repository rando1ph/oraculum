#!/usr/bin/env python3
"""Opt-in Phase 3 emulator evidence helper. Never handles the formal app or release signing."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PACKAGE = 'dev.oraculum.poc.debug'
RUNNER = PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner'
JOURNEYS = {
    'workspace': 'dev.oraculum.poc.e2e.Phase3WorkspaceJourneyTest',
    'files': 'dev.oraculum.poc.e2e.Phase3FilesJourneyTest',
    'recovery': 'dev.oraculum.poc.e2e.Phase3RecoveryJourneyTest',
    'notifications': 'dev.oraculum.poc.e2e.Phase3BackgroundNotificationTest',
}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare')
    prepare.add_argument('--metadata', required=True, type=Path)
    test = commands.add_parser('test')
    test.add_argument('--method', required=True)
    test.add_argument('--suite', choices=JOURNEYS, default='workspace')
    test.add_argument('--output', required=True, type=Path)
    collect = commands.add_parser('collect')
    collect.add_argument('--output', required=True, type=Path)
    commands.add_parser('remove-test-input')
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-\d+', args.serial):
        parser.error('Only an explicitly selected Android Emulator is supported')

    def adb(*parts, data=None, timeout=300):
        return subprocess.run(['adb', '-s', args.serial, *parts], input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              check=True, timeout=timeout).stdout

    if adb('shell', 'getprop', 'ro.kernel.qemu').strip() != b'1':
        parser.error('Selected device is not an Android Emulator')
    if args.command == 'prepare':
        metadata = json.loads(args.metadata.read_text())
        if metadata.get('profile') != 'phase3':
            parser.error('Use a new isolated Phase 3 fixture; do not reuse Phase 2 revoked identity')
        # The one-time code travels over stdin into app-private no-backup storage.
        # No credential/code is put in arguments, environment, logs or APK assets.
        value = {key: metadata[key] for key in ('endpoint', 'wrongTlsEndpoint', 'rootId', 'projectRelativePath')}
        value['pairCode'] = Path(metadata['pairingFile']).read_text().strip()
        adb('shell', 'run-as', PACKAGE, 'mkdir', '-p', 'no_backup')
        adb('exec-in', 'run-as', PACKAGE, 'tee', 'no_backup/phase3-e2e.json',
            data=json.dumps(value).encode())  # Captured stdout is never printed.
        adb('shell', 'run-as', PACKAGE, 'chmod', '600', 'no_backup/phase3-e2e.json')
        for port in (metadata['port'], metadata['wrongTlsPort']):
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                parser.error('Invalid local fixture port')
            adb('reverse', f'tcp:{port}', f'tcp:{port}')
        print('Private test input staged; ADB loopback mappings ready.')
    elif args.command == 'test':
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]+', args.method):
            parser.error('Invalid test method')
        # Assumption skips can also produce JUnit's OK banner. Require private
        # opt-in input before launching so an absent fixture cannot look passed.
        adb('shell', 'run-as', PACKAGE, 'test', '-f', 'no_backup/phase3-e2e.json')
        result = adb('shell', 'am', 'instrument', '-w', '-e', 'class',
                     JOURNEYS[args.suite] + '#' + args.method, RUNNER, timeout=360)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(result)
        skipped = re.search(rb'INSTRUMENTATION_STATUS_CODE: -[34]\b', result) is not None
        success = re.search(rb'OK \(1 test\)', result) is not None and b'FAILURES' not in result and not skipped
        print(json.dumps({'method': args.method, 'passed': success, 'report': str(args.output)}))
        if not success:
            sys.exit(1)
    elif args.command == 'collect':
        args.output.mkdir(parents=True, exist_ok=True)
        names = adb('shell', 'run-as', PACKAGE, 'ls', 'files/phase3-evidence').decode().splitlines()
        count = 0
        for name in names:
            if not re.fullmatch(r'[A-Za-z0-9-]+\.(png|json)', name) or name in ('checkpoint.json', 'unknown-checkpoint.json', 'recovery-checkpoint.json'):
                continue
            content = adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/phase3-evidence/' + name)
            (args.output / name).write_bytes(content)
            count += 1
        print(json.dumps({'files': count, 'output': str(args.output)}))
    else:
        adb('shell', 'run-as', PACKAGE, 'rm', '-f', 'no_backup/phase3-e2e.json')
        print('Removed only private test input; app identity, drafts and receipts retained.')


if __name__ == '__main__':
    main()
