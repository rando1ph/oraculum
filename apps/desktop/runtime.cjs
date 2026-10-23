const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function configureRuntime(app) {
  if (!app.isPackaged) return;
  const resources = join(process.resourcesPath, 'runtime');
  require(join(resources, 'runtime-config.cjs')).loadRuntimeConfig();
  process.env.ORACULUM_RESOURCE_DIR = resources;
}
async function ensureBridge(app, origin) {
  const healthy = async () => {
    try {
      const response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(750) });
      const body = await response.json();
      return response.ok && body.protocol === 1 && body.mode === 'authenticated';
    } catch { return false; }
  };
  if (await healthy()) return;
  if (!app.isPackaged || process.env.ORACULUM_MANAGE_SERVICE === '0') throw new Error('Bridge 未运行。请检查已选择的运行配置并重试。');
  // The package only carries the unit. Registration and startup policy belong to
  // the explicitly approved installation, never to a root package script.
  await run('systemctl', ['--user', 'start', 'oraculum-bridge.service'], { timeout: 15000 });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Bridge 尚未就绪。请检查原生 Codex、运行配置和用户服务状态。');
}
module.exports = { configureRuntime, ensureBridge };
