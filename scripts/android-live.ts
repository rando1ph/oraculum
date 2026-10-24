// Opt-in real Android WebView smoke. Prerequisites and IME checks are documented
// in PHASE_2_REMOTE.md. CDP must be forwarded from the Oraculum debug app only.
import { selectModel, selectEffort } from './composer-controls';
import { selectedThreadId } from './ui-state';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

if (!process.env.ORACULUM_ANDROID_CDP) throw new Error('Set ORACULUM_ANDROID_CDP to the current ADB-forwarded debug endpoint');
const endpoint = new URL(process.env.ORACULUM_ANDROID_CDP);
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password) {
  throw new Error('Use a local ADB-forwarded CDP endpoint');
}
const evidenceDir = '.local/evidence/phase2';
await mkdir(evidenceDir, { recursive: true });
const evidence: Record<string, unknown> = { date: new Date().toISOString(), real: true, transport: 'USB ADB reverse; not public HTTPS/WSS', approvals: [] };
const browser = await chromium.connectOverCDP(endpoint.href, { noDefaults: true });
const page = browser.contexts()[0]?.pages().find(p => p.url() === 'http://127.0.0.1:17860/');
if (!page) { await browser.close(); throw new Error('Expected the Oraculum debug WebView'); }
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  await expect(page.locator('aside .path')).toContainText('/.cache/oraculum/workspaces/phase2-android-');
  evidence.workspace = await page.locator('aside .path').innerText();
  evidence.title = await page.title();
  evidence.viewport = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth }));
  const previousThread = await selectedThreadId(page);
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', '');
  await expect(page.locator('.conversation')).not.toHaveAttribute('data-thread-id', previousThread);
  const threadId = await selectedThreadId(page);
  await selectModel(page, process.env.ORACULUM_TEST_MODEL ?? 'gpt-6-luna');
  await selectEffort(page, 'low');
  evidence.threadId = threadId;
  await page.getByLabel('消息', { exact: true }).fill(
    '中文真机测试。Controlled Oraculum Android smoke, work ONLY in cwd. Read hello.txt. ' +
    'Do not edit any file, use MCP, skills, web, subagents, other projects or global configuration. ' +
    'Make TWO SEPARATE shell approval requests sequentially using sandbox_permissions=require_escalated: ' +
    'first exactly `printf ORACULUM_ANDROID_ALLOW` with justification="Oraculum harmless Android allow test"; ' +
    'then exactly `printf ORACULUM_ANDROID_DECLINE` with justification="Oraculum harmless Android decline test". ' +
    'The second will be declined: do not retry it or execute it by another route. ' +
    'Finish with Markdown heading `## ORACULUM_ANDROID_OK` and briefly report the fixture content and both outcomes in Chinese. No additional work.',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  for (const [marker, button, decision] of [
    ['ORACULUM_ANDROID_ALLOW', '允许本次', 'accept'],
    ['ORACULUM_ANDROID_DECLINE', '拒绝', 'decline'],
  ]) {
    const approval = page.locator('.approval').filter({ has: page.locator('pre').filter({ hasText: marker }) });
    await expect(approval).toBeVisible({ timeout: 180_000 });
    const command = await approval.locator(':scope > pre').innerText();
    expect([
      `printf ${marker}`, `/bin/bash -lc 'printf ${marker}'`,
      `/bin/bash -lc "printf ${marker}"`, `/bin/sh -lc 'printf ${marker}'`,
    ], 'Never approve an unexpected command').toContain(command);
    (evidence.approvals as unknown[]).push({ command, decision, nativeIds: await approval.locator(':scope > small').first().innerText() });
    await approval.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidenceDir}/android-${decision}.png` });
    await approval.getByRole('button', { name: button, exact: true }).click();
    await expect(approval).toHaveCount(0);
  }
  await expect(page.getByRole('heading', { name: 'ORACULUM_ANDROID_OK', exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-last-turn-status', 'completed', { timeout: 30_000 });
  evidence.items = await page.locator('[data-item-id]').evaluateAll(nodes => nodes.map(n => ({
    itemId: n.getAttribute('data-item-id'), turnId: n.getAttribute('data-turn-id'),
  })));
  evidence.finalMessage = await page.locator('.message:not(.user)').last().innerText();
  await page.screenshot({ path: `${evidenceDir}/android-completed.png`, fullPage: true });
  // Reopening the actual WebView reads native history; there is no local replay.
  await page.reload();
  await expect(page.getByRole('status')).toContainText('状态已查询', { timeout: 30_000 });
  await expect(page.locator('.conversation')).toHaveAttribute('data-thread-id', threadId);
  await expect(page.getByRole('heading', { name: 'ORACULUM_ANDROID_OK', exact: true })).toBeVisible();
  await expect(page.locator('.history-warning')).toHaveCount(0);
  await expect(page.getByText(/部分历史未能恢复/)).toHaveCount(0);
  evidence.nativeHistoryReload = true;
  expect(errors).toEqual([]);
  evidence.pageErrors = errors;
  evidence.result = 'passed';
  console.log(JSON.stringify({ result: evidence.result, threadId, approvals: evidence.approvals }));
} catch (error) {
  evidence.result = 'failed';
  evidence.failure = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: `${evidenceDir}/android-live-failure.png` }).catch(() => {});
  console.error(evidence.failure);
  process.exitCode = 1;
} finally {
  await writeFile(`${evidenceDir}/android-live.json`, JSON.stringify(evidence, null, 2) + '\n');
  await browser.close(); // Detach CDP; leave the user's device and app running.
}
