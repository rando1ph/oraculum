import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));
const dist = join(desktop, 'dist');
const sources = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
const release = process.argv.includes('--release');
const modules = new Set();
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(desktop, 'resources/icon.png'), join(dist, 'icon.png'));
await viteBuild({
  root: desktop, configFile: join(desktop, 'vite.config.ts'),
  plugins: release ? [{
    name: 'desktop-release-licenses',
    generateBundle(_options, output) {
      for (const chunk of Object.values(output)) {
        if (chunk.type === 'chunk') {
          for (const id of Object.keys(chunk.modules)) modules.add(id.replace(/^\0/, '').split('?')[0]);
        }
      }
    },
  }] : [],
});
for (const part of ['main', 'preload']) {
  const outfile = join(dist, part, 'index.cjs');
  await mkdir(dirname(outfile), { recursive: true });
  const result = await bundle({
    entryPoints: [join(desktop, 'src', part, 'index.ts')],
    outfile, bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], sourcemap: false,
    logLevel: 'warning', metafile: release,
  });
  if (result.metafile) {
    for (const id of Object.keys(result.metafile.inputs)) modules.add(resolve(id));
  }
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
  name: 'oraculum-desktop', productName: '神谕', version: sources.version,
  license: sources.license, private: true, main: 'main/index.cjs',
}, null, 2) + '\n');
await writeFile(join(dist, 'build-info.json'), JSON.stringify({
  component: 'oraculum-desktop', stage: 'P4.4',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  dependencies: { ...sources.dependencies, ...sources.devDependencies },
}, null, 2) + '\n');

if (release) {
  // Tailwind's generated CSS is emitted as an asset, outside the JS module list.
  modules.add(await realpath(join(desktop, 'node_modules/tailwindcss/package.json')));
  const directories = new Set();
  for (const id of modules) {
    const match = id.match(/^(.+\/node_modules\/(?!\.)(?:@[^/]+\/)?[^/]+)\//);
    if (match) directories.add(await realpath(match[1]));
  }
  const licenses = join(dist, 'third-party');
  await mkdir(licenses);
  const packages = new Map();
  for (const directory of [...directories].sort()) {
    const { name, version, license } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    // Workspace links resolve to project source and are covered by the root license.
    if (!directory.includes('/node_modules/')) continue;
    const key = `${name.replace('/', '+')}@${version}`;
    if (packages.has(key)) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    const notices = entries.filter(entry => entry.isFile()
      && /^(?:licen[sc]e|notice|copying|copyright|authors)(?:[._-].*)?$/i.test(entry.name))
      .map(entry => entry.name).sort();
    if (!notices.some(file => /^(?:licen[sc]e|copying)/i.test(file))) {
      throw new Error(`No upstream license file for bundled dependency ${name}@${version}`);
    }
    await mkdir(join(licenses, key));
    for (const file of notices) await cp(join(directory, file), join(licenses, key, file));
    packages.set(key, { name, version, license, notices: notices.map(file => `${key}/${file}`) });
  }
  await writeFile(join(licenses, 'packages.json'), JSON.stringify(
    [...packages.entries()].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, value]) => value), null, 2,
  ) + '\n');
}
console.log(`Desktop bundle ready: ${Object.keys(files).length} renderer resources; no installer produced.`);
