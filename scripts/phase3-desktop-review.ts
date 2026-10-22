import { DatabaseSync } from 'node:sqlite';
// Reopen an existing real acceptance thread for visual review. No model turns.
// Usage: pnpm exec tsx scripts/phase3-desktop-review.ts <acceptance.json>
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import { ProjectDirectories } from '../bridge/src/projects';
import { createServer } from '../bridge/src/server';
import type { Snapshot } from '../packages/shared/protocol';

if (!process.argv[2]) throw new Error('Pass the path of a completed phase3-desktop acceptance.json');
const source = resolve(process.argv[2]);
const original = JSON.parse(await readFile(source, 'utf8')) as { cwd: string; threadId: string; real: boolean; result: string; items: { type: string; id: string; command?: string; output?: string }[] };
if (!original.real || !original.threadId || original.result !== 'passed') throw new Error('A passing real acceptance run is required');
const output = resolve('.local/evidence/phase3/desktop-review', new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true, mode: 0o700 });
const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const fingerprint = async () => createHash('sha256').update(await readFile(configPath)).digest('hex');
const configBefore = await fingerprint();
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
const port = Number(process.env.ORACULUM_TEST_PORT ?? '17864');
env.ORACULUM_URL = `http://127.0.0.1:${port}`;
env.ORACULUM_USER_DATA_DIR = join(output, 'electron-profile');
const require = createRequire(resolve('apps/desktop/package.json'));
const evidence: Record<string, any> = {
  real: true, simulated: false, readOnlyNativeReview: true, sourceAcceptance: source,
  date: new Date().toISOString(), output, cwd: original.cwd, threadId: original.threadId,
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  buildIndexSha256: createHash('sha256').update(await readFile('apps/web/dist/index.html')).digest('hex'),
  nativeTurnRequests: 0, screenshots: [], checks: [],
};
let codex: Codex | undefined;
let server: Awaited<ReturnType<typeof createServer>> | undefined;
let app: ElectronApplication | undefined;
const errors: string[] = [];

async function resize(page: Page, width: number, height: number) {
  await app!.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
}
async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const filename = join(output, `${name}.png`);
  await page.screenshot({ path: filename, animations: 'disabled' });
  evidence.screenshots.push({ name, filename, viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) });
}
async function checkGeometry(page: Page, columns: boolean) {
  const width = await page.evaluate(() => innerWidth);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const composer = await page.locator('.composer').boundingBox();
  expect(composer!.x + composer!.width).toBeLessThanOrEqual(width + 1);
  if (columns) {
    const nav = await page.locator('.navigation').boundingBox();
    const conversation = await page.locator('.conversation').boundingBox();
    const inspector = await page.locator('.inspector').boundingBox();
    expect(nav!.x + nav!.width).toBeLessThanOrEqual(conversation!.x + 1);
    expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(inspector!.x + 1);
    expect(inspector!.x + inspector!.width).toBeLessThanOrEqual(width + 1);
  }
}
async function showRepair(page: Page) {
  await page.getByRole('heading', { name: '加法修复完成', exact: true }).evaluate(element => {
    const scroller = element.closest('.conversation-scroll')!;
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 30;
  });
}

try {
  codex = new Codex(original.cwd);
  const nativeRequest = codex.request.bind(codex);
  codex.request = async <T>(method: string, params: object): Promise<T> => {
    if (method === 'turn/start' || method === 'thread/start') {
      evidence.nativeTurnRequests++;
      throw new Error('Read-only visual review forbids starting native threads or turns');
    }
    return nativeRequest<T>(method, params);
  };
  const projects = new ProjectDirectories(dirname(original.cwd), original.cwd, new DatabaseSync(':memory:'));
  await projects.register(original.cwd);
  const service = new BridgeService(codex, original.cwd, undefined, projects);
  await codex.initialize();
  server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
  await server.listen({ host: '127.0.0.1', port });
  app = await electron.launch({ executablePath: require('electron'), args: [resolve('apps/desktop/main.cjs')], env });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await resize(page, 1440, 960);
  await expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询', { timeout: 30_000 });
  await page.locator(`nav[aria-label="原生会话"] button[title="${original.threadId}"]`).click();
  await expect(page.getByTestId('thread-id')).toHaveText(original.threadId);
  const snapshot = await service.dispatch('bridge/subscribe', { threadId: original.threadId }) as Snapshot;
  const recordedTest = original.items.find(item => item.type === 'commandExecution' && item.command?.includes('node --test'));
  const restoredTest = snapshot.thread.turns.flatMap(turn => turn.items).find(item => item.id === recordedTest?.id);
  const recordedOutput = recordedTest?.output ?? '';
  const restoredOutput = restoredTest?.type === 'commandExecution' ? restoredTest.aggregatedOutput ?? '' : undefined;
  evidence.nativeTestOutput = {
    itemId: recordedTest?.id, restored: restoredOutput !== undefined,
    byteEqual: restoredOutput === recordedOutput,
    recordedSha256: createHash('sha256').update(recordedOutput).digest('hex'),
    restoredSha256: restoredOutput === undefined ? null : createHash('sha256').update(restoredOutput).digest('hex'),
  };
  evidence.electron = await app.evaluate(({ app }) => ({ version: process.versions.electron, chromium: process.versions.chrome, userData: app.getPath('userData') }));
  expect(evidence.electron.userData).toBe(env.ORACULUM_USER_DATA_DIR);
  await page.getByRole('button', { name: '查看 Diff', exact: true }).first().click();
  await expect(page.locator('.inspector .cm-content')).toContainText(/a\s*\+\s*b/);
  await showRepair(page);
  await checkGeometry(page, true);
  await screenshot(page, '01-desktop-native-diff');
  await page.getByRole('separator', { name: '调整导航宽度' }).focus();
  for (let index = 0; index < 6; index++) await page.keyboard.press('ArrowRight');
  await page.getByRole('separator', { name: '调整检查器宽度' }).focus();
  for (let index = 0; index < 17; index++) await page.keyboard.press('ArrowLeft');
  await resize(page, 1150, 820);
  await checkGeometry(page, true);
  await showRepair(page);
  await screenshot(page, '02-1150px-max-panel-preferences');
  evidence.checks.push('1440px default and 1150px maximum panel preferences do not overlap or overflow');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await resize(page, 980, 760);
  await page.getByLabel('消息', { exact: true }).fill('真实长提示词验收：草稿仅停留在输入框，不发送给模型。\n'.repeat(30));
  await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.jump-latest')).toBeVisible();
  await checkGeometry(page, false);
  const composer = await page.locator('.composer').boundingBox();
  const jump = await page.locator('.jump-latest').boundingBox();
  expect(jump!.y + jump!.height).toBeLessThanOrEqual(composer!.y + 1);
  await screenshot(page, '03-narrow-long-composer');
  await page.getByRole('button', { name: '展开输入框', exact: true }).click();
  const expandedComposer = await page.locator('.composer').boundingBox();
  const expandedJump = await page.locator('.jump-latest').boundingBox();
  expect(expandedJump!.y + expandedJump!.height).toBeLessThanOrEqual(expandedComposer!.y + 1);
  await screenshot(page, '04-narrow-expanded-composer');
  evidence.checks.push('return-to-latest stays outside long and expanded composer');
  await page.getByLabel('消息', { exact: true }).fill('');
  await resize(page, 1440, 960);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await screenshot(page, '05-settings');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  expect(evidence.nativeTurnRequests).toBe(0);
  expect(await fingerprint()).toBe(configBefore);
  expect(errors).toEqual([]);
  evidence.result = 'passed';
  console.log(JSON.stringify({ result: evidence.result, output, nativeTurnRequests: 0, checks: evidence.checks }, null, 2));
} catch (error) {
  evidence.result = 'failed'; evidence.failure = String(error); process.exitCode = 1;
  console.error(evidence.failure);
  if (app) await screenshot(await app.firstWindow(), 'failure').catch(() => {});
} finally {
  for (const close of [() => app?.close(), () => server?.close(), () => codex?.close()]) {
    try { await close(); }
    catch (error) { evidence.cleanupErrors = [...(evidence.cleanupErrors ?? []), String(error)]; process.exitCode = 1; }
  }
  evidence.rendererErrors = errors;
  evidence.globalConfigUnchanged = await fingerprint() === configBefore;
  if (evidence.cleanupErrors?.length || !evidence.globalConfigUnchanged) evidence.result = 'failed';
  await writeFile(join(output, 'review.json'), JSON.stringify(evidence, null, 2) + '\n');
}
