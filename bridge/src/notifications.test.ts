import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { TaskNotifications } from './notifications';
import { BridgeService } from './service';
import { createServer } from './server';
import { TrustStore } from './trust-store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, BridgeEvent } from '../../packages/shared/protocol';

const completed = (threadId = 'parent', status = 'completed', turnId = 'turn'): BridgeEvent => ({ type: 'event', event: {
  method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [{ text: 'PRIVATE CONVERSATION' }], error: { message: 'SECRET' } } },
} } as unknown as BridgeEvent);
const approval = (token = 'token', method = 'item/commandExecution/requestApproval', threadId = 'parent') => ({
  id: 3, method, bridgeToken: token, params: { threadId, turnId: 'turn', command: 'SECRET COMMAND' },
}) as Approval;

it('projects only completed/failed root turns, deduplicates and expires without carrying content', () => {
  let now = 100;
  const notices = new TaskNotifications(() => '/project', id => id === 'child' ? 'parent' : id, () => now);
  notices.observe(completed('child'));
  notices.observe(completed('parent', 'interrupted'));
  expect(notices.feed([]).notices).toEqual([]);
  notices.observe(completed('parent', 'failed', 'failed-turn'));
  const first = notices.feed([]);
  expect(first.notices[0]).toMatchObject({ kind: 'failed', threadId: 'parent' });
  expect(JSON.stringify(first)).not.toMatch(/SECRET|PRIVATE|command|error|items/);
  notices.observe(completed('parent', 'failed', 'failed-turn'));
  expect(notices.feed([])).toEqual(first);
  now += 300_001;
  expect(notices.feed([]).notices).toEqual([]);
  notices.observe(completed('parent', 'failed', 'failed-turn'));
  expect(notices.feed([]).notices).toEqual([]);
});

it('uses canonical request tokens, coalesces child requests, and removes resolved or unavailable prompts', () => {
  const notices = new TaskNotifications(() => '/project', id => id === 'child' ? 'parent' : id);
  notices.observe(completed());
  const request = approval('prompt', 'item/tool/requestUserInput', 'child');
  notices.observe({ type: 'approval', request });
  expect(notices.feed([request, approval('second')]).notices).toEqual([expect.objectContaining({ id: 'prompt', kind: 'input', threadId: 'parent' })]);
  expect(notices.feed([]).notices).toEqual([]);
  notices.observe(completed('parent', 'completed', 'new'));
  notices.observe({ type: 'unavailable', message: 'offline' });
  expect(notices.feed([]).notices).toEqual([]);
});

it('clears obsolete results on a new turn and lifecycle changes and bounds the feed', () => {
  const notices = new TaskNotifications(() => '/project', id => id);
  for (let i = 0; i < 100; i++) notices.observe(completed('thread-' + i));
  expect(notices.feed([]).notices).toHaveLength(64);
  notices.observe({ type: 'event', event: { method: 'turn/started', params: { threadId: 'thread-99', turn: { id: 'new' } } } } as unknown as BridgeEvent);
  notices.observe({ type: 'threadLifecycleChanged', threadId: 'thread-98', cwd: '/project', state: 'deleted' });
  expect(notices.feed([]).notices).toHaveLength(62);
});

it('authenticates the feed, checks Origin/header and scopes both root and configured Base Path', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'oraculum-notices-'));
  const trust = new TrustStore(temporary);
  const codex = Object.assign(new EventEmitter(), { request: vi.fn(async () => ({})), send: vi.fn() });
  const service = new BridgeService(codex as any, '/project'); service.threads.add('parent');
  const server = await createServer(service, 17907, '/missing', { trust, remoteOrigin: 'https://example.test', remoteBasePath: '/console/' });
  try {
    codex.emit('message', { id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: 'foreign' } });
    expect((await service.notificationFeed()).notices).toEqual([]);
    codex.emit('message', (completed().type === 'event' ? (completed() as any).event : null));
    for (const [origin, path, cookieName, extra] of [
      ['http://127.0.0.1:17907', '/', 'oraculum_local', {}],
      ['https://example.test', '/console/', '__Secure-oraculum_session', { 'x-forwarded-proto': 'https' }],
    ] as const) {
      const headers = { host: new URL(origin).host, origin, 'x-oraculum-notifications': '1', ...extra };
      const url = path + 'notifications';
      expect((await server.inject({ url, headers })).statusCode).toBe(401);
      const { token, device } = trust.pair(trust.createPairing().code, 'fixture', path === '/' ? origin : origin + path);
      const paired = { ...headers, cookie: `${cookieName}=${token}` };
      const response = await server.inject({ url, headers: paired });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().notices[0]).toMatchObject({ kind: 'completed' });
      expect((await server.inject({ url, headers: { ...paired, origin: 'https://foreign.test' } })).statusCode).toBe(403);
      const { 'x-oraculum-notifications': _header, ...withoutHeader } = paired;
      expect((await server.inject({ url, headers: withoutHeader })).statusCode).toBe(403);
      trust.revoke(device.id);
      expect((await server.inject({ url, headers: paired })).statusCode).toBe(401);
    }
    codex.emit('message', { method: 'turn/started', params: { threadId: 'parent', turn: { id: 'next' } } });
    codex.emit('message', { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'parent', turnId: 'next' } });
    expect((await service.notificationFeed()).notices[0]).toMatchObject({ kind: 'approval' });
    codex.emit('message', { method: 'serverRequest/resolved', params: { threadId: 'parent', requestId: 9 } });
    expect((await service.notificationFeed()).notices).toEqual([]);
    expect(codex.request).not.toHaveBeenCalled();
  } finally { await server.close(); trust.close(); await rm(temporary, { recursive: true, force: true }); }
});
