import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BridgeService } from './service';

function fixture() {
  const bus = new EventEmitter();
  const request = vi.fn(async (_method: string, _params: object): Promise<any> => ({}));
  const send = vi.fn();
  const service = new BridgeService({ on: bus.on.bind(bus), request, send }, '/fixture');
  const events: any[] = [];
  service.on('event', event => events.push(event));
  return { bus, request, send, service, events };
}
describe('sanitized native usage routing', () => {
  it('routes global limits without a thread and strips private fields', () => {
    const { bus, events } = fixture();
    bus.emit('message', { method: 'account/rateLimits/updated', params: { accountId: 'private', rateLimits: {
      limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1730947200 }, email: 'private',
    } } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'accountLimits', snapshot: { buckets: [{ limitId: 'codex', primary: { usedPercent: 25 } }] } });
    expect(JSON.stringify(events)).not.toContain('private');
  });
});

import { NativeUsage, normalizeLimits, normalizeThreadUsage } from './usage';
import { NativeRpcError } from './codex';
import { rateLimits, tokenUsage } from '../../scripts/fixtures/usage';
const deferred = () => { let resolve!: (value: any) => void; let reject!: (value: any) => void; const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
it('keeps thread ownership, subset counts, deduplication and older-turn boundaries', async () => {
  const { bus, events, service, request, send } = fixture();
  request.mockResolvedValue(rateLimits);
  service.threads.add('a'); service.threads.add('b');
  const emit = (id: string, usage = tokenUsage, turnId = 'turn-1') => bus.emit('message', { method: 'thread/tokenUsage/updated', params: { threadId: id, turnId, tokenUsage: { ...usage, secret: 'hidden' } } });
  emit('private'); expect(events).toHaveLength(0);
  emit('a'); emit('a'); emit('b');
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ type: 'threadUsage', snapshot: { cwd: '/fixture', threadId: 'a', turnId: 'turn-1', total: tokenUsage.total } });
  expect(JSON.stringify(events)).not.toContain('hidden');
  emit('a', { ...tokenUsage, total: { ...tokenUsage.total, totalTokens: 1 } }); expect(events).toHaveLength(2);
  bus.emit('message', { method: 'turn/started', params: { threadId: 'a', turn: { id: 'turn-2' } } });
  const before = events.length;
  emit('a', { ...tokenUsage, total: { ...tokenUsage.total, totalTokens: 99999 } }); expect(events).toHaveLength(before);
  const snapshot: any = await service.dispatch('bridge/usage', { threadId: 'a', cwd: '/fixture' });
  expect(snapshot.thread.total.totalTokens).toBe(42000); expect(snapshot.thread.modelContextWindow).toBe(128000);
  await expect(service.dispatch('bridge/usage', { threadId: 'a', cwd: '/other' })).rejects.toThrow('outside');
  await expect(service.dispatch('bridge/usage', { threadId: 'private' })).rejects.toThrow('outside');
  bus.emit('message', { method: 'future/private', params: { threadId: 'a', sensitive: true } });
  expect(events.filter(e => e.event?.method === 'future/private')).toHaveLength(0);
  bus.emit('message', { id: 3, method: 'account/rateLimits/updated', params: rateLimits });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32601 }) }));
});
it('normalizes missing and malformed fields without inventing zero, unlimited, percentage or context occupancy', () => {
  expect(normalizeThreadUsage({ total: { totalTokens: -1, inputTokens: Number.NaN }, last: {}, modelContextWindow: 0 })).toMatchObject({ total: { totalTokens: null, inputTokens: null }, last: { cachedInputTokens: null }, modelContextWindow: null });
  const bucket = normalizeLimits({ rateLimits: { primary: { usedPercent: 101, resetsAt: 1793203200000, windowDurationMins: -2 }, credits: { balance: 'unknown' } } })[0];
  expect(bucket.primary).toEqual({ usedPercent: null, resetsAt: null, windowDurationMins: null });
  expect(bucket.credits).toEqual({ balance: null, hasCredits: null, unlimited: null });
  expect(normalizeLimits(rateLimits)).toHaveLength(2);
  expect(normalizeThreadUsage(tokenUsage)).toEqual(tokenUsage);
});
it('coalesces reads and merges sparse events over a late initial read without dropping labels or other buckets', async () => {
  const wait = deferred(), request = vi.fn(() => wait.promise), publish = vi.fn(); let now = 1000;
  const usage = new NativeUsage(request, publish, () => now);
  const one = usage.read(), two = usage.read(); expect(one).toBe(two); expect(request).toHaveBeenCalledTimes(1);
  usage.update({ rateLimits: { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1793203300 } } });
  wait.resolve(rateLimits);
  const result = await one;
  expect(result.buckets).toHaveLength(2);
  expect(result.buckets[0]).toMatchObject({ limitName: 'Codex', primary: { usedPercent: 31, resetsAt: 1793203300 }, secondary: { usedPercent: 42 }, credits: { balance: '12.50' } });
  usage.update({ rateLimits: { limitId: 'codex', limitName: null, credits: null, primary: null, secondary: null } });
  expect(usage.account.buckets[0]).toMatchObject({ limitName: 'Codex', primary: { usedPercent: 31 }, credits: { balance: '12.50' } });
  now += 100; await usage.read(); expect(request).toHaveBeenCalledTimes(1);
});
it('invalidates old account reads, optional usage and metadata on account changes and native disconnect', async () => {
  const limits = deferred(), activity = deferred();
  const request = vi.fn((method: string) => method === 'account/usage/read' ? activity.promise : limits.promise);
  const usage = new NativeUsage(request, () => {});
  const old = usage.read(), oldActivity = usage.readActivity();
  usage.invalidate(); limits.resolve(rateLimits); activity.resolve({ summary: { lifetimeTokens: 900 } });
  expect((await old).buckets).toEqual([]); expect((await oldActivity).lifetimeTokens).toBeNull();
  usage.update({ rateLimits: { primary: { usedPercent: 10 } } });
  usage.invalidate(true); expect((await usage.read()).buckets).toEqual([]);
  usage.update(rateLimits); expect(usage.account.status).toBe('unavailable');
});
it('detects changed internal identity without exposing it and discards an in-flight activity response', async () => {
  let now = 1000; const activity = deferred();
  const request = vi.fn(async (method: string) => method === 'account/usage/read' ? activity.promise : { ...rateLimits, accountId: now === 1000 ? 'a' : 'b' });
  const usage = new NativeUsage(request, () => {}, () => now);
  await usage.read(); const old = usage.readActivity(); now += 31_000; await usage.read();
  activity.resolve({ summary: { lifetimeTokens: 123 } });
  expect((await old).lifetimeTokens).toBeNull(); expect(usage.account.generation).toBe(1);
  expect(JSON.stringify(usage.account)).not.toContain('accountId');
});
it('isolates method-not-found, auth/provider failures and raw errors from core RPCs', async () => {
  const request = vi.fn(async () => { throw new NativeRpcError('PRIVATE credentials', -32601); });
  const usage = new NativeUsage(request, () => {});
  expect((await usage.read()).status).toBe('unsupported'); await usage.read(); expect(request).toHaveBeenCalledTimes(1);
  expect((await usage.readActivity()).status).toBe('unsupported');
  expect(JSON.stringify(usage.account)).not.toContain('PRIVATE');
  usage.invalidate(); request.mockRejectedValue(new NativeRpcError('private account/provider error', -32000));
  expect((await usage.read()).status).toBe('unavailable');
  expect((await usage.readActivity()).status).toBe('unavailable');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { TrustStore } from './trust-store';
import { createServer } from './server';
it.each([false, true])('protects usage RPC/events and late responses after device revocation (remote=%s)', async remote => {
  const dir = mkdtempSync(join(tmpdir(), 'oraculum-usage-auth-'));
  const trust = new TrustStore(dir), { service, bus, request } = fixture();
  const deferredRead = deferred(); request.mockReturnValue(deferredRead.promise);
  const app = await createServer(service, 17864, '/missing', { trust, remoteOrigin: 'https://usage.example', remoteBasePath: '/console/' });
  await app.ready();
  try {
    const headers = remote ? { host: 'usage.example', origin: 'https://usage.example', 'x-forwarded-proto': 'https' } : { host: '127.0.0.1:17864', origin: 'http://127.0.0.1:17864' };
    const base = remote ? '/console/' : '/';
    await expect(app.injectWS(base + 'ws', { headers })).rejects.toThrow('401');
    await expect(app.injectWS(base + 'ws', { headers: { ...headers, origin: 'https://wrong.example' } })).rejects.toThrow('403');
    const pair = await app.inject({ method: 'POST', url: base + 'auth/pair', headers, payload: { code: trust.createPairing().code, label: 'Usage fixture' } });
    const cookie = [pair.headers['set-cookie']].flat()[0]!.split(';')[0];
    const socket = await app.injectWS(base + 'ws', { headers: { ...headers, cookie } });
    const live = once(socket, 'message');
    bus.emit('message', { method: 'account/rateLimits/updated', params: rateLimits });
    expect(JSON.parse(String((await live)[0]))).toMatchObject({ type: 'accountLimits', snapshot: { buckets: expect.any(Array) } });
    socket.send(JSON.stringify({ id: 'usage', method: 'bridge/usage', params: {} }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('account/rateLimits/read', {}));
    trust.revoke(pair.json().device.id);
    const leaked: unknown[] = []; socket.on('message', message => leaked.push(message));
    const closed = once(socket, 'close'); deferredRead.resolve(rateLimits); await closed;
    expect(leaked).toEqual([]);
    await expect(app.injectWS(base + 'ws', { headers: { ...headers, cookie } })).rejects.toThrow('401');
    expect((await app.inject({ url: base + 'usage', headers })).statusCode).toBe(404);
  } finally { await app.close(); trust.close(); rmSync(dir, { recursive: true, force: true }); }
});
