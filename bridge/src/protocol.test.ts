import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { assertCodexVersion } from './version';
import lock from '../../protocol.lock.json';
const schema = (name: string) => JSON.parse(readFileSync(`.local/codex-schema/${name}.json`, 'utf8'));
it('matches the reviewed native schema bundle and rejects a different runtime version', () => {
  expect(createHash('sha256').update(readFileSync('.local/codex-schema/codex_app_server_protocol.schemas.json')).digest('hex')).toBe(lock.schemaBundleSha256);
  expect(() => assertCodexVersion(lock.codexVersion)).not.toThrow();
  expect(() => assertCodexVersion('codex-cli 0.161.0')).toThrow('Review');
});
it('uses the generated native history and approval contracts without inventing durable idempotency', () => {
  expect(schema('v2/ThreadTurnsListParams').required).toContain('threadId');
  expect(schema('v2/ThreadItemsListParams').properties).toHaveProperty('cursor');
  expect(schema('v2/ThreadResumeParams').required).toContain('threadId');
  expect(schema('CommandExecutionRequestApprovalResponse').required).toContain('decision');
  expect(schema('FileChangeRequestApprovalResponse').required).toContain('decision');
  expect(lock.experimentalApi).toBe(false);
});
it('adapts only interactions present in the pinned stable schema', () => {
  const requests = schema('ServerRequest');
  const methods = requests.oneOf.map((request: any) => request.properties.method.enum[0]);
  expect(methods).toEqual(expect.arrayContaining([
    'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval',
  ]));
  const modes = requests.definitions.McpServerElicitationRequestParams.oneOf.map((variant: any) => variant.properties.mode.enum[0]);
  expect(modes).toEqual(['form', 'openai/form', 'openaiForm', 'url']);
  expect(modes).not.toContain('openai/userVerification');
  expect(schema('ToolRequestUserInputResponse').required).toContain('answers');
  expect(schema('PermissionsRequestApprovalResponse').required).toEqual(['permissions']);
  expect(schema('PermissionsRequestApprovalResponse').properties.scope.default).toBe('turn');
});
