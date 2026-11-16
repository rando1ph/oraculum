import { isAbsolute } from 'node:path';
import { parseContract, type Interaction, type InteractionAnswer } from '../../../../packages/gateway-protocol/src/index';
import { elicitationFields, validElicitationContent } from '../../../../packages/shared/elicitation';
import type { WorkspaceAction } from '../contracts/workspace';
import { normalizeEndpoint } from './endpoint';
import { fileChangeContextMatches, type FileChangeContext } from './file-change-context';

const MAX_BYTES = 120 * 1024; // Reserve room for main-generated Gateway metadata.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
type ObjectValue = Record<string, unknown>;
type AnswerAction = Extract<WorkspaceAction, { type: 'answer' }>;
function invalid(): never { throw new Error('WORKSPACE_ACTION_INVALID'); }
function invalidAnswer(): never { throw new Error('INTERACTION_RESPONSE_INVALID'); }
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);

/** IPC normally structured-clones its input. Still reject accessors, prototypes,
 * cycles and oversized trees before validation, and return a detached value. */
function jsonCopy(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 4096 || depth > 12) invalid();
    if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'string') bytes += Buffer.byteLength(JSON.stringify(item));
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid();
      bytes += 32;
    } else if (typeof item === 'object') {
      if (seen.has(item)) invalid();
      seen.add(item);
      const array = Array.isArray(item);
      if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) invalid();
      const keys = Reflect.ownKeys(item);
      if (keys.length > 4096) invalid();
      for (const key of keys) {
        if (array && key === 'length') continue;
        // Native form/question IDs may legitimately be '__proto__'. JSON.parse
        // preserves an own data key without assigning through Object.prototype.
        if (typeof key !== 'string') invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        if (array && !/^(?:0|[1-9][0-9]*)$/.test(key)) invalid();
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        visit(descriptor.value, depth + 1);
      }
      if (array && keys.length !== item.length + 1) invalid();
      bytes += 2;
      seen.delete(item);
    } else invalid();
    if (bytes > MAX_BYTES) invalid();
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_BYTES) invalid();
  return JSON.parse(serialized);
}

function keys(value: ObjectValue, required: string[], optional: string[] = []): void {
  const allowed = new Set(['type', ...required, ...optional]);
  if (Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
}
function string(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) invalid();
}
function identifier(value: unknown): void {
  string(value, 256);
  if (CONTROL.test(value) || /[/\\?#%]/.test(value) || value === '.' || value === '..') invalid();
}
function uuid(value: unknown): void { if (typeof value !== 'string' || !UUID.test(value)) invalid(); }
function optional(value: ObjectValue, key: string, check: (input: unknown) => void): void {
  if (Object.hasOwn(value, key)) check(value[key]);
}
function boolean(value: unknown): void { if (typeof value !== 'boolean') invalid(); }
function cursor(value: unknown): void { string(value, 4096); if (CONTROL.test(value)) invalid(); }
function relativePath(value: unknown, empty: boolean): void {
  string(value, 1024, empty);
  if (value === '' && empty) return;
  const parts = value.split('/');
  if (parts.length > 12 || parts.some(part => !part || part.length > 180 || part.startsWith('.')
    || part.trim() !== part || part !== part.normalize('NFC') || /[\\:%\p{Cc}\p{Cf}]/u.test(part))) invalid();
}
function settings(value: ObjectValue): void {
  optional(value, 'model', input => { string(input, 200); if (CONTROL.test(input)) invalid(); });
  optional(value, 'effort', input => { if (typeof input !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input)) invalid(); });
  optional(value, 'permissionPreset', input => { if (typeof input !== 'string' || !['read-only', 'auto', 'full-access'].includes(input)) invalid(); });
}

export function parseWorkspaceAction(value: unknown): WorkspaceAction {
  const action = jsonCopy(value);
  if (!object(action) || typeof action.type !== 'string') invalid();
  switch (action.type) {
    case 'connect':
      keys(action, ['endpoint']); string(action.endpoint, 2048); normalizeEndpoint(action.endpoint); break;
    case 'pair':
      keys(action, ['code', 'label']); string(action.code, 128); string(action.label, 80);
      if (!/^[A-Z2-7]{32}$/.test(action.code.replace(/[- ]/g, '').toUpperCase()) || !action.label.trim() || CONTROL.test(action.label)) invalid();
      break;
    case 'disconnect': case 'reconnect': case 'refresh': case 'reconcile': case 'logout':
    case 'resumeThread': case 'historyMore': case 'interrupt': case 'upload':
      keys(action, []); break;
    case 'directories':
      keys(action, ['rootId'], ['path', 'cursor']); identifier(action.rootId);
      optional(action, 'path', input => relativePath(input, true)); optional(action, 'cursor', cursor); break;
    case 'registerProject':
      keys(action, ['rootId', 'path']); identifier(action.rootId); relativePath(action.path, false); break;
    case 'unregisterProject':
      keys(action, ['projectId', 'confirm']); uuid(action.projectId); if (action.confirm !== true) invalid(); break;
    case 'selectProject': keys(action, ['projectId']); uuid(action.projectId); break;
    case 'threads':
      keys(action, [], ['search', 'archived', 'more']); optional(action, 'search', input => string(input, 256, true));
      optional(action, 'archived', boolean); optional(action, 'more', boolean); break;
    case 'selectThread': keys(action, ['threadId']); identifier(action.threadId); break;
    case 'startThread': keys(action, [], ['model', 'effort', 'permissionPreset']); settings(action); break;
    case 'send':
      keys(action, ['text'], ['model', 'effort', 'permissionPreset']); string(action.text, 100_000); settings(action); break;
    case 'steer': keys(action, ['text']); string(action.text, 100_000); break;
    case 'threadMutation':
      if (action.action === 'name') {
        keys(action, ['action', 'name']); string(action.name, 200);
        if (!action.name.trim() || CONTROL.test(action.name)) invalid();
      } else if (action.action === 'revert') {
        keys(action, ['action', 'beforeTurnId']); identifier(action.beforeTurnId);
      } else if (action.action === 'delete') {
        keys(action, ['action', 'confirm']); if (action.confirm !== true) invalid();
      } else if (typeof action.action === 'string' && ['archive', 'unarchive', 'fork', 'compact'].includes(action.action)) keys(action, ['action']);
      else invalid();
      break;
    case 'answer':
      keys(action, ['interactionId', 'generation', 'epoch', 'response'], ['contextDigest']); uuid(action.interactionId); uuid(action.epoch);
      optional(action, 'contextDigest', input => { if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) invalid(); });
      if (!Number.isSafeInteger(action.generation) || Number(action.generation) < 1) invalid();
      try { parseContract('InteractionAnswer', action.response); } catch { invalid(); }
      break;
    case 'details':
      keys(action, ['turnId', 'itemId'], ['cursor']); identifier(action.turnId); identifier(action.itemId); optional(action, 'cursor', cursor); break;
    case 'files':
      keys(action, [], ['path', 'more']); optional(action, 'path', input => relativePath(input, true)); optional(action, 'more', boolean); break;
    case 'previewFile': case 'downloadFile': keys(action, ['path']); relativePath(action.path, false); break;
    case 'removeAttachment': keys(action, ['attachmentId']); uuid(action.attachmentId); break;
    case 'inspector':
      keys(action, ['section']); if (action.section !== 'usage' && action.section !== 'extensions') invalid(); break;
    default: invalid();
  }
  return action as WorkspaceAction;
}

const within = (value: ObjectValue, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const boundedText = (value: unknown, max = 16_000): value is string => typeof value === 'string' && value.length <= max;
function commandContext(request: ObjectValue): boolean {
  if (request.kind !== undefined && request.kind !== 'command') return false;
  if (request.truncated === true || request.detailsAvailable === true) return false;
  const network = request.networkApprovalContext;
  if (network != null && (!object(network) || !within(network, ['host', 'protocol'])
    || !boundedText(network.host, 4096) || !network.host || /\s/.test(network.host) || CONTROL.test(network.host)
    || typeof network.protocol !== 'string' || !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol))) return false;
  return (boundedText(request.command, 64_000) && request.command.trim().length > 0) || object(network);
}
function permissions(value: unknown): boolean {
  if (!object(value) || !within(value, ['network', 'fileSystem'])) return false;
  if (value.network != null && (!object(value.network) || !within(value.network, ['enabled'])
    || !(value.network.enabled === null || typeof value.network.enabled === 'boolean'))) return false;
  if (value.fileSystem != null) {
    if (!object(value.fileSystem) || !within(value.fileSystem, ['read', 'write'])) return false;
    for (const key of ['read', 'write']) {
      const paths = value.fileSystem[key];
      if (paths != null && (!Array.isArray(paths) || paths.length > 64 || !paths.every(path => boundedText(path, 4096)
        && path.length > 0 && !CONTROL.test(path) && isAbsolute(path)))) return false;
    }
  }
  return true;
}

/** Main must additionally bind current to its selected project/thread and live
 * connection. This helper cannot turn a cached interaction into authority. */
export function validateInteractionAnswer(current: Interaction, input: AnswerAction, context?: FileChangeContext): InteractionAnswer {
  const parsed = parseWorkspaceAction(input);
  if (parsed.type !== 'answer') invalidAnswer();
  if (current.status !== 'pending' || current.interactionId !== parsed.interactionId
    || current.epoch !== parsed.epoch || current.generation !== parsed.generation) throw new Error('INTERACTION_STALE');
  const answer = parsed.response, request = current.request;
  if (!object(request) || request.threadId !== current.threadId
    || (current.turnId !== null && request.turnId !== current.turnId)) invalidAnswer();
  if (['command', 'fileChange', 'permissions'].includes(current.kind)) {
    if (answer.type !== 'approval') invalidAnswer();
    if (request.availableDecisions !== undefined && (!Array.isArray(request.availableDecisions)
      || !request.availableDecisions.includes(answer.decision))) invalidAnswer();
    if (answer.decision === 'accept') {
      if (current.kind === 'fileChange' && !fileChangeContextMatches(context, current, parsed.contextDigest)) throw new Error('FILE_CHANGE_ACCEPT_UNAVAILABLE');
      if (current.kind === 'command' && !commandContext(request)) invalidAnswer();
      if (current.kind === 'permissions' && !permissions(request.permissions)) invalidAnswer();
    }
    return answer;
  }
  if (current.kind === 'input') {
    if (answer.type !== 'input' || !object(answer.answers) || Object.keys(answer.answers).length > 20
      || typeof request.isBlocking !== 'boolean' || !Array.isArray(request.questions) || request.questions.length > 20) invalidAnswer();
    const questions = new Map<string, ObjectValue>();
    for (const question of request.questions) {
      if (!object(question) || !boundedText(question.id, 4096) || !question.id || questions.has(question.id)
        || !boundedText(question.header) || !boundedText(question.question)
        || (question.isOther !== undefined && typeof question.isOther !== 'boolean')
        || (question.isSecret !== undefined && typeof question.isSecret !== 'boolean')
        || (question.options != null && (!Array.isArray(question.options) || question.options.length > 100
          || !question.options.every(option => object(option) && boundedText(option.label) && boundedText(option.description))))) invalidAnswer();
      questions.set(question.id, question);
    }
    for (const [id, values] of Object.entries(answer.answers)) {
      const question = questions.get(id);
      if (!question || !Array.isArray(values) || values.length > 20 || !values.every(value => boundedText(value)
        && (!Array.isArray(question.options) || !question.options.length || question.isOther === true
          || question.options.some(option => object(option) && option.label === value)))) invalidAnswer();
    }
    return answer;
  }
  if (current.kind === 'elicitation') {
    if (answer.type !== 'elicitation' || typeof request.mode !== 'string' || !['form', 'openai/form', 'openaiForm', 'url'].includes(request.mode)) invalidAnswer();
    if (request.mode === 'url') {
      try {
        if (typeof request.url !== 'string') invalidAnswer();
        const url = new URL(request.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalidAnswer();
      } catch { invalidAnswer(); }
    }
    if (request.mode !== 'url' && elicitationFields(request.requestedSchema) === null) invalidAnswer();
    const content = answer.content ?? null;
    if (answer.action !== 'accept' || request.mode === 'url') { if (content !== null) invalidAnswer(); }
    else if (!validElicitationContent(request.requestedSchema, content)) invalidAnswer();
    return answer;
  }
  return invalidAnswer();
}
