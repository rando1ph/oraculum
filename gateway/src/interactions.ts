import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { elicitationFields, validElicitationContent } from '../../packages/shared/elicitation';
import { CodexError, record, type CodexAdapter, type JsonObject, type NativeRequest, type RpcId } from './codex';

export type InteractionResponse = { type: 'approval'; decision: 'accept' | 'decline' | 'cancel' } |
  { type: 'input'; answers: Record<string, string[]> } |
  { type: 'elicitation'; action: 'accept' | 'decline' | 'cancel'; content?: JsonObject | null };
export type Interaction = {
  interactionId: string; projectId: string; threadId: string; turnId: string | null; epoch: string; generation: number;
  kind: 'command' | 'fileChange' | 'permissions' | 'input' | 'elicitation'; status: 'pending' | 'submitted' | 'unknown' | 'resolved'; request: JsonObject;
};
type Pending = { public: Interaction; native: NativeRequest; answeringDeviceId?: string };
export class InteractionError extends Error {
  constructor(readonly code: 'INTERACTION_STALE' | 'INTERACTION_FORBIDDEN' | 'INTERACTION_ALREADY_RESOLVED' | 'INTERACTION_RESPONSE_INVALID', message: string) { super(message); }
}
const text = (value: unknown, max = 16_000): value is string => typeof value === 'string' && value.length <= max;
const identifier = (value: unknown): value is string => text(value, 4096) && value.length > 0 && !/[\x00-\x1f]/.test(value);
const only = (value: JsonObject, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const decision = (value: unknown): value is 'accept' | 'decline' | 'cancel' => ['accept', 'decline', 'cancel'].includes(String(value));
const nativeKey = (id: RpcId) => `${typeof id}:${JSON.stringify(id)}`;

function validPermissions(value: unknown): value is JsonObject {
  if (!record(value) || !only(value, ['network', 'fileSystem'])) return false;
  if (value.network != null && (!record(value.network) || !only(value.network, ['enabled']) || !(value.network.enabled === null || typeof value.network.enabled === 'boolean'))) return false;
  if (value.fileSystem != null) {
    // Structured/glob permissions are a separate native capability. Do not silently weaken unknown constraints.
    if (!record(value.fileSystem) || !only(value.fileSystem, ['read', 'write'])) return false;
    for (const key of ['read', 'write']) {
      const paths = value.fileSystem[key];
      if (paths != null && (!Array.isArray(paths) || paths.length > 64 || !paths.every(path => identifier(path) && isAbsolute(path)))) return false;
    }
  }
  return true;
}

function classify(request: NativeRequest): Interaction['kind'] | null {
  const p = request.params;
  if (!identifier(p.threadId) || Buffer.byteLength(JSON.stringify(p)) > 128 * 1024) return null;
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      if (!identifier(p.turnId) || !identifier(p.itemId) || (p.command != null && !text(p.command, 64_000)) || (p.cwd != null && !identifier(p.cwd))) return null;
      if (p.availableDecisions !== undefined && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.every(value => typeof value === 'string' || record(value)))) return null;
      return 'command';
    case 'item/fileChange/requestApproval': return identifier(p.turnId) && identifier(p.itemId) ? 'fileChange' : null;
    case 'item/permissions/requestApproval': return identifier(p.turnId) && identifier(p.itemId) && identifier(p.cwd) && validPermissions(p.permissions) ? 'permissions' : null;
    case 'item/tool/requestUserInput': {
      if (!identifier(p.turnId) || !identifier(p.itemId) || typeof p.isBlocking !== 'boolean' || !Array.isArray(p.questions) || p.questions.length > 20) return null;
      const ids = new Set();
      for (const question of p.questions) {
        if (!record(question) || !identifier(question.id) || ids.has(question.id) || !text(question.header) || !text(question.question) ||
          (question.isOther !== undefined && typeof question.isOther !== 'boolean') || (question.isSecret !== undefined && typeof question.isSecret !== 'boolean') ||
          (question.options != null && (!Array.isArray(question.options) || question.options.length > 100 ||
            !question.options.every(option => record(option) && text(option.label) && text(option.description))))) return null;
        ids.add(question.id);
      }
      return 'input';
    }
    case 'mcpServer/elicitation/request': {
      if (!(p.turnId === null || identifier(p.turnId)) || !identifier(p.serverName) || !text(p.message)) return null;
      if (['form', 'openai/form', 'openaiForm'].includes(String(p.mode))) return elicitationFields(p.requestedSchema) ? 'elicitation' : null;
      if (p.mode !== 'url' || !text(p.url) || !identifier(p.elicitationId)) return null;
      try { const url = new URL(p.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? 'elicitation' : null; }
      catch { return null; }
    }
    default: return null;
  }
}

function response(request: NativeRequest, answer: InteractionResponse): JsonObject {
  const invalid = () => { throw new InteractionError('INTERACTION_RESPONSE_INVALID', 'Response does not match the native request'); };
  if (!record(answer)) return invalid();
  const p = request.params, kind = classify(request);
  if (kind === 'command' || kind === 'fileChange' || kind === 'permissions') {
    if (answer.type !== 'approval' || !only(answer, ['type', 'decision']) || !decision(answer.decision)) return invalid();
    if (Array.isArray(p.availableDecisions) && !p.availableDecisions.includes(answer.decision)) return invalid();
    if (kind === 'permissions') {
      const wanted = p.permissions as JsonObject;
      return { permissions: answer.decision === 'accept' ? { ...(wanted.network == null ? {} : { network: wanted.network }),
        ...(wanted.fileSystem == null ? {} : { fileSystem: wanted.fileSystem }) } : {}, scope: 'turn' };
    }
    return { decision: answer.decision };
  }
  if (kind === 'input') {
    if (answer.type !== 'input' || !only(answer, ['type', 'answers']) || !record(answer.answers) || Object.keys(answer.answers).length > 20) return invalid();
    const answers: Record<string, { answers: string[] }> = Object.create(null);
    const questions = p.questions as JsonObject[];
    for (const [questionId, values] of Object.entries(answer.answers)) {
      const question = questions.find(question => question.id === questionId);
      if (!question || !Array.isArray(values) || values.length > 20 || !values.every(value => text(value) &&
        (!Array.isArray(question.options) || !question.options.length || question.isOther === true || question.options.some(option => record(option) && option.label === value)))) return invalid();
      answers[questionId] = { answers: values };
    }
    if (Buffer.byteLength(JSON.stringify(answers)) > 128 * 1024) return invalid();
    return { answers };
  }
  if (kind === 'elicitation') {
    if (answer.type !== 'elicitation' || !only(answer, ['type', 'action', 'content']) || !decision(answer.action)) return invalid();
    const content = answer.content ?? null;
    if (answer.action !== 'accept' || p.mode === 'url') { if (content !== null) return invalid(); }
    else if (!validElicitationContent(p.requestedSchema, content)) return invalid();
    if (Buffer.byteLength(JSON.stringify(content)) > 128 * 1024) return invalid();
    return { action: answer.action, content, _meta: null };
  }
  return invalid();
}

/** Native approval facts stay in the App Server. This is only a current-epoch single-response gate. */
export class Interactions extends EventEmitter {
  private entries = new Map<string, Pending>();
  private nativeIds = new Map<string, string>();
  private generation = 0;
  constructor(private readonly codex: Pick<CodexAdapter, 'respondRequest' | 'rejectRequest'>, private readonly options: { epoch: string; maxPending?: number }) { super(); }

  async receive(request: NativeRequest, projectId: string | null): Promise<Interaction | null> {
    const kind = classify(request);
    if (!kind || !projectId || this.entries.size >= (this.options.maxPending ?? 128)) {
      await this.codex.rejectRequest(request.id, !projectId ? 'Native request is outside registered project authorization' : 'Native request shape or capability is unsupported');
      return null;
    }
    const key = nativeKey(request.id), existingId = this.nativeIds.get(key);
    if (existingId) {
      const existing = this.entries.get(existingId)!;
      if (existing.native.method === request.method && JSON.stringify(existing.native.params) === JSON.stringify(request.params)) return structuredClone(existing.public);
      existing.public.status = 'unknown'; this.emit('changed', structuredClone(existing.public));
      await this.codex.rejectRequest(request.id, 'Native request identifier was reused inconsistently'); return null;
    }
    const interaction: Interaction = { interactionId: randomUUID(), projectId, threadId: request.params.threadId as string,
      turnId: typeof request.params.turnId === 'string' ? request.params.turnId : null, epoch: this.options.epoch, generation: ++this.generation,
      kind, status: 'pending', request: structuredClone(request.params) };
    this.entries.set(interaction.interactionId, { public: interaction, native: structuredClone(request) });
    this.nativeIds.set(key, interaction.interactionId); this.emit('changed', structuredClone(interaction));
    return structuredClone(interaction);
  }
  list(projectId: string, threadId?: string): Interaction[] {
    return [...this.entries.values()].filter(entry => entry.public.projectId === projectId && (!threadId || entry.public.threadId === threadId))
      .map(entry => structuredClone(entry.public));
  }
  get(interactionId: string): Interaction | undefined {
    const interaction = this.entries.get(interactionId)?.public; return interaction && structuredClone(interaction);
  }
  async respond(input: { interactionId: string; epoch: string; generation: number; response: InteractionResponse }, context: { deviceId: string; projectId: string; threadId?: string }): Promise<Interaction> {
    const entry = this.entries.get(input.interactionId);
    if (!entry || input.epoch !== this.options.epoch || input.generation !== entry.public.generation) throw new InteractionError('INTERACTION_STALE', 'Native interaction belongs to an expired generation');
    if (context.projectId !== entry.public.projectId || (context.threadId !== undefined && context.threadId !== entry.public.threadId)) throw new InteractionError('INTERACTION_FORBIDDEN', 'Interaction is outside the authorized project or thread');
    if (entry.public.status !== 'pending') throw new InteractionError('INTERACTION_ALREADY_RESOLVED', 'Native interaction already has a response or is resolved');
    const nativeResponse = response(entry.native, input.response);
    // CAS before the first await: another device cannot claim this native request.
    entry.public.status = 'submitted'; entry.answeringDeviceId = context.deviceId; this.emit('changed', structuredClone(entry.public));
    try { await this.codex.respondRequest(entry.native.id, nativeResponse); }
    catch (error) {
      if ((entry.public.status as Interaction['status']) !== 'resolved') entry.public.status = 'unknown';
      this.emit('changed', structuredClone(entry.public));
      throw new CodexError('NATIVE_UNAVAILABLE', 'Native interaction response delivery is unknown; do not resubmit', 'unknown');
    }
    return structuredClone(entry.public);
  }
  resolve(requestId: RpcId, threadId: string) {
    const interactionId = this.nativeIds.get(nativeKey(requestId)), entry = interactionId && this.entries.get(interactionId);
    if (!entry || entry.public.threadId !== threadId) return;
    entry.public.status = 'resolved'; this.emit('changed', structuredClone(entry.public));
    // Completed cards are native history concerns. Keep only active-response coordination here.
    this.entries.delete(entry.public.interactionId); this.nativeIds.delete(nativeKey(requestId));
  }
  clear() {
    for (const entry of this.entries.values()) { entry.public.status = 'unknown'; this.emit('changed', structuredClone(entry.public)); }
    this.entries.clear(); this.nativeIds.clear();
  }
}
