import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, 'dist/desktop');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const desktop = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
// Debian staging must not inherit a group-writable developer umask.
process.umask(0o022);
await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
// The staged Electron shell has no runtime npm dependencies. Forge expects a
// conventional top-level layout; scope that setting to staging, not the workspace.
await writeFile(join(stage, '.npmrc'), 'node-linker=hoisted\n');
for (const file of ['main.cjs', 'paths.cjs', 'runtime.cjs', 'artifacts.cjs']) await cp(join(root, 'apps/desktop', file), join(stage, file));
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'oraculum', productName: '神谕',
  version: release.version, private: true, main: 'main.cjs', license: 'UNLICENSED',
  description: 'Private Ubuntu interface for the official Codex Harness', author: 'Oraculum',
  devDependencies: { electron: desktop.devDependencies.electron },
  config: { forge: '../../packaging/forge.config.cjs' } }, null, 2) + '\n');
const electron = createRequire(join(root, 'apps/desktop/main.cjs'))('electron');
await mkdir(join(root, 'dist/runtime/licenses'), { recursive: true });
await cp(join(electron, '../LICENSE'), join(root, 'dist/runtime/licenses/electron-LICENSE'));
await cp(join(root, 'docs/THEME-ASSETS.md'), join(root, 'dist/runtime/licenses/THEME-ASSETS.md'));
execFileSync('pnpm', ['exec', 'electron-forge', 'make', stage, '--platform', 'linux', '--arch', 'x64'], { cwd: stage, stdio: 'inherit' });
