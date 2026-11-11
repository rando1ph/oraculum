#!/usr/bin/env python3
"""Opt-in Phase 2 emulator evidence helper. Never handles the formal app or release signing."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PACKAGE = 'dev.oraculum.poc.debug'
RUNNER = PACKAGE + '.test/androidx.test.runner.AndroidJUnitRunner'
JOURNEY = 'dev.oraculum.poc.e2e.NativeGatewayJourneyTest'


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    prepare = commands.add_parser('prepare')
    prepare.add_argument('--metadata', required=True, type=Path)
    test = commands.add_parser('test')
    test.add_argument('--method', required=True)
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
        # The one-time code travels over stdin into app-private no-backup storage.
        # No credential/code is put in arguments, environment, logs or APK assets.
        value = {key: metadata[key] for key in ('endpoint', 'wrongTlsEndpoint', 'rootId', 'projectRelativePath')}
        value['pairCode'] = Path(metadata['pairingFile']).read_text().strip()
        adb('shell', 'run-as', PACKAGE, 'mkdir', '-p', 'no_backup')
        adb('exec-in', 'run-as', PACKAGE, 'tee', 'no_backup/phase2-e2e.json',
            data=json.dumps(value).encode())  # Captured stdout is never printed.
        adb('shell', 'run-as', PACKAGE, 'chmod', '600', 'no_backup/phase2-e2e.json')
        for port in (metadata['port'], metadata['wrongTlsPort']):
            if not isinstance(port, int) or not 1024 <= port <= 65535:
                parser.error('Invalid local fixture port')
            adb('reverse', f'tcp:{port}', f'tcp:{port}')
        print('Private test input staged; ADB loopback mappings ready.')
    elif args.command == 'test':
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9]+', args.method):
            parser.error('Invalid test method')
        result = adb('shell', 'am', 'instrument', '-w', '-e', 'class',
                     JOURNEY + '#' + args.method, RUNNER, timeout=360)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(result)
        success = re.search(rb'OK \(1 test\)', result) is not None and b'FAILURES' not in result
        print(json.dumps({'method': args.method, 'passed': success, 'report': str(args.output)}))
        if not success:
            sys.exit(1)
    elif args.command == 'collect':
        args.output.mkdir(parents=True, exist_ok=True)
        names = adb('shell', 'run-as', PACKAGE, 'ls', 'files/phase2-evidence').decode().splitlines()
        count = 0
        for name in names:
            if not re.fullmatch(r'[A-Za-z0-9-]+\.(png|json)', name) or name == 'checkpoint.json':
                continue
            content = adb('exec-out', 'run-as', PACKAGE, 'cat', 'files/phase2-evidence/' + name)
            (args.output / name).write_bytes(content)
            count += 1
        print(json.dumps({'files': count, 'output': str(args.output)}))
    else:
        adb('shell', 'run-as', PACKAGE, 'rm', '-f', 'no_backup/phase2-e2e.json')
        print('Removed only private test input; app identity, drafts and receipts retained.')


if __name__ == '__main__':
    main()
