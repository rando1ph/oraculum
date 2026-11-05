import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertCleanSource, componentRelease, inspectComponentDeb, projectRoot, releaseManifest } from './release-components.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createComponentRelease({ component, deb, output, root = projectRoot }) {
  assert.ok(deb && output, 'Usage: node scripts/create-component-release.mjs --component bridge|desktop --deb FILE --output DIR');
  const selected = componentRelease(JSON.parse(await readFile(join(root, 'release.json'), 'utf8')), component);
  const sourceGit = assertCleanSource(root);
  const inspected = await inspectComponentDeb(deb, selected, sourceGit);
  const manifest = releaseManifest(selected, sourceGit, inspected.artifact);
  const destination = resolve(output);
  assert.notEqual(destination, dirname(inspected.file), 'Use a separate candidate output directory');
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(join(dirname(destination), '.component-release-'));
  try {
    await copyFile(inspected.file, join(staging, inspected.artifact.name));
    assert.equal(digest(await readFile(join(staging, inspected.artifact.name))), inspected.artifact.sha256, 'DEB changed while preparing candidate');
    await writeFile(join(staging, `${component}-release.json`), JSON.stringify(manifest, null, 2) + '\n');
    await copyFile(join(root, selected.changelog), join(staging, 'RELEASE_NOTES.md'));
    if (component === 'bridge') await copyFile(join(root, 'scripts/bridge-update.py'), join(staging, 'bridge-update.py'));
    const files = (await readdir(staging)).sort();
    const sums = await Promise.all(files.map(async name => `${digest(await readFile(join(staging, name)))}  ${name}\n`));
    await writeFile(join(staging, 'SHA256SUMS'), sums.join(''));
    assert.equal(assertCleanSource(root), sourceGit, 'Source changed while preparing candidate');
    // No timestamps are embedded. Identical reruns verify and preserve the
    // existing candidate; a changed artifact can never overwrite it silently.
    let existing = false;
    try { existing = (await lstat(destination)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      assert.deepEqual((await readdir(destination)).sort(), (await readdir(staging)).sort(), 'Candidate output already exists with different files');
      for (const name of await readdir(staging)) {
        assert.ok((await lstat(join(destination, name))).isFile(), 'Existing candidate files must be regular files');
        assert.equal(digest(await readFile(join(destination, name))), digest(await readFile(join(staging, name))), 'Candidate output already exists with different content');
      }
    } else await rename(staging, destination);
    return { directory: destination, manifest, files: (await readdir(destination)).sort() };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    assert.ok(['--component', '--deb', '--output'].includes(flag), `Unknown argument: ${flag}`);
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `Missing value for ${flag}`);
    const key = flag.slice(2);
    assert.ok(!Object.hasOwn(parsed, key), `Duplicate argument: ${flag}`);
    parsed[key] = args[index + 1];
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await createComponentRelease(parseArguments(process.argv.slice(2)));
    console.log(`Review candidate prepared: ${result.directory}`);
    console.log(`${result.manifest.tag} from ${result.manifest.sourceGit}; no GitHub Release created`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
