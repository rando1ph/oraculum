import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Approval } from '../../../packages/shared/protocol';
import { NativeRequest } from './native-request';

function render(request: Approval) {
  return renderToStaticMarkup(<NativeRequest request={request} busy={false} canAccept={true} canReply={true} reply={() => {}}/>);
}

it('retains consent facts and child-agent provenance without native identity dumps', () => {
  const request: Approval = {
    id: 'private-request-id', method: 'item/commandExecution/requestApproval', bridgeToken: 'private-approval-token',
    displayThreadIds: ['private-parent-thread'],
    params: { kind: 'writeStdin', threadId: 'private-child-thread', turnId: 'private-turn-id', itemId: 'private-item-id',
      approvalId: 'private-callback-id', environmentId: null, startedAtMs: 123,
      command: 'printf CONSENT_CHECK', cwd: '/consent-fixture', reason: '确认向现有终端写入',
      networkApprovalContext: { protocol: 'https', host: 'consent.example.test' } },
  };
  const markup = render(request);
  for (const text of ['需要审批', '终端输入', '来自子代理的请求', 'printf CONSENT_CHECK', '/consent-fixture',
    '确认向现有终端写入', '网络访问 · https · consent.example.test']) expect(markup).toContain(text);
  expect(markup).toMatch(/<button>拒绝<\/button>/);
  expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>允许本次<\/button>/);
  expect(markup).not.toContain('disabled=');
  for (const text of ['private-', '原生请求详情', 'request ID', 'networkApprovalContext', 'startedAtMs', 'approvalId']) expect(markup).not.toContain(text);
});

it('keeps unsupported MCP forms fail-closed while rejection and cancellation remain available', () => {
  const request: Approval = {
    id: 'private-form-request', method: 'mcpServer/elicitation/request',
    params: { threadId: 'private-form-thread', turnId: null, serverName: 'Consent fixture', mode: 'openai/form', _meta: null,
      message: '需要填写嵌套表单', requestedSchema: { type: 'object', properties: { nested: { type: 'object', properties: { answer: { type: 'string' } } } } } },
  };
  const markup = render(request);
  expect(markup).toContain('当前客户端尚不支持此表单结构');
  expect(markup).toContain('来源服务器 · Consent fixture');
  expect(markup).toMatch(/<button>拒绝<\/button>/);
  expect(markup).toMatch(/<button>取消<\/button>/);
  expect(markup).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>提交并允许<\/button>/);
  for (const text of ['private-form-', 'requestedSchema', '原生请求详情']) expect(markup).not.toContain(text);
});
