import type { Approval, WireMessage } from '../../packages/shared/protocol';
import { isRecord, validElicitationContent } from '../../packages/shared/elicitation';
import type { ToolRequestUserInputResponse } from '../../.local/codex-protocol/v2/ToolRequestUserInputResponse';
import type { McpServerElicitationRequestResponse } from '../../.local/codex-protocol/v2/McpServerElicitationRequestResponse';
import type { PermissionsRequestApprovalResponse } from '../../.local/codex-protocol/v2/PermissionsRequestApprovalResponse';

const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === 'string';
const decision = (value: unknown) => typeof value === 'string' && ['accept', 'decline', 'cancel'].includes(value);

// Native requests are trusted protocol input, but still check the shape before
// forwarding to renderers. Identity and project ownership are checked by service.
export function supportedRequest(message: WireMessage): message is Approval {
  const p = message.params;
  if (!p || !text(p.threadId)) return false;
  switch (message.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval': return true;
    case 'item/tool/requestUserInput':
      return text(p.turnId) && text(p.itemId) && typeof p.isBlocking === 'boolean' && Array.isArray(p.questions) &&
        new Set(p.questions.map(q => isRecord(q) ? q.id : undefined)).size === p.questions.length &&
        p.questions.every(q => isRecord(q) && text(q.id) && text(q.header) && text(q.question) &&
          (q.isOther === undefined || typeof q.isOther === 'boolean') && (q.isSecret === undefined || typeof q.isSecret === 'boolean') &&
          (q.options == null || (Array.isArray(q.options) && q.options.every(o => isRecord(o) && text(o.label) && text(o.description)))));
    case 'item/permissions/requestApproval':
      return text(p.turnId) && text(p.itemId) && text(p.cwd) && isRecord(p.permissions) &&
        (p.permissions.network == null || (isRecord(p.permissions.network) && (p.permissions.network.enabled == null || typeof p.permissions.network.enabled === 'boolean'))) &&
        (p.permissions.fileSystem == null || isRecord(p.permissions.fileSystem));
    case 'mcpServer/elicitation/request':
      if (!(p.turnId === null || text(p.turnId)) || !text(p.serverName) || !text(p.message)) return false;
      if (['form', 'openai/form', 'openaiForm'].includes(String(p.mode))) return Object.hasOwn(p, 'requestedSchema');
      if (p.mode !== 'url' || !text(p.url) || !text(p.elicitationId)) return false;
      try { const url = new URL(p.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    default: return false;
  }
}

export function nativeResponse(request: Approval, params: Record<string, unknown>): unknown {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      if (!decision(params.decision)) throw new Error('Unsupported decision');
      return { decision: params.decision };
    case 'item/permissions/requestApproval': {
      if (!decision(params.decision)) throw new Error('Unsupported decision');
      // Only the requested permissions can be granted, and only for this turn.
      // Renderer-supplied grants or session scope are never forwarded.
      const wanted = request.params.permissions;
      return { permissions: params.decision === 'accept' ? {
        ...(wanted.network ? { network: wanted.network } : {}),
        ...(wanted.fileSystem ? { fileSystem: wanted.fileSystem } : {}),
      } : {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse;
    }
    case 'item/tool/requestUserInput': {
      const result = params.result;
      if (!isRecord(result) || !only(result, ['answers']) || !isRecord(result.answers)) throw new Error('Invalid user input response');
      const answers: ToolRequestUserInputResponse['answers'] = Object.create(null) as ToolRequestUserInputResponse['answers'];
      for (const [id, answer] of Object.entries(result.answers)) {
        const question = request.params.questions.find(q => q.id === id);
        if (!question || !isRecord(answer) || !only(answer, ['answers']) || !Array.isArray(answer.answers) ||
          !answer.answers.every(value => text(value) && value.length <= 16000 &&
            (!question.options?.length || question.isOther || question.options.some(option => option.label === value)))) throw new Error('Invalid answer for native question');
        answers[id] = { answers: answer.answers as string[] };
      }
      return { answers } satisfies ToolRequestUserInputResponse;
    }
    case 'mcpServer/elicitation/request': {
      const result = params.result;
      if (!isRecord(result) || !only(result, ['action', 'content']) || !decision(result.action)) throw new Error('Invalid MCP elicitation response');
      const p = request.params;
      const content = result.content ?? null;
      if (result.action !== 'accept' || p.mode === 'url') {
        if (content !== null) throw new Error('MCP decline, cancel and URL responses cannot include form content');
      } else if (!validElicitationContent(p.requestedSchema, content)) throw new Error('MCP form response does not match the supported requested schema');
      return { action: result.action as McpServerElicitationRequestResponse['action'], content, _meta: null } satisfies McpServerElicitationRequestResponse;
    }
  }
}

export function responseNeedsDirectory(request: Approval, params: Record<string, unknown>): boolean {
  if (request.method === 'mcpServer/elicitation/request') return isRecord(params.result) && params.result.action === 'accept';
  if (request.method === 'item/tool/requestUserInput') return isRecord(params.result) && isRecord(params.result.answers) && Object.keys(params.result.answers).length > 0;
  return params.decision === 'accept';
}
