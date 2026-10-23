const { join } = require('node:path');
const { readFile, writeFile, rm, readdir, lstat, chmod, cp } = require('node:fs/promises');
const root = join(__dirname, '..');
const release = require('../release.json');
async function normalizePermissions(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  await chmod(path, stat.isDirectory() ? 0o755 : stat.mode & 0o755);
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await normalizePermissions(join(path, name));
  }
}
module.exports = {
  packagerConfig: {
    name: 'oraculum', executableName: 'oraculum', appVersion: release.version,
    asar: false, prune: false,
    icon: join(root, 'design/reference/02_Brand_OracleEye_App_Icon.png'),
  },
  hooks: {
    postPackage: async (_config, { outputPaths }) => {
      for (const path of outputPaths) {
        // Packager's extraResource copy resolves pnpm links to build-host paths.
        // Keep the already-audited runtime's relative links byte-for-byte.
        await cp(join(root, 'dist/runtime'), join(path, 'resources/runtime'), {
          recursive: true, verbatimSymlinks: true,
        });
        await normalizePermissions(path);
      }
    },
    packageAfterCopy: async (_config, buildPath) => {
      // Build configuration belongs only to staging, never the installed app.
      const file = join(buildPath, 'package.json');
      const pkg = JSON.parse(await readFile(file, 'utf8'));
      delete pkg.config; delete pkg.devDependencies;
      await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
      await rm(join(buildPath, '.npmrc'), { force: true });
    },
  },
  makers: [{ name: '@electron-forge/maker-deb', config: { options: {
    name: 'oraculum', productName: '神谕', bin: 'oraculum',
    maintainer: 'Oraculum', homepage: 'https://github.com/rando1ph/oraculum',
    description: 'Private Ubuntu interface for the official Codex Harness',
    desktopTemplate: join(__dirname, 'oraculum.desktop'),
    icon: join(root, 'design/reference/02_Brand_OracleEye_App_Icon.png'),
    categories: ['Development'],
    depends: ['libc6 (>= 2.31)', 'fonts-noto-cjk'],
  } } }],
};
