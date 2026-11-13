import { describe, expect, it } from 'vitest';
import { extensionSection } from './extensions';
import { permissionReadback } from './permission-readback';
import type { CodexAdapter, JsonObject } from './codex';

const adapter = (data: JsonObject): Pick<CodexAdapter, 'readExtensions'> => ({ readExtensions: async () => ({ status: 'available', data }) });
describe('read-only extension display boundary', () => {
  it('projects skill metadata only for the authorized cwd, omitting paths and dependencies', async () => {
    const section = await extensionSection(adapter({ data: [{ cwd: '/project', errors: [], skills: [
      { name: 'safe', description: 'description', path: '/private/secret', enabled: true, dependencies: { token: 'secret' }, interface: { displayName: 'Shown' }, pluginId: 'plugin' },
    ] }] }), 'skills', '/project');
    expect(section).toEqual({ kind: 'skills', status: 'available', entries: [{ id: 'safe', name: 'Shown', enabled: true, description: 'description', source: 'plugin' }], limited: false });
    const outside = await extensionSection(adapter({ data: [{ cwd: '/outside', errors: [], skills: [{ name: 'private', enabled: true }] }] }), 'skills', '/project');
    expect(outside.status).toBe('unavailable');
    expect(JSON.stringify(outside)).not.toContain('private');
  });
  it('bounds counts, strings, partial native errors and duplicate identifiers', async () => {
    const skills = Array.from({ length: 110 }, (_, i) => ({ name: `skill-${i}`, description: 'x'.repeat(1000), enabled: true }));
    const section = await extensionSection(adapter({ data: [{ cwd: '/project', skills, errors: [{ message: 'private-error' }] }] }), 'skills', '/project');
    expect(section.entries).toHaveLength(100);
    expect(section.entries[0]!.description).toHaveLength(256);
    expect(section.limited).toBe(true);
    expect(section.reasonCode).toBe('PARTIAL_NATIVE_RESULT');
    expect(JSON.stringify(section)).not.toContain('private-error');
    const duplicate = await extensionSection(adapter({ apps: [{ id: 'id', runtimeName: 'Name', enabled: true, callable: false }, { id: 'id', runtimeName: 'Duplicate', enabled: false, callable: false }] }), 'apps', '/project');
    expect(duplicate.entries).toHaveLength(1); expect(duplicate.limited).toBe(true);
  });
  it('keeps native enabled and callable distinct and declines malformed app entries', async () => {
    const section = await extensionSection(adapter({ apps: [{ id: 'id', runtimeName: null, enabled: true, callable: false, oauthToken: 'private' }] }), 'apps', '/project');
    expect(section.entries).toEqual([{ id: 'id', name: 'id', enabled: true, callable: false }]);
    expect((await extensionSection(adapter({ apps: [{ id: 'id', enabled: true }] }), 'apps', '/project')).status).toBe('unavailable');
  });
  it('shows MCP state without claiming discovery results after tool failure or omitted resources', async () => {
    const section = await extensionSection(adapter({ data: [{ name: 'server', runtimeStatus: 'connected', authStatus: 'oAuth', tools: { secretTool: {} }, resources: [{ uri: 'secret' }], toolsError: 'secret-error', httpOrigin: 'https://private.invalid' }], nextCursor: 'unread' }), 'mcp', '/project');
    expect(section.entries).toEqual([{ id: 'server', name: 'server', status: 'connected / oAuth' }]);
    expect(section.limited).toBe(true); expect(JSON.stringify(section)).not.toContain('secret');
    expect(section.reasonCode).toBe('PARTIAL_NATIVE_RESULT');
  });
  it('labels lightweight MCP inventory and preserves a successfully discovered empty tool catalog', async () => {
    const section = await extensionSection(adapter({ data: [
      { name: 'server', runtimeStatus: null, authStatus: 'oAuth', tools: {}, resources: [], toolsError: null },
      { name: 'other', runtimeStatus: 'connected', authStatus: 'bearerToken', tools: { privateTool: {} }, resources: [], serverCapabilities: { private: 'metadata' } },
    ], nextCursor: null }), 'mcp', '/project');
    expect(section).toEqual({ kind: 'mcp', status: 'available', entries: [
      { id: 'server', name: 'server', status: 'oAuth', toolCount: 0 },
      { id: 'other', name: 'other', status: 'connected / bearerToken', toolCount: 1 },
    ], limited: true, reasonCode: 'MCP_RESOURCES_NOT_REQUESTED' });
    expect(JSON.stringify(section)).not.toContain('private');
  });
  it('bounds MCP server display entries and marks malformed or paginated inventory incomplete', async () => {
    const servers = Array.from({ length: 110 }, (_, i) => ({ name: `server-${i}`, authStatus: 'unsupported', tools: {}, resources: [] }));
    const section = await extensionSection(adapter({ data: [...servers, { name: 'malformed', tools: null }], nextCursor: 'private-cursor' }), 'mcp', '/project');
    expect(section.entries).toHaveLength(100);
    expect(section.reasonCode).toBe('PARTIAL_NATIVE_RESULT');
    expect(JSON.stringify(section)).not.toContain('private-cursor');
    expect((await extensionSection(adapter({ data: [{ name: 'malformed', tools: null }], nextCursor: null }), 'mcp', '/project')).status).toBe('unavailable');
  });
  it('returns successful Skills and Apps when MCP times out without sharing its error content', async () => {
    const native: Pick<CodexAdapter, 'readExtensions'> = { readExtensions: async kind => {
      if (kind === 'mcp') return { status: 'unavailable', code: 'NATIVE_TIMEOUT' };
      return { status: 'available', data: kind === 'skills'
        ? { data: [{ cwd: '/project', errors: [], skills: [{ name: 'skill', enabled: true }] }] }
        : { apps: [{ id: 'app', runtimeName: 'App', enabled: true, callable: false }] } };
    } };
    const sections = await Promise.all((['skills', 'mcp', 'apps'] as const).map(kind => extensionSection(native, kind, '/project')));
    expect(sections.map(section => section.status)).toEqual(['available', 'unavailable', 'available']);
    expect(sections[1]).toEqual({ kind: 'mcp', status: 'unavailable', entries: [], limited: false, reasonCode: 'NATIVE_TIMEOUT' });
  });
  it('isolates native failures and never probes plugins or substitutes plugin/list', async () => {
    let calls = 0;
    const native: Pick<CodexAdapter, 'readExtensions'> = { readExtensions: async () => { calls++; return { status: 'unavailable', code: 'NATIVE_TIMEOUT' }; } };
    expect(await extensionSection(native, 'plugins', '/project')).toEqual({ kind: 'plugins', status: 'unavailable', entries: [], limited: false, reasonCode: 'STABILITY_UNVERIFIED' });
    expect(calls).toBe(0);
    expect((await extensionSection(native, 'mcp', '/project')).reasonCode).toBe('NATIVE_TIMEOUT');
    expect(calls).toBe(1);
  });
});

describe('native permission readback', () => {
  const auto = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  it('classifies only exact known sandbox and approval combinations', () => {
    for (const [sandbox, approvalPolicy, preset] of [
      [{ type: 'readOnly', networkAccess: false }, 'on-request', 'read-only'],
      [auto, 'on-request', 'auto'], [{ ...auto, writableRoots: ['/project'] }, 'on-request', 'auto'],
      [{ type: 'dangerFullAccess' }, 'never', 'full-access'],
    ] as const) expect(permissionReadback({ sandbox, approvalPolicy }, 'thread.resume', '/project', 100)?.preset).toBe(preset);
  });
  it('preserves unknown for custom approvals, extra roots/network or future constraints', () => {
    for (const result of [
      { sandbox: auto, approvalPolicy: { reject: {} } },
      { sandbox: { ...auto, writableRoots: ['/outside'] }, approvalPolicy: 'on-request' },
      { sandbox: { ...auto, networkAccess: true }, approvalPolicy: 'on-request' },
      { sandbox: { type: 'readOnly', networkAccess: false, access: { type: 'restricted' } }, approvalPolicy: 'on-request' },
    ]) expect(permissionReadback(result, 'thread.start', '/project')?.preset).toBeNull();
    expect(permissionReadback({ requestedPreset: 'full-access' }, 'thread.start', '/project')).toBeUndefined();
  });
});
