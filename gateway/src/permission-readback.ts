import { record, type JsonObject, type PermissionPreset } from './codex';

export type PermissionReadback = {
  sandboxType: string; approvalPolicy: string; preset: PermissionPreset | null;
  observedAt: number; source: 'thread.start' | 'thread.resume';
};

/** Classify native response facts, never the requested setting. Custom policies remain unclassified. */
export function permissionReadback(result: JsonObject, source: PermissionReadback['source'], cwd: string, now = Date.now()): PermissionReadback | undefined {
  const sandbox = result.sandbox;
  if (!record(sandbox) || typeof sandbox.type !== 'string' || sandbox.type.length > 100 ||
    !(typeof result.approvalPolicy === 'string' || record(result.approvalPolicy))) return undefined;
  const approvalPolicy = typeof result.approvalPolicy === 'string' ? result.approvalPolicy.slice(0, 100) : 'custom';
  let preset: PermissionPreset | null = null;
  const only = (keys: string[]) => Object.keys(sandbox).every(key => keys.includes(key));
  if (sandbox.type === 'dangerFullAccess' && approvalPolicy === 'never' && only(['type'])) preset = 'full-access';
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false && approvalPolicy === 'on-request' && only(['type', 'networkAccess'])) preset = 'read-only';
  if (sandbox.type === 'workspaceWrite' && approvalPolicy === 'on-request' && sandbox.networkAccess === false &&
    sandbox.excludeTmpdirEnvVar === false && sandbox.excludeSlashTmp === false && Array.isArray(sandbox.writableRoots) &&
    sandbox.writableRoots.every(root => root === cwd) && only(['type', 'networkAccess', 'writableRoots', 'excludeTmpdirEnvVar', 'excludeSlashTmp'])) preset = 'auto';
  return { sandboxType: sandbox.type, approvalPolicy, preset, observedAt: now, source };
}
