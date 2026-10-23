import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'oraculum-brand-'));
const output = resolve('.local/evidence/phase4b/brand-desktop');
await mkdir(output, { recursive: true });
let ready = true;
const server = createServer((_req, res) => { const timer = setInterval(() => { if (!ready) return; clearInterval(timer); res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<html><title>Oraculum · 神谕</title><body style="background:black;color:white"><h1>Fixture ready</h1></body></html>'); }, 25); res.on('close', () => clearInterval(timer)); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
const executablePath = createRequire(resolve('apps/desktop/main.cjs'))('electron');
const sandbox = process.env.ORACULUM_BRAND_TEST_NO_SANDBOX !== '1';
const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)), ORACULUM_USER_DATA_DIR: join(root, 'profile'),
  ORACULUM_URL: `http://127.0.0.1:${port}`, ORACULUM_RESOURCE_DIR: resolve('.') };
delete env.ELECTRON_RUN_AS_NODE;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  // A visual-only local-window harness holds the production splash for inspection.
  // The real entry below must hand off immediately, so it has no artificial delay.
  const preview = join(root, 'preview.cjs');
  await mkdir(join(root, 'preview-profile'), { mode: 0o700 });
  await writeFile(preview, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root,'preview-profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:880,height:720,backgroundColor:'#000',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(resolve('apps/desktop/splash.html'))});});app.on('window-all-closed',()=>app.quit());`);
  app = await electron.launch({ executablePath, args: [preview], chromiumSandbox: sandbox, env, timeout: 15000 });
  const splash = await app.firstWindow();
  await expect(splash.locator('.mandate')).toHaveText('意志为谕，万象将启。');
  await expect(splash.locator('.translation')).toHaveText('LET THE UNWRITTEN UNFOLD.');
  await expect.poll(() => splash.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await splash.waitForTimeout(1400);
  await splash.screenshot({ path: join(output, 'awakening.png') });
  expect(await splash.locator('img').evaluate(img => getComputedStyle(img).animationName)).toBe('reveal-eye');
  await splash.emulateMedia({ reducedMotion: 'reduce' });
  expect(await splash.locator('img').evaluate(img => getComputedStyle(img).animationName)).toBe('none');
  expect(await splash.locator('.mandate').evaluate(p => getComputedStyle(p).opacity)).toBe('1');
  await app.close(); app = undefined;
  app = await electron.launch({ executablePath, args: [resolve('apps/desktop/main.cjs')], chromiumSandbox: sandbox, env, timeout: 15000 });
  const main = app.windows()[0];
  await expect(main.getByRole('heading', { name: 'Fixture ready' })).toBeVisible();
  await expect.poll(() => app!.windows().length).toBe(1);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())).toBe('神谕');
  await app.close(); app = undefined;
  await new Promise<void>(resolve => server.close(() => resolve()));
  app = await electron.launch({ executablePath, args: [resolve('apps/desktop/main.cjs')], chromiumSandbox: sandbox, env, timeout: 10000 });
  await expect.poll(() => app!.windows().some(page => page.url().includes('state=error'))).toBe(true);
  const recovery = app.windows().find(page => page.url().includes('state=error'))!;
  await expect(recovery.getByRole('link', { name: '重新连接' })).toBeVisible();
  await recovery.emulateMedia({ reducedMotion: 'reduce' });
  expect(await recovery.locator('img').evaluate(img => getComputedStyle(img).animationName)).toBe('none');
  await recovery.screenshot({ path: join(output, 'offline-recovery.png') });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  await recovery.getByRole('link', { name: '重新连接' }).click();
  await expect(app.windows()[0].getByRole('heading', { name: 'Fixture ready' })).toBeVisible();
  await expect.poll(() => app!.windows().length).toBe(1);
  console.log(`PASS real Electron local splash, original offline asset, exact declarations, immediate ready handoff, fixed title, offline recovery/retry, reduced-motion CSS; OS sandbox ${sandbox ? 'requested' : 'NOT verified (explicit UI-only test override)'}`);
} catch (error) { console.error(error); throw error;
} finally {
  ready = true;
  server.closeAllConnections();
  await app?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
