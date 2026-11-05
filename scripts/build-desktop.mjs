import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, 'dist/desktop');
const resources = join(root, 'dist/desktop-resources');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const version = release.components.desktop.version;
const desktop = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'));
// Debian staging must not inherit a group-writable developer umask.
process.umask(0o022);
await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
await rm(resources, { recursive: true, force: true }); await mkdir(resources, { recursive: true });
// The staged Electron shell has no runtime npm dependencies. Forge expects a
// conventional top-level layout; scope that setting to staging, not the workspace.
await writeFile(join(stage, '.npmrc'), 'node-linker=hoisted\n');
for (const file of ['main.cjs', 'paths.cjs', 'runtime.cjs', 'artifacts.cjs', 'notifications.cjs']) await cp(join(root, 'apps/desktop', file), join(stage, file));
await cp(join(root, 'packaging/runtime-config.cjs'), join(stage, 'runtime-config.cjs'));
await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'oraculum', productName: '神谕',
  version, private: true, main: 'main.cjs', license: 'UNLICENSED',
  description: 'Private Ubuntu interface for the official Codex Harness', author: 'Oraculum',
  devDependencies: { electron: desktop.devDependencies.electron },
  config: { forge: '../../packaging/forge.config.cjs' } }, null, 2) + '\n');
const electron = createRequire(join(root, 'apps/desktop/main.cjs'))('electron');
await mkdir(join(resources, 'licenses'), { recursive: true });
await cp(join(electron, '../LICENSE'), join(resources, 'licenses/electron-LICENSE'));
await cp(join(root, 'docs/THEME-ASSETS.md'), join(resources, 'licenses/THEME-ASSETS.md'));
await mkdir(join(resources, 'apps/desktop'), { recursive: true });
for (const file of ['splash.html', 'splash.css', 'splash.js']) await cp(join(root, 'apps/desktop', file), join(resources, 'apps/desktop', file));
await mkdir(join(resources, 'design/reference'), { recursive: true });
for (const file of ['02_Brand_OracleEye_App_Icon.png', '03_Brand_OracleEye_Simplified_Icon.png']) await cp(join(root, 'design/reference', file), join(resources, 'design/reference', file));
await writeFile(join(resources, 'build.json'), JSON.stringify({ component: 'desktop', packageName: 'oraculum', architecture: 'amd64',
  version, protocolVersion: 1,
  git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0 }, null, 2) + '\n');
execFileSync('pnpm', ['exec', 'electron-forge', 'make', stage, '--platform', 'linux', '--arch', 'x64'], { cwd: stage, stdio: 'inherit' });
