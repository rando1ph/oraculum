import { NativeRpcError } from './codex';
import type { ExtensionEntry, ExtensionKind, ExtensionList, ExtensionsOverview } from '../../packages/shared/extensions';

type Request = <T>(method: string, params: object) => Promise<T>;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, limit = 180) => typeof value === 'string' ? value.slice(0, limit) : '';
const flag = (value: unknown) => typeof value === 'boolean' ? value : null;
const array = (value: unknown): unknown[] => { if (!Array.isArray(value)) throw new Error('Invalid inventory'); return value; };
const scopes: Record<string, string> = { repo: '项目', user: '用户', system: '内置', admin: '托管' };
const maxEntries = 500;

// Each optional inventory has its own bounded deadline. A blocked catalog must
// neither delay core operations nor leak the upstream error/configuration.
async function bounded(request: Request, method: string, params: object, deadline: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([request<unknown>(method, params), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Inventory timeout')), Math.max(1, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function inventory(kind: ExtensionKind, request: Request, cwd: string, threadId?: string): Promise<ExtensionList> {
  const entries = new Map<string, ExtensionEntry>();
  let partial = false;
  const add = (value: ExtensionEntry | undefined) => {
    if (!value || !value.id || !value.name) { partial = true; return; }
    if (entries.size >= maxEntries && !entries.has(value.id)) { partial = true; return; }
    entries.set(value.id, value);
  };
  const deadline = Date.now() + 12000;
  const read = async (method: string, params: object) => {
    const result = object(await bounded(request, method, params, deadline));
    if (!result) throw new Error('Invalid inventory');
    return result;
  };
  try {
    if (kind === 'skills') {
      const result = await read('skills/list', { cwds: [cwd] });
      for (const raw of array(result.data)) {
        const group = object(raw);
        if (!group || group.cwd !== cwd) { partial = true; continue; }
        if (!Array.isArray(group.errors) || group.errors.length) partial = true;
        for (const rawSkill of array(group.skills)) {
          const skill = object(rawSkill);
          if (!skill) { partial = true; continue; }
          add({ id: `${text(skill.scope)}:${text(skill.pluginId)}:${text(skill.name)}`, name: text(skill.name),
            description: text(skill.description, 600), source: skill.pluginId ? '插件' : scopes[text(skill.scope)] ?? '来源未知', enabled: flag(skill.enabled) });
        }
      }
    }
    if (kind === 'mcp') {
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
        const result = await read('mcpServerStatus/list', { limit: 50, detail: 'toolsAndAuthOnly', ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
        for (const raw of array(result.data)) {
          const server = object(raw);
          if (!server) { partial = true; continue; }
          const runtimeStatus = ['notStarted', 'starting', 'connected', 'authenticationRequired', 'failed', 'cancelled', 'disabled'].includes(text(server.runtimeStatus)) ? text(server.runtimeStatus) : null;
          const authStatus = ['unknown', 'unsupported', 'notLoggedIn', 'bearerToken', 'oAuth'].includes(text(server.authStatus)) ? text(server.authStatus) : null;
          add({ id: text(server.name), name: text(server.name), description: server.toolsError ? '工具目录读取失败' : '',
            source: server.pluginId ? '插件 MCP' : '已配置 MCP', enabled: runtimeStatus === 'disabled' ? false : null,
            runtimeStatus, authStatus, toolCount: object(server.tools) && !server.toolsError ? Object.keys(object(server.tools)!).length : null });
          if (server.toolsError) partial = true;
        }
        if (result.nextCursor === null) break;
        if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor) || page === 19 || entries.size >= maxEntries) { partial = true; break; }
        cursor = result.nextCursor; seen.add(cursor);
      }
    }
    if (kind === 'apps') {
      // Read the committed runtime snapshot; do not request a tool publication,
      // OAuth flow or the remote app/list marketplace (which may return 403).
      const result = await read('app/installed', { ...(threadId ? { threadId } : {}), forceRefresh: false });
      for (const raw of array(result.apps)) {
        const app = object(raw);
        if (!app) { partial = true; continue; }
        add({ id: text(app.id), name: text(app.runtimeName) || text(app.id), description: '', source: 'Codex Apps',
          installed: true, enabled: flag(app.enabled), callable: flag(app.callable) });
      }
    }
    if (kind === 'plugins') {
      const result = await read('plugin/list', { cwds: [cwd], forceRefetch: false });
      if (!Array.isArray(result.marketplaceLoadErrors) || result.marketplaceLoadErrors.length) partial = true;
      for (const raw of array(result.marketplaces)) {
        const marketplace = object(raw);
        if (!marketplace) { partial = true; continue; }
        for (const rawPlugin of array(marketplace.plugins)) {
          const plugin = object(rawPlugin);
          if (!plugin) { partial = true; continue; }
          // Catalog availability is not installation, enablement or callability.
          if (plugin.installed !== true && plugin.enabled !== true) continue;
          const ui = object(plugin.interface), source = object(plugin.source);
          add({ id: text(plugin.id), name: text(ui?.displayName) || text(plugin.name), description: text(ui?.shortDescription, 600),
            source: ({ local: '本地插件', git: 'Git 插件', npm: 'npm 插件', remote: '远程插件' } as Record<string, string>)[text(source?.type)] ?? '插件来源未知',
            installed: flag(plugin.installed), enabled: flag(plugin.enabled), available: plugin.availability === 'AVAILABLE' ? true : plugin.availability === 'DISABLED_BY_ADMIN' ? false : null });
        }
      }
    }
    return { status: partial ? 'partial' : 'ready', entries: [...entries.values()], message: partial ? '部分内容未能读取，当前列表可能不完整。' : '' };
  } catch (error) {
    const unsupported = error instanceof NativeRpcError && (error.code === -32601 || /experimental.*(?:required|enabled)|requires.*experimental/i.test(error.message));
    return { status: entries.size ? 'partial' : unsupported ? 'unsupported' : 'unavailable', entries: [...entries.values()],
      message: unsupported ? '当前 Codex 未提供此只读能力。' : /403|forbidden|cloudflare/i.test(error instanceof Error ? error.message : '')
        ? '原生服务拒绝访问，暂时无法读取。' : '暂时无法读取；可稍后刷新。' };
  }
}

export async function readExtensions(request: Request, cwd: string, threadId?: string): Promise<ExtensionsOverview> {
  const kinds = ['skills', 'mcp', 'apps', 'plugins'] as const;
  const lists = await Promise.all(kinds.map(async kind => [kind, await inventory(kind, request, cwd, threadId)] as const));
  return { cwd, threadId: threadId ?? null, lists: Object.fromEntries(lists) as ExtensionsOverview['lists'] };
}
