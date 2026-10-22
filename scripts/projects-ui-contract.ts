// Simulated native responses; genuine directory registry and shared UI contracts.
import { EventEmitter } from 'node:events';
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectDirectories } from '../bridge/src/projects';
import { BridgeService } from '../bridge/src/service';
import { createServer } from '../bridge/src/server';
const temp = await mkdtemp(join(tmpdir(), 'oraculum-project-ui-'));
const root = join(temp, 'Projects'), cwd = join(root, 'local');
const first = join(root, 'alpha'), second = join(root, 'nested', 'alpha');
await Promise.all([cwd, first, second].map(path => mkdir(path, { recursive: true })));
const db = new DatabaseSync(':memory:');
const projects = new ProjectDirectories(root, cwd, db);
await projects.register(cwd);
const threads: any[] = [];
const bus = new EventEmitter();
const service = new BridgeService({ on: bus.on.bind(bus), send: () => {}, request: async <T>(method: string, params: any): Promise<T> => {
  let result: any;
  if (method === 'config/read') result = { config: {} };
  else if (method === 'model/list') result = { data: [], nextCursor: null };
  else if (method === 'thread/list') result = { data: threads.filter(t => t.cwd === params.cwd), nextCursor: null };
  else if (method === 'thread/start') {
    const thread = { id: `fixture-${threads.length}`, name: null, preview: '', cwd: params.cwd, status: { type: 'idle' }, turns: [] };
    threads.push(thread); result = { thread };
  } else if (method === 'thread/read' || method === 'thread/resume') result = { thread: threads.find(t => t.id === params.threadId) };
  else if (method === 'thread/turns/list') result = { data: [], nextCursor: null };
  else throw new Error(`Unexpected native call ${method}`);
  return result as T;
}}, cwd, undefined, projects);
const port = 17869, origin = `http://127.0.0.1:${port}`;
const server = await createServer(service, port, resolve('apps/web/dist'), { testOnlyUnauthenticated: true });
const browser = await chromium.launch();
const errors: string[] = [];
const ready = (page: Page) => expect(page.getByRole('status', { includeHidden: true })).toContainText('状态已查询');
async function open(page: Page) { await page.getByRole('button', { name: '浏览主机文件夹 / 添加项目', exact: true }).click(); await expect(page.getByTestId('browsed-directory')).toHaveText(root); }
async function go(page: Page, path: string) {
  await page.getByLabel('主机文件夹路径', { exact: true }).fill(path);
  await page.getByRole('button', { name: '前往', exact: true }).click();
}
try {
  await server.listen({ host: '127.0.0.1', port });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const page of [desktop, mobile]) { page.on('pageerror', e => errors.push(e.message)); await page.goto(origin); await ready(page); }
  await open(desktop);
  await go(desktop, '/etc');
  await expect(desktop.getByRole('dialog').getByRole('alert')).toContainText('outside');
  await desktop.getByRole('button', { name: 'alpha', exact: true }).click();
  await expect(desktop.getByTestId('browsed-directory')).toHaveText(first);
  await desktop.getByRole('button', { name: '添加当前文件夹为项目', exact: true }).click();
  await expect(desktop.getByRole('dialog')).toHaveCount(0);
  await expect(desktop.getByLabel('项目目录', { exact: true })).toHaveValue(first);
  await desktop.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(desktop.getByTestId('thread-id')).toHaveText('fixture-0');
  await desktop.getByLabel('消息', { exact: true }).fill('alpha 的独立草稿');
  await mobile.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(mobile.getByLabel('项目目录', { exact: true }).locator('option')).toHaveCount(2);
  await open(mobile); await mobile.getByRole('button', { name: 'nested', exact: true }).click();
  await mobile.getByRole('button', { name: 'alpha', exact: true }).click();
  await expect(mobile.getByTestId('browsed-directory')).toHaveText(second);
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mobile.getByRole('button', { name: '添加当前文件夹为项目', exact: true }).click();
  await expect(mobile.getByLabel('项目目录', { exact: true })).toHaveValue(second);
  await expect(desktop.getByLabel('项目目录', { exact: true }).locator('option')).toHaveCount(3);
  await expect(desktop.getByLabel('项目目录', { exact: true }).locator('option').filter({ hasText: second })).toHaveCount(1);
  await desktop.getByLabel('项目目录', { exact: true }).selectOption(second); await ready(desktop);
  await expect(desktop.getByTestId('thread-id')).toHaveText('尚未选择会话');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('');
  await desktop.getByLabel('项目目录', { exact: true }).selectOption(first); await ready(desktop);
  await expect(desktop.getByTestId('thread-id')).toHaveText('fixture-0');
  await expect(desktop.getByLabel('消息', { exact: true })).toHaveValue('alpha 的独立草稿');
  await open(desktop); await go(desktop, first); await expect(desktop.getByTestId('browsed-directory')).toHaveText(first);
  await desktop.getByRole('button', { name: '选择此项目', exact: true }).click();
  await expect(desktop.getByLabel('项目目录', { exact: true }).locator('option')).toHaveCount(3);
  await open(desktop);
  await desktop.getByText('已添加的项目 · 3', { exact: true }).click();
  await desktop.getByRole('button', { name: `移除项目 ${second}`, exact: true }).click();
  await expect(mobile.getByRole('alert')).toContainText('项目已移除或目录失效');
  await desktop.getByRole('button', { name: '关闭文件夹浏览器', exact: true }).click();
  await rename(first, first + '-moved');
  await desktop.getByRole('button', { name: '刷新项目目录', exact: true }).click();
  await expect(desktop.getByRole('alert')).toContainText('目录失效');
  await expect(desktop.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(desktop.getByRole('button', { name: '新建会话', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
  console.log('PASS host browser: navigation, rejected path, desktop/mobile registration, live list sync, same-name paths, duplicate registration, isolated drafts/sessions, removal and unavailable directory controls (native simulated).');
} finally { await browser.close(); await server.close(); db.close(); await rm(temp, { recursive: true, force: true }); }
