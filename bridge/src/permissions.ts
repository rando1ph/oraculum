import type { PermissionMode } from '../../packages/shared/protocol';
import type { ThreadStartParams } from '../../.local/codex-protocol/v2/ThreadStartParams';
import type { TurnStartParams } from '../../.local/codex-protocol/v2/TurnStartParams';

export function permissionMode(value: unknown): PermissionMode {
  if (value === undefined) return 'inherit';
  if (value === 'inherit' || value === 'read-only' || value === 'auto' || value === 'full-access') return value;
  throw new Error('Unknown permission mode');
}

// Official interactive presets, verified against the installed App Server.
// Never forward arbitrary policy/config fields from the renderer. Inherit must
// omit overrides; null does not reset a thread's sticky native turn settings.
export function threadPermissions(mode: PermissionMode): Pick<ThreadStartParams, 'approvalPolicy' | 'sandbox' | 'config'> {
  if (mode === 'inherit') return {};
  return {
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    sandbox: mode === 'full-access' ? 'danger-full-access' : mode === 'auto' ? 'workspace-write' : 'read-only',
    // A mode-only start otherwise inherits extra roots/network from user config.
    // Loaded threads can retain native additional roots even when turn/start
    // requests an empty list; readback, not this preset, defines actual access.
    ...(mode === 'auto' ? { config: { sandbox_workspace_write: {
      writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    } } } : {}),
  };
}

export function turnPermissions(mode: PermissionMode): Pick<TurnStartParams, 'approvalPolicy' | 'sandboxPolicy'> {
  if (mode === 'inherit') return {};
  return {
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    sandboxPolicy: mode === 'full-access' ? { type: 'dangerFullAccess' }
      : mode === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  };
}
