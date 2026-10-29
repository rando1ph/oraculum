import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const { startNotifications } = createRequire(resolve('apps/desktop/main.cjs'))('./notifications.cjs');
let stopped: (() => void) | undefined, temporary: string;
afterEach(() => { stopped?.(); if (temporary) rmSync(temporary, { recursive: true, force: true }); vi.useRealTimers(); });
const id = '12345678-1234-1234-1234-123456789abc';
class Notification extends EventEmitter {
  static all: Notification[] = [];
  static isSupported() { return true; }
  show = vi.fn(); close = vi.fn();
  constructor(readonly options: any) { super(); Notification.all.push(this); }
}
async function fixture() {
  vi.useFakeTimers(); Notification.all = []; temporary = mkdtempSync(join(tmpdir(), 'oraculum-notices-'));
  let notices: any[] = [{ id, kind: 'approval', expiresAt: Date.now() + 15000, command: 'PRIVATE' }];
  let status = 200;
  const fetch = vi.fn(async () => ({ ok: status === 200, text: async () => JSON.stringify({ notices, generatedAt: Date.now(), validUntil: Date.now() + 15000 }) }));
  const window = { isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(),
    webContents: { getURL: () => 'http://127.0.0.1:17907/', session: { fetch }, executeJavaScript: vi.fn(async () => {}) } };
  const start = () => startNotifications({ window, origin: 'http://127.0.0.1:17907', icon: '/icon', userData: temporary, Notification });
  stopped = start(); await vi.advanceTimersByTimeAsync(1);
  return { window, fetch, start, notices: (value: any[]) => { notices = value; }, status: (value: number) => { status = value; } };
}
it('posts fixed OS copy once, rechecks removed requests and passes only an opaque ID to the UI', async () => {
  const f = await fixture();
  expect(Notification.all).toHaveLength(1); const note = Notification.all[0];
  expect(JSON.stringify(note.options)).not.toMatch(/PRIVATE|command/);
  note.emit('click'); expect(f.window.webContents.executeJavaScript).toHaveBeenCalledExactlyOnceWith(`location.hash = "notice=${id}"`);
  await vi.advanceTimersByTimeAsync(6000); expect(Notification.all).toHaveLength(1);
  f.notices([]); await vi.advanceTimersByTimeAsync(2000); expect(note.close).toHaveBeenCalled();
  f.window.webContents.executeJavaScript.mockClear(); note.emit('click'); expect(f.window.webContents.executeJavaScript).not.toHaveBeenCalled();
  expect(f.fetch.mock.calls[0]).toBeDefined();
});
it('persists only deduplication IDs across native restarts and clears notifications on lost authorization', async () => {
  const f = await fixture(); const note = Notification.all[0];
  f.status(401); await vi.advanceTimersByTimeAsync(2000); expect(note.close).toHaveBeenCalled();
  stopped?.(); f.status(200); stopped = f.start(); await vi.advanceTimersByTimeAsync(1);
  expect(Notification.all).toHaveLength(1);
});
