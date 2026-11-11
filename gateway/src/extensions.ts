import { record, type CodexAdapter, type JsonObject } from './codex';

export type ExtensionKind = 'skills' | 'mcp' | 'apps' | 'plugins';
export type ExtensionEntry = {
  id: string; name: string; description?: string; enabled?: boolean; callable?: boolean;
  status?: string; version?: string; source?: string; toolCount?: number; resourceCount?: number;
};
export type ExtensionSection = {
  kind: ExtensionKind; status: 'available' | 'unavailable'; entries: ExtensionEntry[];
  limited: boolean; reasonCode?: string;
};
const MAX_ENTRIES = 100;
const display = (value: unknown, max = 256): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : undefined;
const unavailable = (kind: ExtensionKind, reasonCode: string): ExtensionSection => ({ kind, status: 'unavailable', entries: [], limited: false, reasonCode });

/** Only bounded display metadata leaves the adapter; no paths, config, tools, URLs or raw errors. */
export async function extensionSection(codex: Pick<CodexAdapter, 'readExtensions'>, kind: ExtensionKind, cwd: string): Promise<ExtensionSection> {
  // The installed endpoint is in the generated default surface, but its public
  // stability is not established. Do not substitute the prohibited plugin/list.
  if (kind === 'plugins') return unavailable(kind, 'STABILITY_UNVERIFIED');
  let result: Awaited<ReturnType<CodexAdapter['readExtensions']>>;
  try { result = await codex.readExtensions(kind, cwd); }
  catch { return unavailable(kind, 'NATIVE_PROTOCOL'); }
  if (result.status === 'unavailable') return unavailable(kind, result.code);
  const data = result.data;
  const entries: ExtensionEntry[] = [];
  const seen = new Set<string>();
  let limited = false, incompatible = false;
  const append = (item: JsonObject, rawId: unknown, rawName: unknown, extras: Partial<ExtensionEntry>) => {
    const id = display(rawId), name = display(rawName, 160);
    if (!id || !name) { incompatible = true; return; }
    if (entries.length >= MAX_ENTRIES || seen.has(id)) { limited = true; return; }
    seen.add(id);
    entries.push({ id, name, ...extras, ...(display(item.pluginId) ? { source: display(item.pluginId) } : {}) });
  };
  if (kind === 'skills') {
    if (!Array.isArray(data.data)) return unavailable(kind, 'NATIVE_PROTOCOL');
    for (const group of data.data) {
      if (!record(group) || group.cwd !== cwd || !Array.isArray(group.skills) || !Array.isArray(group.errors)) { incompatible = true; continue; }
      limited ||= group.errors.length > 0;
      for (const skill of group.skills) {
        if (!record(skill) || typeof skill.enabled !== 'boolean') { incompatible = true; continue; }
        const title = record(skill.interface) ? display(skill.interface.displayName, 160) : undefined;
        append(skill, skill.name, title ?? skill.name, { enabled: skill.enabled,
          ...(display(skill.description) ? { description: display(skill.description) } : {}) });
      }
    }
  } else if (kind === 'mcp') {
    if (!Array.isArray(data.data)) return unavailable(kind, 'NATIVE_PROTOCOL');
    limited ||= data.nextCursor != null;
    for (const server of data.data) {
      if (!record(server) || !record(server.tools) || !Array.isArray(server.resources)) { incompatible = true; continue; }
      const status = display(server.runtimeStatus, 80), auth = display(server.authStatus, 80);
      append(server, server.name, server.name, { ...(status || auth ? { status: [status, auth].filter(Boolean).join(' / ') } : {}),
        toolCount: Object.keys(server.tools).length, resourceCount: server.resources.length });
      limited ||= server.toolsError != null;
    }
  } else {
    if (!Array.isArray(data.apps)) return unavailable(kind, 'NATIVE_PROTOCOL');
    for (const app of data.apps) {
      if (!record(app) || typeof app.enabled !== 'boolean' || typeof app.callable !== 'boolean') { incompatible = true; continue; }
      append(app, app.id, app.runtimeName ?? app.id, { enabled: app.enabled, callable: app.callable });
    }
  }
  if (incompatible && !entries.length) return unavailable(kind, 'NATIVE_PROTOCOL');
  limited ||= incompatible;
  return { kind, status: 'available', entries, limited, ...(limited ? { reasonCode: 'PARTIAL_NATIVE_RESULT' } : {}) };
}
