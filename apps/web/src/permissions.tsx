import { Fragment } from 'react';
import type { NativeSessionSettings, PermissionMode } from '../../../packages/shared/protocol';

export const permissionModes: { value: PermissionMode; label: string }[] = [
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

// Keep exact permission facts available in Settings without exposing the native
// protocol envelope or filling the conversation with configuration diagnostics.
export function PermissionDetails({ settings, synced, hasThread }: {
  settings?: NativeSessionSettings; synced: boolean; hasThread: boolean;
}) {
  const granular = settings && typeof settings.approvalPolicy === 'object' ? settings.approvalPolicy.granular : undefined;
  const workspace = settings?.sandbox.type === 'workspaceWrite' ? settings.sandbox : undefined;
  const flag = (value: boolean | undefined) => value === undefined ? '未报告' : value ? '是' : '否';
  const categories = [
    ['sandbox_approval', '沙盒审批'], ['rules', '规则审批'], ['skill_approval', '技能审批'],
    ['request_permissions', '额外权限审批'], ['mcp_elicitations', 'MCP 表单审批'],
  ] as const;
  return <details className="permission-details"><summary>当前会话权限详情</summary>
    <p>{settings ? <>{synced ? '原生已确认' : '上次确认 · 待重新查询'}：{nativePermissionSummary(settings)}</>
      : hasThread ? '实际权限待 Codex 确认' : '创建会话后显示原生实际权限'}</p>
    {granular && <><p>审批类别开关</p><dl className="native-config">{categories.map(([key, label]) => <Fragment key={key}><dt>{label}</dt><dd>{granular[key] === undefined ? '未报告' : granular[key] ? '开启' : '关闭'}</dd></Fragment>)}</dl></>}
    {workspace && <><p>额外可写目录</p>{Array.isArray(workspace.writableRoots)
      ? workspace.writableRoots.length ? <ul>{workspace.writableRoots.map(root => <li className="path" key={root}>{root}</li>)}</ul> : <p>无额外可写目录</p>
      : <p>未报告</p>}
      <dl className="native-config"><dt>排除 $TMPDIR 可写权限</dt><dd>{flag(workspace.excludeTmpdirEnvVar)}</dd><dt>排除 /tmp 可写权限</dt><dd>{flag(workspace.excludeSlashTmp)}</dd></dl>
    </>}
  </details>;
}
