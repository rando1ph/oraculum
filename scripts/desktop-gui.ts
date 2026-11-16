/**
 * P4.1: real Electron on the current GNOME/Wayland desktop, using an isolated
 * disposable profile. No Gateway, fixture HTTP server, service or Codex process.
 * Playwright's loopback debugger endpoints exist only for this test process.
 * Run after pnpm build:desktop. This is deliberately not an Xvfb/headless test.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { DesktopBridge } from '../apps/desktop/src/contracts/desktop';

type DesktopWindow = Window & { oraculumDesktop: DesktopBridge };
const root = resolve(import.meta.dirname, '..');
const bundle = join(root, 'apps/desktop/dist');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const executablePath = require('electron') as string;
const outputArg = process.argv.slice(2).find(arg => arg.startsWith('--output='));
const output = resolve(outputArg?.slice('--output='.length) || join(root, '.local/desktop-p41/gui'));
const entry = 'oraculum-app://bundle/index.html';
assert.equal(process.env.XDG_SESSION_TYPE, 'wayland', 'Run in the real Wayland desktop session.');
assert.ok(process.env.WAYLAND_DISPLAY, 'WAYLAND_DISPLAY is required; do not use Xvfb.');
await mkdir(output, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), 'oraculum-desktop-p41-gui-'));
const config = join(temporary, 'config');
await mkdir(config, { mode: 0o700 });
const profile = join(config, 'oraculum-desktop-v2/development-gui');
const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
// These historical inputs must have no influence over the independent client.
delete env.ORACULUM_URL;
delete env.ORACULUM_PORT;
delete env.ORACULUM_USER_DATA_DIR;
delete env.ORACULUM_RESOURCE_DIR;
delete env.ORACULUM_DESKTOP_ICON;
Object.assign(env, { XDG_CONFIG_HOME: config, ORACULUM_DESKTOP_PROFILE: 'gui' });

const passed: string[] = [];
const pageErrors: string[] = [];
const ordinaryExternalRequests: string[] = [];
let app: ElectronApplication | undefined;
let negativeChecks = false;
let versions: Record<string, string | undefined> = {};
let osSandbox: { seccomp: string; noNewPrivileges: string; helperOverrideUsed: boolean } | undefined;
let display: unknown;
let stage = 'initialization';
const screenshotEvidence: {
  file: string; theme: string; sha256: string; width: number; height: number; attempts: number;
  samples: { column: string; expected: number[]; actual: number[] }[];
}[] = [];

async function check(name: string, run: () => Promise<void>) {
  stage = name;
  await run();
  passed.push(name);
  console.log(`PASS ${name}`);
}

async function launch() {
  negativeChecks = false;
  app = await electron.launch({
    executablePath,
    args: ['--ozone-platform=wayland', '--force-renderer-accessibility', bundle],
    env,
    chromiumSandbox: true,
    timeout: 30_000,
  });
  // The launcher can have loaded initial resources before returning. This
  // observer covers subsequent UI interactions; startup isolation is also
  // checked by the bundle/CSP/session policy and runtime unit tests.
  app.context().on('request', request => {
    if (!negativeChecks && !request.url().startsWith('oraculum-app://bundle/')) {
      ordinaryExternalRequests.push(new URL(request.url()).protocol);
    }
  });
  const page = await app.firstWindow({ timeout: 20_000 });
  page.on('pageerror', error => pageErrors.push(error.name));
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(light|dark|oled)$/);
  await page.waitForFunction(() => Boolean((window as unknown as DesktopWindow).oraculumDesktop));
  assert.equal(page.url(), entry);
  return page;
}

async function closeWindow() {
  if (!app) return;
  const current = app;
  const processHandle = current.process();
  const exited = current.waitForEvent('close', { timeout: 15_000 });
  const page = current.windows()[0];
  if (page) await page.close();
  await exited;
  assert.notEqual(processHandle.exitCode, null, 'Closing the final window must exit Electron.');
  app = undefined;
}

async function chooseTheme(page: Page, theme: 'light' | 'dark' | 'oled') {
  const labels = { light: 'Light', dark: 'Dark', oled: 'OLED Dark' };
  await page.getByRole('button', { name: labels[theme], exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect.poll(() => page.evaluate(async () => (await (window as unknown as DesktopWindow).oraculumDesktop.getState()).preferences.theme)).toBe(theme);
}

async function capture(page: Page, filename: string) {
  // Playwright page.screenshot applies CSS viewport clipping at non-unit
  // Electron zoom. capturePage preserves the actual native content rectangle.
  // A DOM theme assertion alone is not a compositor fence: capturePage can
  // return the preceding frame. Wait for resources and paints, then independently
  // compare native bitmap pixels with the visible columns' current CSS colors.
  await app!.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.show(); win.focus();
  });
  let mismatch: unknown;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const visual = await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(image => image.decode()));
      const masks = [...new Set(Array.from(document.querySelectorAll('.oracle-eye')).map(element =>
        getComputedStyle(element).maskImage.match(/url\(["']?(.*?)["']?\)/)?.[1]).filter((url): url is string => Boolean(url)))];
      await Promise.all(masks.map(async url => {
        const image = new Image(); image.src = url; await image.decode();
      }));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        theme: document.documentElement.dataset.theme ?? 'missing',
        viewport: { width: window.innerWidth, height: window.innerHeight },
        samples: Array.from(document.querySelectorAll('.navigation, .conversation, .inspector')).map(element => {
          const rect = element.getBoundingClientRect();
          const color = getComputedStyle(element).backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
          if (!color) throw new Error('A visible column must have an opaque RGB background.');
          // Just inside the left/bottom padding: away from text, borders,
          // scrollbars and the connection banner at the top of the main column.
          return {
            column: element.classList[0], x: rect.left + 5, y: rect.bottom - 5,
            expected: [Number(color[1]), Number(color[2]), Number(color[3]), 255],
          };
        }),
      };
    });
    const native = await app!.evaluate(async ({ BrowserWindow }, visual) => {
      const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
      const png = image.toPNG();
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      const bitmap = image.toBitmap();
      if (bitmap.length !== width * height * 4) throw new Error('Native bitmap dimensions do not match the PNG.');
      const samples = visual.samples.map(sample => {
        const x = Math.min(width - 1, Math.floor(sample.x * width / visual.viewport.width));
        const y = Math.min(height - 1, Math.floor(sample.y * height / visual.viewport.height));
        const offset = (y * width + x) * 4;
        // nativeImage.toBitmap is BGRA on this little-endian Linux host.
        return { column: sample.column, expected: sample.expected,
          actual: [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3]] };
      });
      return { png: png.toString('base64'), width, height, samples };
    }, visual);
    if (native.samples.length >= 2 && native.samples.every(sample => sample.expected.every((value, channel) => Math.abs(value - sample.actual[channel]) <= 1))) {
      const bytes = Buffer.from(native.png, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(output, filename), bytes);
      screenshotEvidence.push({ file: filename, theme: visual.theme, sha256,
        width: native.width, height: native.height, attempts: attempt, samples: native.samples });
      return sha256;
    }
    mismatch = { theme: visual.theme, samples: native.samples };
    // A bounded retry is necessary when Chromium has not submitted its new
    // compositor frame yet, even though the DOM and computed style are current.
    await page.waitForTimeout(50);
  }
  throw new Error(`Native capture did not match the painted theme: ${JSON.stringify(mismatch)}`);
}

try {
  await check('bundle manifest and original Outline bytes', async () => {
    const manifest = JSON.parse(await readFile(join(bundle, 'renderer-manifest.json'), 'utf8')) as {
      version: number; files: Record<string, { sha256: string; size: number }>;
    };
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files['index.html']);
    const source = await readFile(join(root, 'design/brand/oracle-eye-user/oraculum_oracle_eye_outline.svg'));
    let outlineFound = false;
    for (const [name, info] of Object.entries(manifest.files)) {
      assert.ok(!name.includes('..') && !name.startsWith('/'));
      const bytes = await readFile(join(bundle, 'renderer', name));
      assert.equal(bytes.length, info.size);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256);
      if (name.endsWith('.svg') && bytes.equals(source)) outlineFound = true;
    }
    assert.ok(outlineFound, 'The original full Outline SVG must be packaged byte-for-byte.');
  });

  let page = await launch();
  await check('real sandboxed Electron and isolated development profile', async () => {
    const facts = await app!.evaluate(({ app, BrowserWindow, screen }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean; webSecurity: boolean; webviewTag: boolean };
      };
      const p = wc.getLastWebPreferences();
      return {
        versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
        argv: process.argv,
        rendererPid: BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
        display: { workAreaSize: screen.getPrimaryDisplay().workAreaSize, bounds: screen.getPrimaryDisplay().bounds, scaleFactor: screen.getPrimaryDisplay().scaleFactor, windowBounds: BrowserWindow.getAllWindows()[0].getBounds(), contentBounds: BrowserWindow.getAllWindows()[0].getContentBounds() },
        userData: app.getPath('userData'),
        preferences: { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, webviewTag: p.webviewTag },
      };
    });
    assert.deepEqual(facts.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false });
    assert.ok(!facts.argv.some(arg => /no-sandbox|disable-web-security|disable-setuid-sandbox/.test(arg)));
    assert.ok(facts.argv.includes('--ozone-platform=wayland'));
    assert.equal(facts.userData, profile);
    const rendererStatus = await readFile(`/proc/${facts.rendererPid}/status`, 'utf8');
    osSandbox = {
      seccomp: rendererStatus.match(/^Seccomp:\s+(\d+)$/m)?.[1] ?? 'unknown',
      noNewPrivileges: rendererStatus.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1] ?? 'unknown',
      helperOverrideUsed: Boolean(env.CHROME_DEVEL_SANDBOX),
    };
    assert.equal(osSandbox.seccomp, '2', 'Renderer must have a seccomp filter.');
    assert.equal(osSandbox.noNewPrivileges, '1', 'Renderer must run without new privileges.');
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
    assert.ok((await readdir(profile)).includes('.oraculum-desktop-v2'));
    versions = facts.versions;
    display = facts.display;
    await writeFile(join(output, 'runtime.json'), JSON.stringify({ versions, osSandbox, display }, null, 2) + '\n');
    const exposed = await page.evaluate(() => ({
      methods: Object.keys((window as unknown as DesktopWindow).oraculumDesktop).sort(),
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
    }));
    assert.deepEqual(exposed.methods, ['getState', 'onStateChanged', 'resetAppearance', 'setPreferences']);
    assert.equal(exposed.require, 'undefined');
    assert.equal(exposed.process, 'undefined');
  });

  await check('unconfigured startup and three authentic themes', async () => {
    await expect(page.locator('body')).toContainText('尚未配置');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const hashes = new Set<string>();
    for (const theme of ['light', 'dark', 'oled'] as const) {
      await chooseTheme(page, theme);
      hashes.add(await capture(page, `01-connect-${theme}.png`));
      if (theme === 'oled') {
        const colors = await page.locator('.navigation, .conversation, .inspector').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
        assert.equal(colors.length, 3);
        assert.ok(colors.every(color => color === 'rgb(0, 0, 0)'), JSON.stringify(colors));
      }
    }
    assert.equal(hashes.size, 3, 'Connection screenshots must contain three distinct painted themes.');
  });

  await check('single instance stays within the selected isolated profile', async () => {
    const second = spawn(executablePath, ['--ozone-platform=wayland', bundle], { env, stdio: 'ignore' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        second.once('error', reject);
        second.once('exit', resolve);
        timer = setTimeout(() => reject(new Error('Second instance did not exit within 10 seconds.')), 10_000);
      });
      assert.equal(code, 0);
      assert.equal(app!.windows().length, 1);
      assert.equal(page.url(), entry);
      await expect(page.locator('.app-shell')).toBeVisible();
    } finally {
      if (timer) clearTimeout(timer);
      if (second.exitCode === null && second.signalCode === null) second.kill('SIGTERM');
    }
  });

  await check('keyboard skip link keeps the fixed document origin and working IPC', async () => {
    const skip = page.locator('.skip-link');
    await skip.focus();
    await skip.press('Enter');
    assert.equal(page.url(), entry);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
    await chooseTheme(page, 'dark');
  });

  await check('explicit local preview, Outline, Diff and responsive layout', async () => {
    await page.getByRole('button', { name: '本地外观预览', exact: true }).click();
    await expect(page.locator('body')).toContainText('本地样例');
    await expect(page.locator('.diff-line').first()).toBeVisible();
    assert.equal(await page.locator('.diff-line').first().evaluate(element => getComputedStyle(element).fontSize), '10px');
    const masks = await page.locator('.oracle-eye').evaluateAll(elements => elements.map(element => getComputedStyle(element).maskImage));
    assert.ok(masks.length >= 2);
    assert.ok(masks.every(mask => mask.includes('outline') && !mask.includes('compact')));
    const hashes = new Set<string>();
    for (const theme of ['light', 'dark', 'oled'] as const) {
      await chooseTheme(page, theme);
      hashes.add(await capture(page, `02-preview-${theme}.png`));
    }
    assert.equal(hashes.size, 3, 'Preview screenshots must contain three distinct painted themes.');
    const toggle = page.getByRole('button', { name: '收起 Inspector', exact: true });
    await toggle.focus();
    await toggle.press('Enter');
    await expect(page.locator('.inspector')).toHaveCount(0);
    await page.getByRole('button', { name: '展开 Inspector', exact: true }).press('Enter');
    await expect(page.locator('.inspector')).toBeVisible();
    await page.getByRole('tab', { name: '变更', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: '变更', exact: true })).toHaveAttribute('aria-selected', 'true');
    for (const [width, height, zoom] of [[1600, 1000, 1], [1280, 800, 1], [1000, 680, 1], [1000, 680, 1.25]]) {
      await app!.evaluate(({ BrowserWindow }, values) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(values.width, values.height);
        win.webContents.setZoomFactor(values.zoom);
      }, { width, height, zoom });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const bounds = await page.locator('body').evaluate(element => ({ width: element.scrollWidth, viewport: window.innerWidth }));
      assert.ok(bounds.width <= bounds.viewport, JSON.stringify({ requestedWidth: width, height, zoom, ...bounds }));
      await capture(page, `03-layout-${width}-${zoom}.png`);
      if (width === 1000) {
        await page.getByRole('button', { name: '展开 Inspector', exact: true }).click();
        await expect(page.locator('.inspector')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.inspector')).toHaveCount(0);
        await expect(page.getByRole('button', { name: '展开 Inspector', exact: true })).toBeFocused();
      }
    }
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1440, 900); win.webContents.setZoomFactor(1);
    });
  });

  await check('appearance IPC rejects malformed and oversized requests', async () => {
    const before = await page.evaluate(async () => (await (window as unknown as DesktopWindow).oraculumDesktop.getState()).preferences);
    await page.evaluate(async () => (window as unknown as DesktopWindow).oraculumDesktop.setPreferences({}));
    assert.deepEqual(await page.evaluate(async () => (await (window as unknown as DesktopWindow).oraculumDesktop.getState()).preferences), before);
    const rejected = await page.evaluate(async () => {
      const api = (window as unknown as DesktopWindow).oraculumDesktop;
      const values: unknown[] = [null, [], 'dark', { theme: 'custom' }, { theme: 'dark', url: 'file:///tmp/probe' }, { inspectorVisible: 'yes' }, { theme: 'x'.repeat(65_536) }];
      return Promise.all(values.map(async value => {
        try { await api.setPreferences(value as Parameters<DesktopBridge['setPreferences']>[0]); return false; }
        catch { return true; }
      }));
    });
    assert.ok(rejected.every(Boolean), JSON.stringify(rejected));
    assert.deepEqual(await page.evaluate(async () => (await (window as unknown as DesktopWindow).oraculumDesktop.getState()).preferences), before);
  });

  await check('CSP blocks remote fetch, WebSocket, inline script and frames', async () => {
    negativeChecks = true;
    const blocked = await page.evaluate(async () => {
      const testWindow = window as Window & { p41InlineExecuted?: boolean };
      const violations: { directive: string; uri: string }[] = [];
      const observer = new AbortController();
      document.addEventListener('securitypolicyviolation', event => {
        violations.push({ directive: event.effectiveDirective, uri: event.blockedURI });
      }, { signal: observer.signal });
      const script = document.createElement('script');
      script.textContent = 'window.p41InlineExecuted = true';
      document.body.append(script);
      const fetchBlocked = await fetch('https://example.invalid/p41-probe').then(() => false, () => true);
      const socketBlocked = await new Promise<boolean>(resolve => {
        const deadline = setTimeout(() => resolve(false), 2000);
        try {
          const ws = new WebSocket('wss://example.invalid/p41-probe');
          ws.onerror = () => { clearTimeout(deadline); ws.close(); resolve(true); };
          ws.onopen = () => { clearTimeout(deadline); ws.close(); resolve(false); };
        } catch { clearTimeout(deadline); resolve(true); }
      });
      const frame = document.createElement('iframe');
      frame.src = 'https://example.invalid/p41-frame';
      document.body.append(frame);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const interval = setInterval(() => {
          if (violations.some(item => item.directive === 'frame-src')) {
            clearInterval(interval); resolve();
          } else if (Date.now() > deadline) {
            clearInterval(interval); reject(new Error('No frame-src CSP violation was observed.'));
          }
        }, 20);
      });
      frame.remove(); script.remove();
      observer.abort();
      return { fetchBlocked, socketBlocked, inlineBlocked: testWindow.p41InlineExecuted !== true, violations };
    });
    assert.equal(blocked.fetchBlocked, true);
    assert.equal(blocked.socketBlocked, true);
    assert.equal(blocked.inlineBlocked, true);
    for (const uri of ['https://example.invalid/p41-probe', 'wss://example.invalid/p41-probe']) {
      assert.ok(blocked.violations.some(item => item.directive === 'connect-src' && item.uri === uri), JSON.stringify(blocked.violations));
    }
    assert.ok(blocked.violations.some(item => item.directive.startsWith('script-src') && item.uri === 'inline'), JSON.stringify(blocked.violations));
    // Cross-origin frame violation reports intentionally redact the URL path.
    assert.ok(blocked.violations.some(item => item.directive === 'frame-src'
      && (item.uri === 'https://example.invalid' || item.uri === 'https://example.invalid/p41-frame')), JSON.stringify(blocked.violations));
  });

  await check('new windows, external navigation and permissions are denied', async () => {
    const windowsBefore = app!.windows().length;
    const denied = await page.evaluate(async () => {
      const opened = window.open('https://example.invalid/p41-window', '_blank');
      const permission = await Notification.requestPermission();
      const geolocation = await navigator.permissions.query({ name: 'geolocation' });
      return { opened: opened !== null, permission, geolocation: geolocation.state };
    });
    assert.equal(denied.opened, false);
    assert.equal(denied.permission, 'denied');
    assert.equal(denied.geolocation, 'denied');
    assert.equal(app!.windows().length, windowsBefore);
    await app!.evaluate(({ BrowserWindow }) => {
      const diagnostic = globalThis as { p41NavigationDenied?: boolean };
      diagnostic.p41NavigationDenied = undefined;
      // The earlier will-frame-navigate policy can cancel before will-navigate
      // is emitted, including for the top-level document.
      BrowserWindow.getAllWindows()[0].webContents.once('will-frame-navigate', event => {
        diagnostic.p41NavigationDenied = event.defaultPrevented;
      });
    });
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'p41-nav-probe'; link.textContent = 'P4.1 navigation policy probe';
      link.href = 'https://example.invalid/p41-navigation';
      document.querySelector('main')!.prepend(link);
    });
    await page.locator('#p41-nav-probe').click({ noWaitAfter: true });
    await expect.poll(() => app!.evaluate(() => (globalThis as { p41NavigationDenied?: boolean }).p41NavigationDenied)).toBe(true);
    const readback = await app!.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return { url: wc.getURL(), markerPresent: await wc.executeJavaScript('Boolean(document.getElementById("p41-nav-probe"))') };
    });
    assert.deepEqual(readback, { url: entry, markerPresent: true });
    // Electron cancelled the real navigation before it committed. Playwright
    // can still consider that attempted navigation pending; reset its driver
    // state by reloading only the fixed trusted entry from the native process.
    await app!.evaluate(({ BrowserWindow }, entry) => BrowserWindow.getAllWindows()[0].webContents.loadURL(entry), entry);
    await expect(page.locator('.app-shell')).toBeVisible();
    // Synthetic event checks complement the actual anchor click above. They
    // do not pretend to be a real remote redirect or network transaction.
    const navigationBlocked = await app!.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return ['will-navigate', 'will-redirect', 'will-frame-navigate'].map(name => {
        let prevented = false;
        wc.emit(name, { preventDefault() { prevented = true; } }, 'https://example.invalid/p41-navigation');
        return prevented;
      });
    });
    assert.ok(navigationBlocked.every(Boolean));
    assert.equal(page.url(), entry);
    negativeChecks = false;
  });

  await check('renderer download is cancelled before saving', async () => {
    await app!.evaluate(({ BrowserWindow }) => {
      const session = BrowserWindow.getAllWindows()[0].webContents.session;
      const diagnostics = globalThis as { p41DownloadDenied?: boolean };
      diagnostics.p41DownloadDenied = undefined;
      // Registered after the product handler: observe its actual cancellation.
      session.once('will-download', event => { diagnostics.p41DownloadDenied = event.defaultPrevented; });
    });
    await page.evaluate(() => {
      const source = getComputedStyle(document.querySelector('.oracle-eye')!).maskImage;
      const url = source.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (!url) throw new Error('No local brand resource for download policy probe.');
      const link = document.createElement('a');
      link.id = 'p41-download-probe'; link.textContent = 'P4.1 download policy probe';
      link.href = url; link.download = 'p41-probe.svg';
      document.querySelector('main')!.prepend(link);
    });
    await page.locator('#p41-download-probe').click({ noWaitAfter: true });
    await expect.poll(() => app!.evaluate(() => (globalThis as { p41DownloadDenied?: boolean }).p41DownloadDenied)).toBe(true);
    await page.locator('#p41-download-probe').evaluate(element => element.remove());
  });

  await check('theme and Inspector persist across normal window close', async () => {
    await page.evaluate(async () => {
      await (window as unknown as DesktopWindow).oraculumDesktop.setPreferences({ theme: 'dark', inspectorVisible: false });
    });
    await closeWindow();
    page = await launch();
    const state = await page.evaluate(async () => (window as unknown as DesktopWindow).oraculumDesktop.getState());
    assert.deepEqual(state.preferences, { theme: 'dark', inspectorVisible: false });
    assert.equal(state.preferencesRecovered, false);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    assert.equal((await stat(join(profile, 'appearance.json'))).mode & 0o777, 0o600);
  });

  await check('programmatic native menu action restores appearance and zoom', async () => {
    // CDP keyboard dispatch does not reach Electron before-input-event on this
    // host. Exercise the real menu handler here; physical Ctrl+Shift+0 is a
    // separate compositor/input verification, never inferred from this call.
    await app!.evaluate(({ BrowserWindow, Menu }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setZoomFactor(1.25);
      const item = Menu.getApplicationMenu()?.getMenuItemById('restore-default-appearance');
      if (!item?.enabled) throw new Error('Native appearance recovery menu is unavailable.');
      item.click(item, win, {});
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as DesktopWindow).oraculumDesktop.getState()).preferences.inspectorVisible)).toBe(true);
    assert.equal(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1);
    await capture(page, '04-restored.png');
    await closeWindow();
  });

  await check('corrupt appearance safely falls back and preserves original bytes', async () => {
    const corrupt = '{ intentionally incomplete P4.1 test preference';
    await writeFile(join(profile, 'appearance.json'), corrupt, { mode: 0o600 });
    page = await launch();
    const state = await page.evaluate(async () => (window as unknown as DesktopWindow).oraculumDesktop.getState());
    assert.equal(state.preferencesRecovered, true);
    assert.deepEqual(state.preferences, { theme: 'light', inspectorVisible: true });
    assert.equal(await readFile(join(profile, 'appearance.json'), 'utf8'), corrupt);
    await page.evaluate(async () => (window as unknown as DesktopWindow).oraculumDesktop.resetAppearance());
    const recovered = (await readdir(profile)).filter(name => /^appearance-recovered-.*\.json$/.test(name));
    assert.equal(recovered.length, 1);
    assert.equal(await readFile(join(profile, recovered[0]), 'utf8'), corrupt);
    await closeWindow();
  });

  await check('no observed UI network requests, uncaught errors or resident client', async () => {
    assert.deepEqual(ordinaryExternalRequests, []);
    assert.deepEqual(pageErrors, []);
    assert.equal(app, undefined);
  });
  await writeFile(join(output, 'results.json'), JSON.stringify({
    status: 'passed', stage: 'P4.1', evidence: 'Real sandboxed Electron on GNOME/Wayland; renderer sample data only',
    versions, osSandbox, display, checks: passed, screenshots: screenshotEvidence.map(item => item.file).sort(), screenshotEvidence,
    limitations: ['No Gateway/HTTP/WS pairing or business traffic', 'No HTTPS/TLS or package installation', 'Request observation starts after Playwright launch returns; startup protection also relies on resource/session policy and unit tests', 'Redirect/frame navigation handler emission is synthetic; the external anchor click is a real renderer action', 'Native recovery menu handler is invoked programmatically; physical Ctrl+Shift+0 is verified separately because CDP does not emit before-input-event on this host', 'Compositor screenshots and native input acceptance are recorded separately'],
  }, null, 2) + '\n');
  console.log(`DESKTOP_P41_GUI_OK ${passed.length} checks; output ${output}`);
} catch (error) {
  if (app) {
    const page = app.windows()[0];
    if (page) await capture(page, 'failure.png').catch(() => undefined);
  }
  await writeFile(join(output, 'failure.json'), JSON.stringify({ stage, passed, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(temporary, { recursive: true, force: true });
}
