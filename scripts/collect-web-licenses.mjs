import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const web = join(project, 'apps/web');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Resolve the installed production graph without collecting devDependencies or
// copying executable npm contents into the notices directory. Walking physical
// parents also supports pnpm's versioned store and scoped dependency links.
async function installedPackage(name, parent) {
  for (let directory = parent; ; directory = dirname(directory)) {
    try { return await realpath(join(directory, 'node_modules', name)); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (dirname(directory) === directory) return undefined;
  }
}

export async function collectWebLicenses(destination = join(project, 'dist/runtime/licenses/web')) {
  await mkdir(destination, { recursive: true });
  const entry = JSON.parse(await readFile(join(web, 'package.json'), 'utf8'));
  const queue = Object.keys(entry.dependencies).map(name => ({ name, parent: web, optional: false }));
  // Tailwind emits its base stylesheet and Vite emits the module-preload helper.
  // Preserve those notices without walking/packaging their build-tool graphs.
  const emittedBuildAssets = { tailwindcss: entry.devDependencies.tailwindcss, vite: entry.devDependencies.vite };
  for (const name of Object.keys(emittedBuildAssets)) queue.push({ name, parent: web, optional: false, noticeOnly: true });
  const visited = new Set();
  const packages = [];
  for (const dependency of queue) {
    const directory = await installedPackage(dependency.name, dependency.parent);
    if (!directory) {
      if (dependency.optional) continue;
      throw new Error(`Missing installed Web dependency: ${dependency.name}`);
    }
    if (visited.has(directory)) continue;
    visited.add(directory);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (pkg.name !== dependency.name || typeof pkg.version !== 'string' || typeof pkg.license !== 'string') {
      throw new Error(`Invalid Web dependency notice metadata: ${dependency.name}`);
    }
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(file.name))
      .map(file => file.name).sort();
    if (!files.length) throw new Error(`Web dependency has no packaged license notice: ${pkg.name}@${pkg.version}`);
    const folder = `${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
    const notices = [];
    await mkdir(join(destination, folder), { recursive: true });
    for (const file of files) {
      const path = `${folder}/${file}`;
      const bytes = await readFile(join(directory, file));
      await cp(join(directory, file), join(destination, path));
      notices.push({ path, sha256: sha256(bytes) });
    }
    if (!packages.some(item => item.name === pkg.name && item.version === pkg.version)) {
      packages.push({ name: pkg.name, version: pkg.version, license: pkg.license, notices });
    }
    if (dependency.noticeOnly) continue;
    const dependencies = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(dependencies)) {
      queue.push({ name, parent: directory, optional: Object.hasOwn(pkg.optionalDependencies ?? {}, name) });
    }
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (!Object.hasOwn(dependencies, name)) {
        queue.push({ name, parent: directory, optional: pkg.peerDependenciesMeta?.[name]?.optional === true });
      }
    }
  }
  packages.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, 'en'));
  const manifest = { format: 1,
    scope: 'Installed Web production dependency closure and available peers, including type-only and optional dependencies. Tailwind base CSS and Vite preload-helper notices are included without their build-tool dependency graphs.',
    entry: { name: entry.name, dependencies: entry.dependencies, emittedBuildAssets }, packages };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Web production dependency notices: ${packages.length} packages`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await collectWebLicenses(process.argv[2] ? resolve(process.argv[2]) : undefined);
}
