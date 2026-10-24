import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NativeSessionSettings } from '../../../packages/shared/protocol';
import { nativePermissionSummary, PermissionDetails } from './permissions';

const readOnly: NativeSessionSettings = { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } };

it('shows the native policy and sandbox without guessing a selected preset', () => {
  expect(nativePermissionSummary(readOnly)).toBe('沙盒 read-only · 审批 on-request · 网络受限 · 审批方 user');
  expect(nativePermissionSummary({ ...readOnly, approvalPolicy: 'never', sandbox: { type: 'externalSandbox', networkAccess: 'enabled' } })).toBe('沙盒 external-sandbox · 审批 never · 可联网 · 审批方 user');
  expect(nativePermissionSummary({ ...readOnly, approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: true, mcp_elicitations: false } } })).toContain('审批 granular');
  expect(nativePermissionSummary({ ...readOnly, sandbox: { type: 'workspaceWrite', writableRoots: ['/allowed-extra'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } })).toContain('额外可写目录 1');
});

it('labels stale permissions and never treats an unconfirmed selection as effective', () => {
  expect(renderToStaticMarkup(<PermissionDetails settings={readOnly} synced={true} hasThread={true}/>)).toContain('原生已确认');
  const stale = renderToStaticMarkup(<PermissionDetails settings={readOnly} synced={false} hasThread={true}/>);
  expect(stale).toContain('上次确认 · 待重新查询');
  expect(stale).not.toContain('原生已确认');
  expect(renderToStaticMarkup(<PermissionDetails synced={true} hasThread={true}/>)).toContain('实际权限待 Codex 确认');
  expect(renderToStaticMarkup(<PermissionDetails synced={true} hasThread={false}/>)).toContain('创建会话后显示原生实际权限');
});

it('preserves additive native sandbox names without inventing network restrictions', () => {
  const future = { ...readOnly, sandbox: { type: 'futureSandbox' } } as unknown as NativeSessionSettings;
  expect(nativePermissionSummary(future)).toBe('沙盒 futureSandbox · 审批 on-request · 网络状态未报告 · 审批方 user');
  const legacy = { ...readOnly, sandbox: { type: 'readOnly' } } as unknown as NativeSessionSettings;
  expect(nativePermissionSummary(legacy)).toContain('网络状态未报告');
  expect(nativePermissionSummary(legacy)).not.toContain('网络受限');
  const workspace = { ...readOnly, sandbox: { type: 'workspaceWrite' } } as unknown as NativeSessionSettings;
  expect(nativePermissionSummary(workspace)).toContain('额外可写目录 未报告');
});

it('keeps exact current-session permissions readable in settings without a JSON dump', () => {
  const settings: NativeSessionSettings = { ...readOnly,
    approvalPolicy: { granular: { sandbox_approval: true, rules: false, skill_approval: true, request_permissions: false, mcp_elicitations: true } },
    sandbox: { type: 'workspaceWrite', writableRoots: ['/specific/extra-directory'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false },
  };
  const detail = renderToStaticMarkup(<PermissionDetails settings={settings} synced={false} hasThread={true}/>);
  expect(detail).toContain('上次确认 · 待重新查询');
  expect(detail).not.toContain('原生已确认');
  expect(detail).toContain('/specific/extra-directory');
  for (const [label, value] of [['沙盒审批', '开启'], ['规则审批', '关闭'], ['技能审批', '开启'], ['额外权限审批', '关闭'], ['MCP 表单审批', '开启'], ['排除 $TMPDIR 可写权限', '是'], ['排除 /tmp 可写权限', '否']]) {
    expect(detail).toContain(`<dt>${label}</dt><dd>${value}</dd>`);
  }
  expect(detail).not.toContain('title=');
  expect(detail).not.toContain('sandbox_approval');
  expect(detail).not.toContain('writableRoots');
  expect(renderToStaticMarkup(<PermissionDetails settings={settings} synced={true} hasThread={true}/>)).not.toContain('title=');
  const missing = { ...settings, sandbox: { type: 'workspaceWrite' } } as unknown as NativeSessionSettings;
  expect(renderToStaticMarkup(<PermissionDetails settings={missing} synced={true} hasThread={true}/>)).toContain('<dt>排除 /tmp 可写权限</dt><dd>未报告</dd>');
});
