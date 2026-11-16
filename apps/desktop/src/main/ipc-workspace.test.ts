import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type { PreferencesStore } from './preferences';
import type { GatewayTransport } from './gateway-transport';
import type { OperationJournal } from './journal';
import type { WorkspaceState } from '../contracts/workspace';
import { APP_ENTRY } from './bundle';
import { registerDesktopIpc } from './ipc';
import { IPC } from './ipc-channels';
import { DesktopWorkspace, rendererProjection } from './workspace';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => mocks.handlers.set(name, callback), removeHandler: (name: string) => mocks.handlers.delete(name) },
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.remove },
}));
const originalMainFrame = Object.getOwnPropertyDescriptor(process, 'isMainFrame');
afterEach(() => {
  mocks.handlers.clear(); vi.clearAllMocks(); vi.unstubAllGlobals();
  if (originalMainFrame) Object.defineProperty(process, 'isMainFrame', originalMainFrame);
  else Reflect.deleteProperty(process, 'isMainFrame');
});

function fixture() {
  const frame = { url: APP_ENTRY, detached: false, isDestroyed: () => false };
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false, send: vi.fn(), setZoomFactor: vi.fn() };
  const event = { sender: contents, senderFrame: frame };
  const preferences = { read: () => ({ preferences: { theme: 'light', inspectorVisible: true }, preferencesRecovered: false }), update: vi.fn(), reset: vi.fn() };
  const transport = { identity: null, disconnect: vi.fn(), request: vi.fn(), connect: vi.fn(), pair: vi.fn() };
  const journal = { list: vi.fn(() => []), pending: vi.fn(() => []) };
  const dialogs = { chooseUpload: vi.fn(), chooseDownload: vi.fn() }; const publish = vi.fn();
  const workspace = new DesktopWorkspace(transport as unknown as GatewayTransport, journal as unknown as OperationJournal, dialogs, publish, true);
  const ipc = registerDesktopIpc(contents as unknown as WebContents, preferences as unknown as PreferencesStore, 'development', workspace);
  return { frame, contents, event, preferences, transport, journal, dialogs, workspace, publish, ipc,
    invoke: (name: string, ...args: unknown[]) => mocks.handlers.get(name)!(event, ...args) };
}

describe('registered workspace IPC boundary with no Electron/network process', () => {
  it('registers only five named business/settings handlers and removes them on disposal', () => {
    const f = fixture();
    expect([...mocks.handlers.keys()].sort()).toEqual([IPC.getState, IPC.setPreferences, IPC.resetAppearance, IPC.getWorkspace, IPC.workspaceAction].sort());
    for (const generic of ['request', 'rpc', 'fetch', 'readFile', 'execute', 'gateway', 'token', 'credential']) expect(mocks.handlers.has(generic)).toBe(false);
    f.ipc.dispose(); expect(mocks.handlers.size).toBe(0);
  });

  it.each(['other-window', 'child-frame', 'null-frame', 'detached', 'destroyed', 'query', 'remote'])('blocks every workspace handler from %s before touching state/actions', scenario => {
    const f = fixture(); const state = vi.spyOn(f.workspace, 'state'); const action = vi.spyOn(f.workspace, 'action');
    const event: any = { ...f.event };
    if (scenario === 'other-window') event.sender = { ...f.contents };
    if (scenario === 'child-frame') event.senderFrame = { ...f.frame };
    if (scenario === 'null-frame') event.senderFrame = null;
    if (scenario === 'detached') f.frame.detached = true;
    if (scenario === 'destroyed') f.contents.isDestroyed = () => true;
    if (scenario === 'query') f.frame.url = APP_ENTRY + '?fake=1';
    if (scenario === 'remote') f.frame.url = 'https://fixture.invalid/';
    expect(() => mocks.handlers.get(IPC.getWorkspace)!(event)).toThrow('IPC_NOT_AUTHORIZED');
    expect(() => mocks.handlers.get(IPC.workspaceAction)!(event, { type: 'upload' })).toThrow('IPC_NOT_AUTHORIZED');
    expect(state).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
    expect(f.dialogs.chooseUpload).not.toHaveBeenCalled(); expect(f.transport.request).not.toHaveBeenCalled();
  });

  it('rejects excess invocation arguments before dispatch', () => {
    const f = fixture(); const action = vi.spyOn(f.workspace, 'action');
    expect(() => f.invoke(IPC.getWorkspace, { headers: {} })).toThrow('INVALID_ARGUMENTS');
    expect(() => f.invoke(IPC.workspaceAction)).toThrow('INVALID_ARGUMENTS');
    expect(() => f.invoke(IPC.workspaceAction, { type: 'upload' }, '/private/file')).toThrow('INVALID_ARGUMENTS');
    expect(action).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'request', method: 'POST', url: '/api/v2/projects' },
    { type: 'rpc', method: 'exec', params: {} },
    { type: 'upload', path: '/home/private/secret.txt' },
    { type: 'downloadFile', path: '../secret.txt' },
    { type: 'previewFile', path: '/etc/passwd' },
    { type: 'reconnect', endpoint: 'https://other.invalid/' },
    { type: 'connect', endpoint: 'http://192.0.2.1/' },
    { type: 'connect', endpoint: 'https://user:password@fixture.invalid/' },
    { type: 'connect', endpoint: 'https://fixture.invalid/?access_token=secret' },
    { type: 'pair', code: 'A'.repeat(32), label: 'Fixture', deviceCredential: 'injected' },
    { type: 'send', text: 'hello', headers: { authorization: 'Bearer injected' } },
  ])('refuses untrusted business payload %# without dialog, auth, or network work', async payload => {
    const f = fixture();
    await expect(f.invoke(IPC.workspaceAction, payload)).rejects.toThrow(/WORKSPACE_ACTION_INVALID|ENDPOINT_INVALID/);
    expect(f.transport.connect).not.toHaveBeenCalled(); expect(f.transport.pair).not.toHaveBeenCalled();
    expect(f.transport.request).not.toHaveBeenCalled(); expect(f.dialogs.chooseUpload).not.toHaveBeenCalled(); expect(f.dialogs.chooseDownload).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('returns cloned, sanitized state rather than transport credentials or local filesystem capabilities', async () => {
    const f = fixture();
    const internal = f.workspace as unknown as { value: WorkspaceState };
    Object.assign(internal.value, {
      preview: { name: 'fixture.txt', mime: 'text/plain', text: 'open /home/private/project/fixture.txt', limited: false },
      extensions: { nested: { accessToken: 'TOKEN_FIXTURE', deviceCredential: 'CREDENTIAL_FIXTURE', authorization: 'Bearer TOKEN_FIXTURE', canonicalPath: '/home/private/project', localPath: '/tmp/selected.txt', label: 'Visible extension' } },
    });
    const state = f.invoke(IPC.getWorkspace) as WorkspaceState;
    const encoded = JSON.stringify(state);
    for (const forbidden of ['TOKEN_FIXTURE', 'CREDENTIAL_FIXTURE', '/home/private', '/tmp/selected.txt', 'canonicalPath', 'localPath', 'accessToken']) expect(encoded).not.toContain(forbidden);
    expect(encoded).toContain('Visible extension');
    state.connection.endpoint = 'https://attacker.invalid/'; state.projects.push({ id: 'fake', name: 'fake', rootId: 'fake', available: true });
    expect((f.invoke(IPC.getWorkspace) as WorkspaceState).connection.endpoint).toBe('');
    expect((f.invoke(IPC.getWorkspace) as WorkspaceState).projects).toHaveLength(0);
    const result = await f.invoke(IPC.workspaceAction, { type: 'disconnect' });
    expect(JSON.stringify(result)).not.toContain('TOKEN_FIXTURE'); expect(f.publish).toHaveBeenCalled();
  });

  it('strips prototype keys from projected native records and does not mutate the trusted source', () => {
    const f = fixture(); const input = f.workspace.state();
    input.plan = JSON.parse('{"constructor":{"accessToken":"SECRET"},"__proto__":{"polluted":true},"steps":["read fixture"]}');
    const projected = rendererProjection(input);
    expect(projected.plan).toEqual({ steps: ['read fixture'] });
    expect(Object.hasOwn(input.plan as object, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('sandbox preload named-method surface', () => {
  it.each([['main', true, APP_ENTRY], ['child', false, APP_ENTRY], ['query', true, APP_ENTRY + '?frame=1'], ['remote', true, 'https://fixture.invalid/']] as const)('exposes bridge only for the exact main entry: %s', async (_name, main, href) => {
    vi.resetModules(); Object.defineProperty(process, 'isMainFrame', { configurable: true, value: main }); vi.stubGlobal('location', { href });
    await import('../preload/index');
    expect(mocks.expose).toHaveBeenCalledTimes(main && href === APP_ENTRY ? 1 : 0);
    if (!main || href !== APP_ENTRY) return;
    const [name, bridge] = mocks.expose.mock.calls[0];
    expect(name).toBe('oraculumDesktop'); expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual(['getState', 'setPreferences', 'resetAppearance', 'getWorkspace', 'workspaceAction', 'onWorkspaceChanged', 'onStateChanged'].sort());
    expect(bridge).not.toHaveProperty('invoke'); expect(bridge).not.toHaveProperty('send'); expect(bridge).not.toHaveProperty('request');
    const listener = vi.fn(); const unsubscribe = bridge.onWorkspaceChanged(listener);
    const [channel, callback] = mocks.on.mock.calls[0];
    const state = { connection: { status: 'offline' } }; const event = { sender: 'must-not-cross' };
    callback(event, state); expect(listener).toHaveBeenCalledExactlyOnceWith(state);
    expect(channel).toBe(IPC.workspaceChanged); unsubscribe(); expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(channel, callback);
    expect(() => bridge.onWorkspaceChanged({})).toThrow('INVALID_LISTENER');
  });
});
