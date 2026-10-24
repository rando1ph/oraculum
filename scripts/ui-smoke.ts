import { selectedThreadId } from './ui-state';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath: string = require('electron');
const evidence: Record<string, unknown> = { date: new Date().toISOString() };
let app: ElectronApplication | undefined;
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete env.ELECTRON_RUN_AS_NODE;
async function launch() {
  app = await electron.launch({ executablePath, args: [resolve('apps/desktop/main.cjs')], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Oraculum 神谕' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 20_000 });
  return page;
}
try {
  await mkdir('.local/evidence', { recursive: true });
  let page = await launch();
  evidence.electron = await app!.evaluate(({ app }) => ({
    version: process.versions.electron,
    chromium: process.versions.chrome,
    ready: app.isReady(),
  }));
  const renderer = await page.evaluate(() => ({ node: typeof (window as any).require, process: typeof (window as any).process }));
  expect(renderer).toEqual({ node: 'undefined', process: 'undefined' });
  evidence.renderer = renderer;
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-6-luna');
  await page.getByLabel('思考强度', { exact: true }).selectOption('low');
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', '');
  const threadId = await selectedThreadId(page);
  evidence.threadId = threadId;
  await page.getByLabel('消息', { exact: true }).fill('Controlled UI test. Do not inspect files or use skills, MCP, web, or subagents. Request approval to execute only `printf ORACULUM_UI_APPROVAL_OK` with sandbox_permissions=require_escalated and justification="Oraculum UI approval test". If declined, do not retry. Finish with the exact text ORACULUM_UI_OK.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('heading', { name: '需要审批', exact: true })).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: '.local/evidence/electron-approval.png' });
  await page.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect(page.locator('.message:not(.user)').last()).toContainText('ORACULUM_UI_OK', { timeout: 90_000 });
  await expect(page.getByTestId('turn-status')).toHaveText('已完成', { timeout: 20_000 });
  evidence.approval = 'real request rendered and declined; native completion shown';
  await page.screenshot({ path: '.local/evidence/electron-completed.png' });
  await page.getByLabel('消息', { exact: true }).fill('Controlled test. Only run shell command `sleep 6; cat fixture.txt` in cwd, then reply exactly ORACULUM_RECONNECTED_OK. Do not inspect other files or use other tools.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('执行中', { timeout: 15_000 });
  await app!.close(); app = undefined;
  // A new actual Electron process reconnects to the same still-running Bridge.
  page = await launch();
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  await expect(page.locator('.message:not(.user)').last()).toContainText('ORACULUM_RECONNECTED_OK', { timeout: 90_000 });
  await expect(page.getByTestId('turn-status')).toHaveText('已完成', { timeout: 20_000 });
  evidence.reopen = 'same native thread completed while GUI closed/reopened';
  await page.setViewportSize({ width: 393, height: 851 });
  await page.screenshot({ path: '.local/evidence/mobile-layout.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  evidence.mobileViewport = '393px layout only; not Android WebView device evidence';
  await page.getByLabel('模型', { exact: true }).selectOption('gpt-6-luna');
  await page.getByLabel('思考强度', { exact: true }).selectOption('low');
  await page.getByLabel('消息', { exact: true }).fill('Only run `sleep 15` in cwd and then say finished. Do not read or change files.');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('执行中', { timeout: 15_000 });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByTestId('turn-status')).toHaveText('已停止', { timeout: 30_000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'interrupted', { timeout: 20_000 });
  evidence.interrupt = 'native turn/completed and queried interrupted status';
  console.log(JSON.stringify({ ...evidence, electron: { version: (evidence.electron as any).version, chromium: (evidence.electron as any).chromium } }, null, 2));
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  console.error(evidence.failure);
  process.exitCode = 1;
} finally {
  await app?.close();
  await writeFile('.local/evidence/ui-smoke.json', JSON.stringify(evidence, null, 2) + '\n');
}
