import type { NativeSessionSettings, PermissionMode } from '../../../packages/shared/protocol';

export const permissionModes: { value: PermissionMode; label: string }[] = [
  { value: 'inherit', label: '继承原生' },
  { value: 'read-only', label: 'Read Only' },
  { value: 'auto', label: 'Auto' },
  { value: 'full-access', label: 'Full Access' },
];

export function nativePermissionSummary(settings: NativeSessionSettings) {
  const { sandbox, approvalPolicy, approvalsReviewer } = settings;
  const policy = typeof approvalPolicy === 'string' ? approvalPolicy : 'granular';
  const sandboxName = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access', externalSandbox: 'external-sandbox' }[sandbox.type] ?? sandbox.type;
  const network = sandbox.type === 'dangerFullAccess' ? '可联网'
    : sandbox.type === 'externalSandbox' ? (sandbox.networkAccess === 'enabled' ? '可联网' : sandbox.networkAccess === 'restricted' ? '网络受限' : '网络状态未报告')
    : sandbox.type === 'readOnly' || sandbox.type === 'workspaceWrite'
      ? sandbox.networkAccess === true ? '可联网' : sandbox.networkAccess === false ? '网络受限' : '网络状态未报告'
      : '网络状态未报告';
  const roots = sandbox.type === 'workspaceWrite' ? ` · 额外可写目录 ${Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots.length : '未报告'}` : '';
  return `沙盒 ${sandboxName} · 审批 ${policy} · ${network}${roots} · 审批方 ${approvalsReviewer}`;
}

export function PermissionStatus({ settings, synced, hasThread }: {
  settings?: NativeSessionSettings; synced: boolean; hasThread: boolean;
}) {
  return <p className="permission-status" data-testid="effective-permissions" aria-live="polite" title={settings ? JSON.stringify(settings) : undefined}>
    {settings ? <><span>{synced ? '原生已确认' : '上次确认 · 待重新查询'}：</span>{nativePermissionSummary(settings)}</>
      : hasThread ? '实际权限待 Codex 确认' : '创建会话后显示原生实际权限'}
  </p>;
}
