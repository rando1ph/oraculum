import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export type RpcId = string | number;
export type PermissionPreset = 'read-only' | 'auto' | 'full-access';
export type NativeItem = JsonObject & { id: string; type: string };
export type NativeTurn = JsonObject & { id: string; status: 'inProgress' | 'completed' | 'interrupted' | 'failed'; items: NativeItem[] };
export type NativeThread = JsonObject & { id: string; cwd: string; preview: string; turns: NativeTurn[]; status: JsonObject };
export type NativePage<T> = { data: T[]; nextCursor: string | null; backwardsCursor?: string | null };
export type NativeThreadResult = JsonObject & { thread: NativeThread };
export type NativeModel = JsonObject & { id: string; model: string; displayName: string; supportedReasoningEfforts: { reasoningEffort: string }[] };
export type NativeRequest = { id: RpcId; method: string; params: JsonObject };
export type NativeNotification = { method: string; params: JsonObject };
export type NativeInput = { type: 'text'; text: string } | { type: 'localImage'; path: string };
export type NativeFailureCode = 'NATIVE_UNAVAILABLE' | 'NATIVE_TIMEOUT' | 'NATIVE_PROTOCOL' | 'NATIVE_TOO_LARGE' |
  'NATIVE_BUSY' | 'NATIVE_REJECTED' | 'NATIVE_UNSUPPORTED' | 'NATIVE_EXPERIMENTAL' | 'NATIVE_PAGINATION_UNSUPPORTED' | 'INVALID_NATIVE_ARGUMENT';

/** Messages are safe summaries: raw provider errors, stderr, prompts and config are never logged. */
export class CodexError extends Error {
  constructor(readonly code: NativeFailureCode, message: string, readonly outcome: 'rejected' | 'unknown', readonly nativeCode?: number) {
    super(message); this.name = 'CodexError';
  }
}
export const record = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\x00-\x1f]/.test(v);
const rpcId = (v: unknown): v is RpcId => identifier(v) || (typeof v === 'number' && Number.isSafeInteger(v));
const invalid = () => new CodexError('INVALID_NATIVE_ARGUMENT', 'Invalid supported Codex operation arguments', 'rejected');
const id = (v: unknown): string => { if (!identifier(v)) throw invalid(); return v; };
const limit = (v: number | undefined, fallback: number, max = 100) => {
  if (v === undefined) return fallback;
  if (!Number.isSafeInteger(v) || v < 1 || v > max) throw invalid();
  return v;
};
const cursor = (v?: string | null) => v == null ? undefined : id(v);

// Deliberately finite. Neither HTTP nor WS can turn this adapter into arbitrary RPC.
const methods = new Set(['initialize', 'model/list', 'thread/list', 'thread/read', 'thread/start', 'thread/resume',
  'turn/start', 'turn/interrupt', 'thread/turns/list', 'thread/items/list', 'skills/list', 'mcpServerStatus/list', 'app/installed', 'plugin/installed']);
const writes = new Set(['thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);
const notifications = new Set(['thread/started', 'thread/status/changed', 'thread/name/updated', 'thread/archived', 'thread/unarchived',
  'thread/closed', 'thread/deleted', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed', 'turn/diff/updated', 'turn/plan/updated',
  'item/started', 'item/completed', 'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta', 'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta', 'item/mcpToolCall/progress', 'serverRequest/resolved', 'error']);

function nativeError(method: string, code: number, message: string): CodexError {
  // Do not classify generic "unsupported", timeout, authorization or provider failures as pagination fallback.
  if (['thread/turns/list','thread/items/list'].includes(method) && code===-32601 &&
    (message==='paginated_threads is not supported yet'||message===`${method} is not supported yet`)) {
    return new CodexError('NATIVE_PAGINATION_UNSUPPORTED','This native store has not implemented paginated history','rejected',code);
  }
  if (code === -32601) return new CodexError('NATIVE_UNSUPPORTED', `Codex does not support ${method}`, 'rejected', code);
  if (code === -32602 && /(?:requires|require|must enable|enable).*experimentalApi|experimentalApi.*(?:required|disabled|not enabled)/i.test(message)) {
    return new CodexError('NATIVE_EXPERIMENTAL', `Codex requires experimental API for ${method}`, 'rejected', code);
  }
  if (['thread/turns/list', 'thread/items/list'].includes(method) &&
    /(?:thread|session|history|storage|backend).*(?:does not support|doesn't support|not supported).*(?:pagination|paginated)|(?:pagination|paginated history).*(?:not supported|unsupported|unavailable).*(?:thread|session|storage|backend)|(?:requires|only supported (?:for|on)).*(?:paginated|pagination)/i.test(message)) {
    return new CodexError('NATIVE_PAGINATION_UNSUPPORTED', 'This native history store does not support pagination', 'rejected', code);
  }
  // JSON-RPC validation/method errors are explicit pre-execution refusals. An internal/provider failure can occur after a write.
  return new CodexError('NATIVE_REJECTED', `Codex ${method} returned error ${code}`, !writes.has(method) || [-32600, -32601, -32602].includes(code) ? 'rejected' : 'unknown', code);
}

function validate(method: string, value: unknown): asserts value is JsonObject {
  const bad = () => { throw new CodexError('NATIVE_PROTOCOL', `Incompatible Codex ${method} response`, writes.has(method) ? 'unknown' : 'rejected'); };
  const item = (v: unknown) => { if (!record(v) || !identifier(v.id) || !identifier(v.type)) bad(); };
  const turn = (v: unknown) => {
    if (!record(v) || !identifier(v.id) || !['inProgress', 'completed', 'interrupted', 'failed'].includes(String(v.status)) || !Array.isArray(v.items)) return bad();
    v.items.forEach(item);
  };
  const thread = (v: unknown) => {
    if (!record(v) || !identifier(v.id) || !identifier(v.cwd) || typeof v.preview !== 'string' || !record(v.status) ||
      !['notLoaded', 'idle', 'systemError', 'active'].includes(String(v.status.type)) || !Array.isArray(v.turns)) return bad();
    if (v.status.type === 'active' && (!Array.isArray(v.status.activeFlags) || !v.status.activeFlags.every(flag => typeof flag === 'string'))) bad();
    v.turns.forEach(turn);
  };
  if (!record(value)) return bad();
  const page = (check: (v: unknown) => void) => {
    if (!Array.isArray(value.data) || !(value.nextCursor === null || identifier(value.nextCursor))) return bad();
    value.data.forEach(check);
  };
  if (method === 'initialize' && !identifier(value.userAgent)) bad();
  if (method === 'model/list') page(v => {
    if (!record(v) || !identifier(v.id) || !identifier(v.model) || !identifier(v.displayName) || !Array.isArray(v.supportedReasoningEfforts) ||
      !v.supportedReasoningEfforts.every(e => record(e) && identifier(e.reasoningEffort))) bad();
  });
  if (method === 'thread/list') page(thread);
  if (['thread/read', 'thread/start', 'thread/resume'].includes(method)) thread(value.thread);
  if (['thread/start', 'thread/resume'].includes(method) &&
    (!(typeof value.approvalPolicy === 'string' || record(value.approvalPolicy)) || !record(value.sandbox) || !identifier(value.sandbox.type))) bad();
  if (method === 'turn/start') turn(value.turn);
  if (method === 'thread/turns/list') page(turn);
  if (method === 'thread/items/list') page(v => { if (!record(v) || !identifier(v.turnId)) return bad(); item(v.item); });
  if (method === 'skills/list' && (!Array.isArray(value.data) || !value.data.every(entry => record(entry) && identifier(entry.cwd) && Array.isArray(entry.skills) && Array.isArray(entry.errors)))) bad();
  if (method === 'mcpServerStatus/list') page(entry => { if (!record(entry) || !identifier(entry.name) || !record(entry.tools) || !Array.isArray(entry.resources)) bad(); });
  if (method === 'app/installed' && (!Array.isArray(value.apps) || !value.apps.every(record))) bad();
  if (method === 'plugin/installed' && (!Array.isArray(value.marketplaces) || !Array.isArray(value.marketplaceLoadErrors) ||
    !value.marketplaces.every(entry => record(entry) && identifier(entry.name) && Array.isArray(entry.plugins)))) bad();
}

function permissions(preset: PermissionPreset | undefined, turn: boolean): JsonObject {
  if (preset === undefined) return {};
  if (!['read-only', 'auto', 'full-access'].includes(preset)) throw invalid();
  const approvalPolicy = preset === 'full-access' ? 'never' : 'on-request';
  if (turn) return { approvalPolicy, sandboxPolicy: preset === 'full-access' ? { type: 'dangerFullAccess' }
    : preset === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  return { approvalPolicy, sandbox: preset === 'full-access' ? 'danger-full-access' : preset === 'auto' ? 'workspace-write' : 'read-only',
    ...(preset === 'auto' ? { config: { sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } } } : {}) };
}

export interface CodexAdapterOptions {
  cwd: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  maxFrameBytes?: number;
  maxPending?: number;
}
type Pending = { method: string; resolve: (v: JsonObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; expired?: boolean };

/** One object owns exactly one native process. Restart requires a new object and a new Gateway epoch. */
export class CodexAdapter extends EventEmitter {
  readonly instanceId = randomUUID();
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<RpcId, Pending>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private started = false;
  private initialized = false;
  private closing?: Promise<void>;
  private exited?: Promise<void>;
  private exitResolve?: () => void;
  alive = false;
  constructor(private readonly options: CodexAdapterOptions) { super(); }

  async start(): Promise<JsonObject> {
    if (this.started) throw new CodexError('NATIVE_UNAVAILABLE', 'A Codex adapter cannot be started twice', 'rejected');
    this.started = true;
    this.exited = new Promise(resolve => { this.exitResolve = resolve; });
    this.child = spawn(this.options.executable ?? 'codex', ['app-server', '--listen', 'stdio://'], {
      cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.alive = true;
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', (chunk: Buffer) => this.receiveChunk(chunk));
    this.child.once('exit', () => { this.exitResolve?.(); this.fail('NATIVE_UNAVAILABLE', 'Codex App Server exited'); });
    this.child.once('error', () => { if (!this.child?.pid) this.exitResolve?.(); this.fail('NATIVE_UNAVAILABLE', 'Cannot run Codex App Server'); });
    this.child.stdin.on('error', () => { this.fail('NATIVE_UNAVAILABLE', 'Codex App Server input failed'); this.child?.kill(); });
    try {
      const result = await this.rpc('initialize', { clientInfo: { name: 'oraculum-gateway', title: 'Oraculum Gateway', version: '2.0.0' }, capabilities: { experimentalApi: false } }, 8_000);
      this.write({ method: 'initialized', params: {} });
      this.initialized = true;
      return result;
    } catch (error) { await this.close(); throw error; }
  }

  private receiveChunk(chunk: Buffer) {
    if (!this.alive) return;
    const max = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (this.buffer.length + part.length > max) {
        this.buffer = Buffer.alloc(0); this.fail('NATIVE_TOO_LARGE', 'Codex frame exceeded the configured byte budget'); this.child?.kill(); return;
      }
      this.buffer = Buffer.concat([this.buffer, part]);
      if (newline === -1) return;
      const frame = this.buffer; this.buffer = Buffer.alloc(0);
      try { if (frame.length) this.receive(JSON.parse(frame.toString('utf8'))); }
      catch { this.fail('NATIVE_PROTOCOL', 'Invalid Codex App Server frame'); this.child?.kill(); return; }
      start = newline + 1;
    }
  }

  private receive(message: unknown) {
    if (!record(message)) throw new Error('Invalid envelope');
    if (typeof message.method === 'string') {
      if (!record(message.params) || 'result' in message || 'error' in message) throw new Error('Invalid native notification');
      if ('id' in message) {
        if (!rpcId(message.id)) throw new Error('Invalid server request');
        const request = { id: message.id, method: message.method, params: message.params };
        if (this.listenerCount('request')) this.emit('request', request);
        else void this.rejectRequest(request.id, 'Gateway has no handler for this native request').catch(() => {});
      } else if (notifications.has(message.method)) this.emit('notification', { method: message.method, params: message.params });
      else if (/^(thread|turn|item)\//.test(message.method)) {
        const threadId=identifier(message.params.threadId)&&message.params.threadId.length<=256?message.params.threadId:undefined;
        this.emit('notification',{method:'gateway/unsupportedNativeEvent',params:threadId?{threadId}:{}});
      }
      return;
    }
    if (!rpcId(message.id)) throw new Error('Invalid native response ID');
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late read/write responses never replay a timed-out operation.
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (pending.expired) return;
    if ('error' in message) {
      const error = message.error;
      if (!record(error) || !Number.isInteger(error.code) || typeof error.message !== 'string' || 'result' in message) {
        pending.reject(new CodexError('NATIVE_PROTOCOL', 'Malformed native error response', writes.has(pending.method) ? 'unknown' : 'rejected')); return;
      }
      pending.reject(nativeError(pending.method, error.code as number, error.message)); return;
    }
    try { validate(pending.method, message.result); pending.resolve(message.result); }
    catch (error) { pending.reject(error as Error); }
  }

  private fail(code: NativeFailureCode, message: string) {
    if (!this.alive) return;
    this.alive = false; this.initialized = false; this.buffer = Buffer.alloc(0);
    const error = new CodexError(code, message, 'unknown');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.emit('unavailable', error);
  }

  private write(message: JsonObject, callback?: (error?: Error | null) => void) {
    if (!this.alive || !this.child) throw new CodexError('NATIVE_UNAVAILABLE', 'Codex App Server is unavailable', 'rejected');
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > (this.options.maxFrameBytes ?? 8 * 1024 * 1024)) throw new CodexError('NATIVE_TOO_LARGE', 'Codex request exceeds byte budget', 'rejected');
    if (this.child.stdin.writableLength > 1024 * 1024) throw new CodexError('NATIVE_BUSY', 'Codex input queue is full', 'rejected');
    this.child.stdin.write(line, callback);
  }

  private rpc(method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    if (!methods.has(method)) return Promise.reject(invalid());
    if (!this.alive || (!this.initialized && method !== 'initialize')) return Promise.reject(new CodexError('NATIVE_UNAVAILABLE', 'Codex App Server is not initialized', 'rejected'));
    if (this.pending.size >= (this.options.maxPending ?? 32)) return Promise.reject(new CodexError('NATIVE_BUSY', 'Too many pending native operations', 'rejected'));
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A caller timing out does not cancel upstream work. Retain a bounded tombstone until a late response/exit.
        // Otherwise repeated slow reads could create unlimited work inside the official App Server.
        const pending = this.pending.get(requestId); if (pending) pending.expired = true;
        reject(new CodexError('NATIVE_TIMEOUT', `Codex ${method} response timed out`, writes.has(method) ? 'unknown' : 'rejected'));
      }, timeoutMs ?? (writes.has(method) ? this.options.writeTimeoutMs ?? 60_000 : this.options.readTimeoutMs ?? 8_000));
      this.pending.set(requestId, { method, resolve, reject, timer });
      try { this.write({ id: requestId, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }

  listModels(options: { cursor?: string | null; limit?: number } = {}) {
    return this.rpc('model/list', { cursor: cursor(options.cursor), limit: limit(options.limit, 100), includeHidden: false }) as Promise<NativePage<NativeModel>>;
  }
  listThreads(options: { cwd: string; cursor?: string | null; limit?: number; searchTerm?: string; archived?: boolean }) {
    if (options.searchTerm !== undefined && (typeof options.searchTerm !== 'string' || options.searchTerm.length > 512)) throw invalid();
    return this.rpc('thread/list', { cwd: id(options.cwd), cursor: cursor(options.cursor), limit: limit(options.limit, 20),
      searchTerm: options.searchTerm, archived: options.archived ?? false, modelProviders: [], sortDirection: 'desc' }) as Promise<NativePage<NativeThread>>;
  }
  readThread(threadId: string, includeTurns = false, timeoutMs?: number) {
    return this.rpc('thread/read', { threadId: id(threadId), includeTurns }, timeoutMs) as Promise<NativeThreadResult>;
  }
  startThread(options: { cwd: string; model?: string; permissionPreset?: PermissionPreset }) {
    return this.rpc('thread/start', { cwd: id(options.cwd), ...(options.model === undefined ? {} : { model: id(options.model) }),
      ...permissions(options.permissionPreset, false) }) as Promise<NativeThreadResult>;
  }
  resumeThread(threadId: string) {
    return this.rpc('thread/resume', { threadId: id(threadId), excludeTurns: true }) as Promise<NativeThreadResult>;
  }
  startTurn(options: { threadId: string; input: NativeInput[]; model?: string; effort?: string; permissionPreset?: PermissionPreset; clientUserMessageId?: string }) {
    if (!Array.isArray(options.input) || options.input.length < 1 || options.input.length > 107) throw invalid();
    const input = options.input.map(part => {
      if (part.type === 'text' && typeof part.text === 'string' && Buffer.byteLength(part.text) <= 128 * 1024) return { type: 'text', text: part.text, text_elements: [] };
      if (part.type === 'localImage') return { type: 'localImage', path: id(part.path) };
      throw invalid();
    });
    if (options.effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw invalid();
    return this.rpc('turn/start', { threadId: id(options.threadId), input, ...(options.model === undefined ? {} : { model: id(options.model) }),
      ...(options.effort === undefined ? {} : { effort: options.effort }), ...(options.clientUserMessageId === undefined ? {} : { clientUserMessageId: id(options.clientUserMessageId) }),
      ...permissions(options.permissionPreset, true) }) as Promise<JsonObject & { turn: NativeTurn }>;
  }
  interruptTurn(threadId: string, turnId: string) {
    return this.rpc('turn/interrupt', { threadId: id(threadId), turnId: id(turnId) });
  }
  listTurns(options: { threadId: string; cursor?: string | null; limit?: number }, timeoutMs?: number) {
    return this.rpc('thread/turns/list', { threadId: id(options.threadId), cursor: cursor(options.cursor), limit: limit(options.limit, 5, 20),
      sortDirection: 'desc', itemsView: 'notLoaded' }, timeoutMs) as Promise<NativePage<NativeTurn>>;
  }
  listItems(options: { threadId: string; turnId: string; cursor?: string | null; limit?: number }, timeoutMs?: number) {
    return this.rpc('thread/items/list', { threadId: id(options.threadId), turnId: id(options.turnId), cursor: cursor(options.cursor),
      limit: limit(options.limit, 40, 40), sortDirection: 'desc' }, timeoutMs) as Promise<NativePage<{ turnId: string; item: NativeItem }>>;
  }
  async readExtensions(kind: 'skills' | 'mcp' | 'apps' | 'plugins', cwd: string): Promise<{ status: 'available'; data: JsonObject } | { status: 'unavailable'; code: NativeFailureCode }> {
    const selected = { skills: ['skills/list', { cwds: [id(cwd)] }], mcp: ['mcpServerStatus/list', { limit: 100 }], apps: ['app/installed', {}], plugins: ['plugin/installed', { cwds: [id(cwd)] }] } as const;
    if (!Object.hasOwn(selected, kind)) throw invalid();
    const [method, params] = selected[kind];
    try { return { status: 'available', data: await this.rpc(method, params, 3000) }; }
    catch (error) { return { status: 'unavailable', code: error instanceof CodexError ? error.code : 'NATIVE_PROTOCOL' }; }
  }
  /** Internal interaction manager only. Native request IDs never come from HTTP clients. */
  respondRequest(requestId: RpcId, result: JsonObject): Promise<void> {
    return this.response({ id: requestId, result });
  }
  private response(message: JsonObject): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return; settled = true; clearTimeout(timer); this.off('unavailable', lost);
        if (error) reject(error); else resolve();
      };
      const lost = () => finish(new CodexError('NATIVE_UNAVAILABLE', 'Native response delivery is unknown', 'unknown'));
      const timer = setTimeout(() => finish(new CodexError('NATIVE_TIMEOUT', 'Native interaction response delivery timed out', 'unknown')), this.options.writeTimeoutMs ?? 60_000);
      this.once('unavailable', lost);
      try { this.write(message, error => finish(error ? new CodexError('NATIVE_UNAVAILABLE', 'Native response delivery is unknown', 'unknown') : undefined)); }
      catch (error) { finish(error as Error); }
    });
  }
  rejectRequest(requestId: RpcId, reason = 'Unsupported native request'): Promise<void> {
    return this.response({ id: requestId, error: { code: -32601, message: reason } });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.started = true;
    this.fail('NATIVE_UNAVAILABLE', 'Codex App Server is stopping');
    this.child?.stdin.end();
    const term = setTimeout(() => this.child?.kill('SIGTERM'), 1000);
    const kill = setTimeout(() => this.child?.kill('SIGKILL'), 3000);
    this.closing = (this.exited ?? Promise.resolve()).finally(() => { clearTimeout(term); clearTimeout(kill); });
    return this.closing;
  }
}
