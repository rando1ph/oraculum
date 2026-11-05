const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function configureRuntime(app, env = process.env) {
  if (!app.isPackaged) return;
  // The reader ships with the shell; runtime.json remains outside both DEBs.
  // Never import executable code from an installed Bridge or a user config path.
  require('./runtime-config.cjs').loadRuntimeConfig(env);
  env.ORACULUM_RESOURCE_DIR = join(process.resourcesPath, 'desktop');
}
async function ensureBridge(app, origin) {
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const probe = async () => {
    let response;
    try {
      response = await fetch(new URL('/health', origin), { signal: AbortSignal.timeout(750) });
    } catch { return false; }
    let body;
    try { body = await response.json(); } catch {}
    if (!response.ok || body?.protocol !== 1 || body.mode !== 'authenticated') {
      throw failure('bridge-incompatible', 'Bridge 协议或认证模式不兼容。请安装兼容协议 1 的 Bridge，并保留现有配置和状态。');
    }
    return true;
  };
  if (await probe()) return;
  if (!app.isPackaged || process.env.ORACULUM_MANAGE_SERVICE === '0') {
    throw failure('bridge-unavailable', 'Bridge 未运行。请先安装独立 Bridge DEB，检查已选择的运行配置和用户服务，再重试。');
  }
  // Only start an already installed, selected independent Bridge. In particular,
  // a legacy user-unit link must be switched in an approved deployment window,
  // before the Desktop upgrade removes its former embedded runtime.
  let unit;
  try {
    unit = (await run('systemctl', ['--user', 'show', 'oraculum-bridge.service', '--property=LoadState', '--property=ExecStart'], { timeout: 5000 })).stdout;
  } catch {
    throw failure('bridge-service', '无法读取 Bridge 用户服务。请检查 systemctl --user status oraculum-bridge.service。');
  }
  if (!/^LoadState=loaded$/m.test(unit)) {
    throw failure('bridge-missing', '未找到已安装的 Bridge 用户服务。请先安装独立 Bridge DEB，核对现有 runtime.json 和状态目录后注册服务。');
  }
  const commands = [...unit.matchAll(/(?:^|[\s{;])path=([^\s;]+)/g)].map(match => match[1]);
  if (commands.length !== 1 || !['/usr/lib/oraculum-bridge/bin/oraculum-bridge', '/usr/bin/oraculum-bridge'].includes(commands[0])) {
    throw failure('bridge-service-migration', 'Bridge 服务仍使用旧入口或自定义入口。请按升级说明保全配置和 SQLite，受控切换到独立 Bridge 服务后重试。');
  }
  try {
    await run('systemctl', ['--user', 'start', 'oraculum-bridge.service'], { timeout: 15000 });
  } catch {
    throw failure('bridge-service', 'Bridge 用户服务启动失败。请检查官方 Codex、runtime.json 与 systemctl --user status oraculum-bridge.service。');
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw failure('bridge-unavailable', 'Bridge 尚未就绪。请检查官方 Codex、运行配置和用户服务状态。');
}
module.exports = { configureRuntime, ensureBridge };
