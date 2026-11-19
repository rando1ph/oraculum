import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

// Bundle only. This entry does not invoke Forge, install a package or start a service.
const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));
const dist = join(desktop, 'dist');
const sources = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(desktop, 'resources/icon.png'), join(dist, 'icon.png'));
await viteBuild({ root: desktop, configFile: join(desktop, 'vite.config.ts') });
for (const part of ['main', 'preload']) {
  const outfile = join(dist, part, 'index.cjs');
  await mkdir(dirname(outfile), { recursive: true });
  await bundle({
    entryPoints: [join(desktop, 'src', part, 'index.ts')],
    outfile, bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], sourcemap: false,
    logLevel: 'warning',
  });
}
const files = {};
async function inventory(relative = '') {
  const entries = await readdir(join(dist, 'renderer', relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(name);
    else if (entry.isFile()) {
      const bytes = await readFile(join(dist, 'renderer', name));
      files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    } else throw new Error('Desktop bundle contains a non-regular resource');
  }
}
await inventory();
await writeFile(join(dist, 'renderer-manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n');
await writeFile(join(dist, 'package.json'), JSON.stringify({
  name: 'oraculum-desktop', productName: '神谕', version: '2.0.0-dev.p42',
  private: true, main: 'main/index.cjs',
}, null, 2) + '\n');
await writeFile(join(dist, 'build-info.json'), JSON.stringify({
  component: 'oraculum-desktop', stage: 'P4.3',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  dependencies: { ...sources.dependencies, ...sources.devDependencies },
}, null, 2) + '\n');
console.log(`Desktop bundle ready: ${Object.keys(files).length} renderer resources; no installer produced.`);
