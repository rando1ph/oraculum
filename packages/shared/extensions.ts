// Display-only projection. Native configuration, credentials, endpoints, tool
// definitions and local package paths never cross this boundary.
export type ExtensionEntry = {
  id: string; name: string; description: string; source: string;
  enabled: boolean | null; installed?: boolean | null; callable?: boolean | null;
  runtimeStatus?: string | null; authStatus?: string | null;
  toolCount?: number | null; available?: boolean | null;
};
export type ExtensionKind = 'skills' | 'mcp' | 'apps' | 'plugins';
export type ExtensionList = {
  status: 'ready' | 'partial' | 'unsupported' | 'unavailable';
  entries: ExtensionEntry[]; message: string;
};
export type ExtensionsOverview = { cwd: string; threadId: string | null; lists: Record<ExtensionKind, ExtensionList> };
