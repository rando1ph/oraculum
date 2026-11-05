import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
const healthy = () => ({ ok: true, json: async () => ({ protocol: 1, mode: 'authenticated' }) });
const offline = () => Promise.reject(new Error('connection refused'));
function runtime(options: { fetch?: ReturnType<typeof vi.fn>; run?: ReturnType<typeof vi.fn>; env?: NodeJS.ProcessEnv; date?: object } = {}) {
  const fetch = options.fetch ?? vi.fn(healthy), run = options.run ?? vi.fn();
  const module = { exports: {} as {
    configureRuntime(app: { isPackaged: boolean }, env?: NodeJS.ProcessEnv): void;
    ensureBridge(app: { isPackaged: boolean }, origin: URL): Promise<void>;
  } };
  const imports: string[] = [];
  runInNewContext(readFileSync(resolve('apps/desktop/runtime.cjs'), 'utf8'), {
    module, fetch, URL, AbortSignal, Date: options.date ?? Date, setTimeout,
    process: { env: options.env ?? {}, resourcesPath: '/installed/oraculum/resources' },
    require: (name: string) => {
      imports.push(name);
      if (name === 'node:util') return { promisify: () => run };
      if (name === './runtime-config.cjs') return require('../../packaging/runtime-config.cjs');
      return require(name);
    },
  });
  return { ...module.exports, imports, fetch, run };
}
const origin = new URL('http://127.0.0.1:17860');

describe('independent Desktop runtime', () => {
  it('loads the existing external runtime.json without an installed Bridge or state initialization', () => {
    const home = mkdtempSync(join(tmpdir(), 'oraculum-desktop-runtime-')); temporary.push(home);
    mkdirSync(join(home, '.config/oraculum'), { recursive: true, mode: 0o700 });
    const file = join(home, '.config/oraculum/runtime.json');
    const original = JSON.stringify({ ORACULUM_STATE_DIR: join(home, 'existing-state'), ORACULUM_PORT: '18760', ORACULUM_USER_DATA_DIR: join(home, 'original-profile') });
    writeFileSync(file, original, { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { HOME: home, ORACULUM_PORT: '18761' };
    const subject = runtime(); subject.configureRuntime({ isPackaged: true }, env);
    expect(env.ORACULUM_STATE_DIR).toBe(join(home, 'existing-state'));
    expect(env.ORACULUM_PORT).toBe('18761');
    expect(env.ORACULUM_USER_DATA_DIR).toBe(join(home, 'original-profile'));
    expect(env.ORACULUM_RESOURCE_DIR).toBe('/installed/oraculum/resources/desktop');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(existsSync(env.ORACULUM_STATE_DIR!)).toBe(false);
    expect(subject.imports.filter(name => !name.startsWith('node:'))).toEqual(['./runtime-config.cjs']);
  });

  it('connects to a compatible already running old or new Bridge without inspecting or changing a service', async () => {
    const subject = runtime();
    await subject.ensureBridge({ isPackaged: true }, origin);
    expect(subject.run).not.toHaveBeenCalled();
    expect(subject.fetch.mock.calls[0][0].href).toBe('http://127.0.0.1:17860/health');
  });

  it.each([{ protocol: 2, mode: 'authenticated' }, { protocol: 1, mode: 'local-test' }, null])(
    'refuses incompatible health %j without attempting another service', async body => {
      const subject = runtime({ fetch: vi.fn(() => ({ ok: true, json: async () => body })) });
      await expect(subject.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-incompatible');
      expect(subject.run).not.toHaveBeenCalled();
    });

  it('refuses a non-JSON or failing health endpoint instead of starting a competing instance', async () => {
    for (const response of [{ ok: true, json: async () => { throw new SyntaxError('HTML'); } }, { ok: false, json: async () => ({ protocol: 1, mode: 'authenticated' }) }]) {
      const subject = runtime({ fetch: vi.fn(() => response) });
      await expect(subject.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-incompatible');
      expect(subject.run).not.toHaveBeenCalled();
    }
  });

  it('honors service management policy and never installs or registers a missing Bridge', async () => {
    const subject = runtime({ fetch: vi.fn(offline), env: { ORACULUM_MANAGE_SERVICE: '0' } });
    await expect(subject.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-unavailable');
    expect(subject.run).not.toHaveBeenCalled();
    const missing = runtime({ fetch: vi.fn(offline), run: vi.fn(async () => ({ stdout: 'LoadState=not-found\nExecStart=\n' })) });
    await expect(missing.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-missing');
    expect(missing.run).toHaveBeenCalledTimes(1);
    expect(missing.run.mock.calls[0][1]).toContain('show');
  });

  it.each(['/usr/lib/oraculum/resources/runtime/bin/oraculum-bridge', '/custom/bridge'])('keeps an old or custom unit untouched: %s', async path => {
    const subject = runtime({ fetch: vi.fn(offline), run: vi.fn(async () => ({ stdout: `LoadState=loaded\nExecStart={ path=${path} ; argv[]=${path} ; }\n` })) });
    await expect(subject.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-service-migration');
    expect(subject.run).toHaveBeenCalledTimes(1);
  });

  it('starts only the registered independent Bridge and waits for compatible authenticated health', async () => {
    const fetch = vi.fn().mockImplementationOnce(offline).mockImplementation(healthy);
    const run = vi.fn(async () => ({ stdout: 'LoadState=loaded\nExecStart={ path=/usr/lib/oraculum-bridge/bin/oraculum-bridge ; argv[]=/usr/lib/oraculum-bridge/bin/oraculum-bridge ; }\n' }));
    const subject = runtime({ fetch, run });
    await subject.ensureBridge({ isPackaged: true }, origin);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual(['systemctl', ['--user', 'start', 'oraculum-bridge.service'], { timeout: 15000 }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports bounded service readiness failure without repeated starts', async () => {
    let calls = 0;
    const subject = runtime({ fetch: vi.fn(offline), date: { now: () => calls++ === 0 ? 0 : 15001 },
      run: vi.fn(async () => ({ stdout: 'LoadState=loaded\nExecStart={ path=/usr/bin/oraculum-bridge ; }\n' })) });
    await expect(subject.ensureBridge({ isPackaged: true }, origin)).rejects.toHaveProperty('code', 'bridge-unavailable');
    expect(subject.run).toHaveBeenCalledTimes(2);
  });
});
