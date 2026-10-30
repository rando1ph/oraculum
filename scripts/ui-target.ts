// Reuse functional contracts against an extracted release, with its OS sandbox.
// The default remains the existing source-shell contract behavior.
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const installation = process.env.ORACULUM_TEST_DESKTOP_DIR;
if (installation) {
  if (!isAbsolute(installation)) throw new Error('Release test installation must be absolute');
  const manifest = JSON.parse(readFileSync(join(installation, 'resources/app/package.json'), 'utf8'));
  if (manifest.main !== 'main.cjs' || manifest.devDependencies) throw new Error('Expected a packaged desktop shell');
}
export const uiResource = (path: string) => resolve(installation ? join(installation, 'resources/runtime') : '.', path);
export function uiDesktop(environment: Record<string, string>) {
  if (installation) {
    const home = join(installation, 'test-home');
    const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('ORACULUM_') || ['ORACULUM_URL', 'ORACULUM_USER_DATA_DIR'].includes(key)));
    Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_STATE_HOME: join(home, 'state'),
      XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), CODEX_HOME: join(home, 'codex'), ORACULUM_MANAGE_SERVICE: '0' });
    return { executablePath: join(installation, 'oraculum'), args: [], chromiumSandbox: true, env, timeout: 20_000 };
  }
  return { executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string, args: [resolve('apps/desktop/main.cjs')], env: environment };
}
