import { createHash, randomUUID } from 'node:crypto';
import { parseContract, type Attachment, type ContractName, type ContractTypes, type OperationReceipt, type Preset } from '../../../../packages/gateway-protocol/src/index';
import type { DraftSubmission, WorkspaceAction, WorkspaceState } from '../contracts/workspace';
import { GatewayTransport } from './gateway-transport';
import { OperationJournal, type JournalEntry, type JournalScope } from './journal';
import { Projection } from './projection';
import { FileChangeContexts } from './file-change-context';
import { parseWorkspaceAction, validateInteractionAnswer } from './workspace-actions';
import { filePreview, saveDownload, selectLocalUpload, verifyDownload, type FileDialogs } from './file-transfer';
import { ConnectionPreferences } from './connection-preferences';
import { normalizeEndpoint } from './endpoint';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const code = (error: unknown): string => {
  const value = record(error) && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'DESKTOP_OPERATION_FAILED';
};
const segment = (value: string) => encodeURIComponent(value);
const compact = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(value: string): never { throw new Error(value); }
const absoluteDisplayPath = /(^|[\s"'`=])\/(?!\/)[^\s"'`<>]+/g;
function assertApprovalVisible(action: Extract<WorkspaceAction, { type: 'answer' }>, request: Record<string, unknown>, kind: string, projectRoot: string | undefined): void {
  if (action.response.type !== 'approval' || action.response.decision !== 'accept') return;
  if (kind === 'command' && typeof request.command === 'string' && request.command.trim()
    && (!projectRoot || request.cwd !== projectRoot)) fail('COMMAND_CWD_UNVERIFIED');
  const hidden = (value: unknown, key = ''): boolean => {
    if (key === 'cwd') return false; // Command cwd is bound to the exact registered project above.
    if (typeof value === 'string') return value.replace(absoluteDisplayPath, '$1[主机路径]') !== value;
    if (Array.isArray(value)) return value.some(item => hidden(item));
    return record(value) && Object.entries(value).some(([name, item]) => hidden(item, name));
  };
  if (hidden(request)) fail('APPROVAL_CONTEXT_REDACTED');
}

/** Native records are display data, never an authority or a filesystem capability. */
export function rendererProjection(value: WorkspaceState): WorkspaceState {
  const redact = (input: unknown, key = '', depth = 0): unknown => {
    if (depth > 40) return '[内容过深]';
    if (/^(authorization|accessToken|deviceCredential|credential|pairingCode|canonicalPath|cwd|gitRoot|localPath|filePath|absolutePath)$/i.test(key)) return undefined;
    if (typeof input === 'string') {
      if (/^(path|root|directory|workingDirectory)$/i.test(key) && input.startsWith('/')) return '[主机路径]';
      // Native command/output may contain host paths. Preserve commands while removing private prefixes.
      return input.replace(absoluteDisplayPath, '$1[主机路径]');
    }
    if (Array.isArray(input)) return input.map(item => redact(item, '', depth + 1));
    if (record(input)) return Object.fromEntries(Object.entries(input).filter(([name]) => !['__proto__', 'constructor', 'prototype'].includes(name)).map(([name, item]) => [name, redact(item, name, depth + 1)]).filter(([, item]) => item !== undefined));
    return input;
  };
  return redact(compact(value)) as WorkspaceState;
}

export class DesktopWorkspace {
  private value: WorkspaceState;
  private projection = new Projection();
  private fileContexts = new FileChangeContexts();
  private projectRoots = new Map<string, string>();
  private archiveFacts = new Map<string, boolean>();
  private archiveRevision = 0;
  private closeEvents?: () => void;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private connectionGeneration = 0;
  private selectionGeneration = 0;
  private wsReady = false;
  private manualOffline = true;
  private reconnectDelay = 1000;
  private snapshotBusy = false;
  private snapshotAgain = false;
  private search = '';
  private archived = false;
  private firstTurn?: { threadId: string; epoch: string; generation: number };
  private lastIdentity?: NonNullable<GatewayTransport['identity']>;
  private journalFailed = false;
  private attachmentFacts = new Map<string, Attachment>();
  private details?: { itemId: string; turnId: string; revision: string; digest: string; total: number; bytes: Buffer; cursor?: string };

  constructor(private transport: GatewayTransport, private journal: OperationJournal, private dialogs: FileDialogs,
    private publish: (state: WorkspaceState) => void, secureStorage: boolean, private connectionPreferences?: ConnectionPreferences) {
    this.value = { connection: { status: 'idle', endpoint: '', secureStorage }, projects: [], roots: [],
      streamItems: [], interactions: [], synchronization: 'stale', attachments: [], draftId: randomUUID(), operations: [], busy: false };
    const saved = connectionPreferences?.read();
    if (saved) {
      this.value.connection.endpoint = saved.endpoint;
      this.value.connection.status = saved.signedOut ? 'revoked' : 'offline';
      if (!saved.signedOut) this.restoreLocalScope(saved.endpoint);
    } else if (connectionPreferences?.recovered) this.value.notice = 'CONNECTION_PREFERENCES_RECOVERED';
  }
  async restoreConnection(): Promise<void> {
    if (this.connectionPreferences?.read()?.autoConnect) await this.action({ type: 'reconnect' });
  }
  private restoreLocalScope(endpoint: string): void {
    this.value.localScope = undefined; this.lastIdentity = undefined;
    try {
      const identity = this.transport.savedIdentity?.(endpoint);
      if (identity) { this.value.localScope = { ...identity }; this.lastIdentity = { ...identity }; }
    } catch (error) { this.value.connection.errorCode = code(error); }
  }
  private clearIdentityDisplay(): void {
    this.value.localScope = undefined; this.lastIdentity = undefined;
    this.projection.initialize('', ''); this.selectionGeneration++;
    this.value.projects = []; this.value.roots = []; this.value.threads = undefined;
    this.value.capabilities = undefined; this.value.models = undefined; this.value.defaults = undefined;
    this.value.directories = undefined; this.value.files = undefined; this.value.preview = undefined;
    this.value.extensions = undefined; this.value.itemDetails = undefined; this.value.rateLimits = undefined; this.value.accountUsage = undefined;
    this.value.attachments = []; this.value.operations = []; this.attachmentFacts.clear();
    this.value.draftId = randomUUID();
  }
  state(): WorkspaceState { this.syncProjection(); return rendererProjection(this.value); }
  private emit(): void { this.publish(this.state()); }
  private syncProjection(): void {
    for (const key of ['projectId', 'threadId', 'thread', 'history', 'activeTurnId', 'plan', 'diff', 'tokenUsage'] as const) delete this.value[key];
    Object.assign(this.value, this.projection.view());
    if (this.value.thread) {
      const archived = this.archiveFact(this.value.thread.projectId, this.value.thread.id);
      delete this.value.thread.archived;
      if (archived !== undefined) this.value.thread.archived = archived;
    }
    this.value.fileChangeContexts = Object.fromEntries(this.value.interactions.flatMap(interaction => {
      const proof = this.fileContexts.forInteraction(interaction);
      return proof ? [[interaction.interactionId, { ...proof, changes: proof.changes.map(change => ({ ...change })) }]] : [];
    }));
    this.value.commandScopes = Object.fromEntries(this.value.interactions.filter(interaction => interaction.kind === 'command'
      && !!this.value.projectId && interaction.request.cwd === this.projectRoots.get(this.value.projectId))
      .map(interaction => [interaction.interactionId, { relativeCwd: '.' as const }]));
    this.value.firstTurnReady = !!this.firstTurn && this.firstTurn.threadId === this.value.threadId && this.firstTurn.epoch === this.value.connection.epoch && this.firstTurn.generation === this.connectionGeneration;
    const identity = this.transport.identity ?? this.lastIdentity;
    try {
      const entries = identity ? this.journal.list(identity) : [];
      this.value.operations = entries.map(row => ({ operationId: row.operationId, kind: row.kind,
        projectId: row.projectId, threadId: row.threadId, status: row.state, createdAt: row.createdAt, errorCode: row.code,
        clientDraftId: row.clientDraftId, draftRevision: row.draftRevision }));
      this.value.attachments = [...this.attachmentFacts.values()].map(attachment => {
        const claim = entries.find(row => row.kind === 'turn.start' && row.state !== 'rejected' && row.projectId === attachment.projectId
          && row.threadId === attachment.threadId && row.attachmentIds?.includes(attachment.id));
        if (!claim || attachment.state === 'sent' || attachment.state === 'expired') return attachment;
        return { ...attachment, state: claim.state === 'accepted' ? 'unknown' : 'held' };
      });
    } catch { this.journalFailed = true; this.value.notice = 'JOURNAL_UNAVAILABLE'; }
  }
  private identity(): NonNullable<GatewayTransport['identity']> { return this.transport.identity ?? fail('AUTHENTICATION_REQUIRED'); }
  private archiveKey(projectId: string, threadId: string): string | undefined {
    const identity = this.transport.identity;
    return identity && this.value.connection.epoch
      ? JSON.stringify([identity.endpoint, identity.installationId, identity.deviceId, this.value.connection.epoch, projectId, threadId]) : undefined;
  }
  private archiveFact(projectId: string, threadId: string): boolean | undefined {
    const key = this.archiveKey(projectId, threadId);
    return key ? this.archiveFacts.get(key) : undefined;
  }
  private rememberArchive(projectId: string, threadId: string, archived: boolean): void {
    const key = this.archiveKey(projectId, threadId);
    if (key) this.archiveFacts.set(key, archived);
  }
  private invalidateArchives(projectId?: string, threadId?: string): void {
    this.archiveRevision++;
    if (projectId && threadId) {
      const key = this.archiveKey(projectId, threadId);
      if (key) this.archiveFacts.delete(key);
    } else this.archiveFacts.clear();
    if (this.value.threads) this.value.threads = { ...this.value.threads, threads: this.value.threads.threads.map(thread => {
      if (projectId && threadId && (thread.projectId !== projectId || thread.id !== threadId)) return thread;
      const { archived: _archived, ...rest } = thread; return rest;
    }) };
  }
  private writableThread(archived = false): void {
    const known = this.value.projectId && this.value.threadId ? this.archiveFact(this.value.projectId, this.value.threadId) : undefined;
    if (known === undefined) fail('THREAD_ARCHIVE_STATE_UNKNOWN');
    if (known !== archived) fail(known ? 'THREAD_ARCHIVED' : 'THREAD_NOT_ARCHIVED');
  }
  private acceptedArchive(row: JournalEntry, receipt: OperationReceipt): void {
    if (receipt.status !== 'accepted' || (row.state !== 'prepared' && row.state !== 'unknown') || row.epoch !== this.value.connection.epoch || !row.projectId) return;
    if ((row.kind === 'thread.start' || row.kind === 'thread.fork') && receipt.nativeThreadId) this.rememberArchive(row.projectId, receipt.nativeThreadId, false);
    else if (row.threadId && (row.kind === 'thread.archive' || row.kind === 'thread.unarchive')) this.rememberArchive(row.projectId, row.threadId, row.kind === 'thread.archive');
    else if (row.threadId && row.kind === 'thread.delete') this.invalidateArchives(row.projectId, row.threadId);
  }
  private scope(project = true, thread = true): JournalScope {
    const identity = this.identity(), epoch = this.value.connection.epoch ?? fail('STALE_EPOCH');
    return { ...identity, epoch, ...(project ? { projectId: this.value.projectId ?? fail('PROJECT_REQUIRED') } : {}),
      ...(thread ? { threadId: this.value.threadId ?? fail('THREAD_REQUIRED') } : {}) };
  }
  private online(): void { if (this.value.connection.status !== 'connected' || !this.wsReady) fail('CONNECTION_NOT_READY'); }
  private capability(name: string): void {
    const found = this.value.capabilities?.capabilities.find(item => item.name === name);
    if (!found?.supported || ['unsupported', 'unavailable'].includes(found.availability)) fail('CAPABILITY_UNAVAILABLE');
  }
  private ready(): void {
    this.online(); this.syncProjection();
    if (this.value.synchronization !== 'current' && !(this.firstTurn && this.firstTurn.threadId === this.value.threadId
      && this.firstTurn.epoch === this.value.connection.epoch && this.firstTurn.generation === this.connectionGeneration)) fail('STATE_NOT_CURRENT');
  }
  private envelope(value: unknown): Record<string, unknown> {
    if (!record(value) || value.installationId !== this.identity().installationId || typeof value.epoch !== 'string') fail('RESPONSE_IDENTITY_MISMATCH');
    if (value.epoch !== this.value.connection.epoch) {
      this.fileContexts.clear(); this.projection.invalidate(); this.wsReady = false; this.firstTurn = undefined;
      this.scheduleReconnect(); fail('STALE_EPOCH');
    }
    return value;
  }
  private async read<K extends ContractName>(contract: K, method: 'GET' | 'POST', path: string, body?: unknown): Promise<ContractTypes[K]> {
    const generation = this.connectionGeneration;
    const response = await this.transport.request(method, path, body);
    if (generation !== this.connectionGeneration) fail('CONNECTION_CHANGED');
    const envelope = this.envelope(response);
    parseContract('ResourceResponse', envelope);
    return parseContract(contract, envelope.data);
  }
  private originalScope(row: JournalEntry): JournalScope {
    return { ...this.identity(), epoch: row.epoch, projectId: row.projectId, threadId: row.threadId };
  }
  private async write(kind: string, path: string, body: Record<string, unknown>, scope: JournalScope, method: 'POST' | 'DELETE' = 'POST',
    dispatch?: (operationId: string, beforeDispatch: () => void) => Promise<unknown>, contextDigest?: string, draft?: DraftSubmission): Promise<OperationReceipt> {
    this.online();
    if (this.journalFailed) fail('JOURNAL_UNAVAILABLE');
    const generation = this.connectionGeneration;
    const selection = this.selectionGeneration;
    const expectedTurnId = this.value.activeTurnId;
    let dispatched = false;
    const beforeDispatch = (): void => {
      this.online(); this.syncProjection();
      if (this.journalFailed) fail('JOURNAL_UNAVAILABLE');
      if (generation !== this.connectionGeneration || scope.epoch !== this.value.connection.epoch
        || this.identity().deviceId !== scope.deviceId || this.identity().installationId !== scope.installationId
        || (scope.threadId && (selection !== this.selectionGeneration || scope.projectId !== this.value.projectId || scope.threadId !== this.value.threadId))) fail('SCOPE_CHANGED');
      if (kind === 'turn.start') { this.ready(); if (this.value.activeTurnId) fail('TURN_ACTIVE'); this.firstTurn = undefined; }
      if (['turn.start', 'turn.steer', 'attachment.upload', 'thread.archive'].includes(kind)) this.writableThread();
      if (kind === 'thread.unarchive') this.writableThread(true);
      if (kind === 'turn.interrupt' || kind === 'turn.steer') {
        if (!expectedTurnId || this.value.activeTurnId !== expectedTurnId) fail('ACTIVE_TURN_CHANGED');
      }
      if (kind === 'interaction.respond') {
        const interactionId = decodeURIComponent(path.split('/')[2]!);
        const current = this.value.interactions.find(item => item.interactionId === interactionId) ?? fail('INTERACTION_STALE');
        const action: Extract<WorkspaceAction, { type: 'answer' }> = { type: 'answer', interactionId, generation: body.generation as number,
          epoch: body.epoch as string, response: body.response as Extract<WorkspaceAction, { type: 'answer' }>['response'], ...(contextDigest ? { contextDigest } : {}) };
        validateInteractionAnswer(current, action, this.fileContexts.forInteraction(current)); assertApprovalVisible(action, current.request, current.kind, this.projectRoots.get(current.projectId));
      }
      if (kind === 'attachment.upload') this.ready();
      if (kind.startsWith('thread.') && !['thread.start', 'thread.resume'].includes(kind)) this.ready();
      dispatched = true;
    };
    const entry = this.journal.prepare(scope, kind, compact({ ...body, ...draft }));
    this.emit();
    // No await between the final scope check and enqueue. The durable entry survives all failures.
    try {
      if (generation !== this.connectionGeneration || scope.epoch !== this.value.connection.epoch) fail('CONNECTION_CHANGED');
      const raw = await (dispatch ? dispatch(entry.operationId, beforeDispatch) : this.transport.request(method, path, { ...compact(body), operationId: entry.operationId }, beforeDispatch));
      if (generation !== this.connectionGeneration) fail('CONNECTION_CHANGED');
      const response = parseContract('OperationResponse', this.envelope(raw));
      if (response.operation.operationId !== entry.operationId) fail('RECEIPT_ID_MISMATCH');
      this.journal.settle({ ...scope, operation: response.operation });
      this.acceptedArchive(entry, response.operation);
      this.value.notice = response.operation.status === 'accepted' ? 'GATEWAY_ACCEPTED' : response.operation.errorCode ?? 'OPERATION_UNKNOWN';
      return response.operation;
    } catch (error) {
      if (!dispatched) {
        this.journal.settle({ ...scope, operation: { operationId: entry.operationId, status: 'rejected', delivery: 'notSent', errorCode: code(error) } });
        throw error;
      }
      this.journal.markUnknown(entry.operationId, code(error)); this.value.notice = 'OPERATION_UNKNOWN';
      // Query once, never replay the request, regardless of HTTP status.
      await this.reconcileOne(entry).catch(() => {});
      const reconciled = this.journal.list(scope).find(row => row.operationId === entry.operationId);
      if (reconciled?.receipt && ['accepted', 'rejected'].includes(reconciled.state)) {
        this.value.notice = reconciled.state === 'accepted' ? 'GATEWAY_ACCEPTED' : reconciled.receipt.errorCode ?? 'OPERATION_REJECTED';
        return { ...reconciled.receipt };
      }
      throw error;
    } finally { this.emit(); }
  }
  private async reconcileOne(row: JournalEntry): Promise<void> {
    const identity = this.transport.identity;
    if (!identity || identity.installationId !== row.installationId || identity.deviceId !== row.deviceId
      || createHash('sha256').update(identity.endpoint).digest('hex') !== row.endpointKey) return;
    try {
      const receipt = await this.read('OperationQueryResult', 'GET', `/operations/${segment(row.operationId)}`);
      if (receipt.operationId !== row.operationId) fail('RECEIPT_ID_MISMATCH');
      if (receipt.attachment) {
        const expected = row.attachment, attachment = receipt.attachment;
        if (!expected || attachment.projectId !== row.projectId || attachment.threadId !== row.threadId
          || attachment.draftId !== expected.draftId || attachment.name !== expected.name || attachment.mime !== expected.mime
          || attachment.size !== expected.size || attachment.digest !== expected.digest) fail('ATTACHMENT_INTEGRITY_FAILED');
      }
      this.journal.settle({ ...this.originalScope(row), operation: receipt });
      this.acceptedArchive(row, receipt);
      if (receipt.attachment && receipt.attachment.projectId === this.value.projectId && receipt.attachment.threadId === this.value.threadId) {
        const attachment: Attachment = { ...receipt.attachment, ...(receipt.status === 'accepted' ? {} : { state: 'unknown' as const }) };
        if (!this.value.attachments.length && !['sent', 'expired'].includes(attachment.state)) this.value.draftId = attachment.draftId;
        if (['sent', 'expired'].includes(attachment.state)) this.attachmentFacts.delete(attachment.id);
        else this.attachmentFacts.set(attachment.id, attachment);
      }
    } catch (error) {
      if (row.state === 'prepared' || row.state === 'unknown') this.journal.markUnknown(row.operationId, code(error));
      if (code(error) === 'ATTACHMENT_INTEGRITY_FAILED') this.value.notice = code(error);
      if (['DEVICE_REVOKED', 'UNAUTHENTICATED'].includes(code(error))) throw error;
    }
  }
  private async reconcile(): Promise<void> {
    const identity = this.identity();
    for (const row of this.journal.pending(identity)) await this.reconcileOne(row);
    for (const row of this.journal.list(identity).filter(item => item.kind === 'attachment.upload' && item.state === 'accepted'
      && item.projectId === this.value.projectId && item.threadId === this.value.threadId).slice(-30)) await this.reconcileOne(row);
    this.emit();
  }
  private stopConnection(): void {
    this.invalidateArchives();
    this.connectionGeneration++; this.wsReady = false;
    clearTimeout(this.reconnectTimer); clearTimeout(this.snapshotTimer);
    this.reconnectTimer = undefined; this.snapshotTimer = undefined;
    this.closeEvents?.(); this.closeEvents = undefined;
    this.transport.disconnect(); this.fileContexts.clear(); this.projection.invalidate(); this.firstTurn = undefined;
  }
  dispose(): void { this.manualOffline = true; this.stopConnection(); }
  private scheduleReconnect(): void {
    if (this.manualOffline || this.reconnectTimer) return;
    this.invalidateArchives(); this.value.connection.status = 'offline'; this.fileContexts.clear(); this.projection.invalidate(); this.emit();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.value.busy) void this.action({ type: 'reconnect' }).catch(() => {});
      else this.scheduleReconnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(15000, this.reconnectDelay * 2);
    this.reconnectTimer.unref();
  }
  private connectionError(error: unknown): void {
    const reason = code(error);
    this.value.connection.errorCode = reason;
    const revoked = ['DEVICE_REVOKED', 'UNAUTHENTICATED', 'IDENTITY_MISMATCH', 'INSTALLATION_CHANGED', 'CREDENTIAL_BINDING_MISMATCH'].includes(reason);
    const terminal = revoked || reason.startsWith('CREDENTIAL_') || ['ENDPOINT_INVALID', 'INSECURE_ENDPOINT', 'PROTOCOL_INCOMPATIBLE'].includes(reason);
    this.value.connection.status = revoked ? 'revoked' : terminal ? 'error' : 'offline';
    if (revoked) {
      this.manualOffline = true; this.stopConnection(); this.clearIdentityDisplay();
      // Persist the authorization boundary before another startup can select cached data.
      try { this.connectionPreferences?.save(this.value.connection.endpoint, false, true); }
      catch { this.value.notice = 'CONNECTION_PREFERENCES_SAVE_FAILED'; }
    }
    this.wsReady = false; this.fileContexts.clear(); this.projection.invalidate(); this.emit();
    if (!terminal) this.scheduleReconnect();
  }
  private async connect(endpoint: string, recovering = false): Promise<void> {
    endpoint = normalizeEndpoint(endpoint);
    this.connectionPreferences?.save(endpoint, true);
    const projectId = recovering ? this.value.projectId : undefined, threadId = recovering ? this.value.threadId : undefined;
    this.stopConnection(); this.manualOffline = false;
    const generation = this.connectionGeneration;
    this.value.connection = { status: 'connecting', endpoint, secureStorage: this.value.connection.secureStorage };
    if (!recovering) {
      this.lastIdentity = undefined;
      this.projection.initialize('', '');
      this.selectionGeneration++; this.firstTurn = undefined;
      this.value.projects = []; this.value.roots = []; this.value.threads = undefined;
      this.value.capabilities = undefined; this.value.models = undefined; this.value.defaults = undefined;
      this.value.directories = undefined; this.value.files = undefined; this.value.preview = undefined;
      this.value.extensions = undefined; this.value.itemDetails = undefined; this.value.rateLimits = undefined; this.value.accountUsage = undefined;
      this.value.attachments = []; this.value.draftId = randomUUID();
      this.attachmentFacts.clear();
    }
    if (!recovering || this.value.localScope?.endpoint !== endpoint) this.restoreLocalScope(endpoint);
    this.emit();
    const connection = await this.transport.connect(endpoint);
    if (generation !== this.connectionGeneration) return;
    this.value.connection = { status: connection.paired ? 'connected' : 'pairing', endpoint: connection.endpoint,
      installationId: connection.installationId, deviceId: connection.deviceId ?? undefined, epoch: connection.epoch ?? undefined,
      secureStorage: this.value.connection.secureStorage };
    if (!connection.paired) { this.value.localScope = undefined; this.lastIdentity = undefined; this.emit(); return; }
    this.lastIdentity = this.identity();
    this.value.localScope = { ...this.lastIdentity };
    this.value.capabilities = connection.capabilities ?? undefined;
    if (!recovering || this.projection.installationId !== connection.installationId || this.projection.epoch !== connection.epoch) {
      this.projection.initialize(connection.installationId, connection.epoch!, projectId, threadId);
    }
    this.syncProjection();
    await this.startEvents(generation);
    await this.reconcile();
    await this.loadProjects();
    this.value.models = await this.read('ModelPage', 'GET', '/models').catch(() => undefined);
    if (projectId) {
      await this.loadThreads(false);
      if (threadId) await this.refreshSnapshot();
    }
    this.reconnectDelay = 1000; this.emit();
  }
  private async startEvents(generation: number): Promise<void> {
    const close = await this.transport.openEvents({ epoch: this.projection.epoch, afterSeq: this.projection.seq }, message => {
      if (generation !== this.connectionGeneration) return;
      try {
        if (record(message) && message.type === 'connection') {
          if (message.epoch !== this.value.connection.epoch) { this.wsReady = false; this.scheduleReconnect(); return; }
          const result = this.projection.acceptConnection(parseContract('EventConnection', message));
          this.wsReady = true;
          if (result.reconnect) { this.closeEvents?.(); this.scheduleReconnect(); return; }
          if (result.reset) { this.invalidateArchives(); this.fileContexts.clear(); this.firstTurn = undefined; this.scheduleSnapshot(); }
        } else if (record(message) && message.type === 'pong') {
          if (message.epoch !== this.value.connection.epoch) { this.wsReady = false; this.scheduleReconnect(); }
        } else {
          const event = parseContract('EventEnvelope', message), previousSeq = this.projection.seq, result = this.projection.applyEvent(event);
          if (event.seq > previousSeq && !result.reconnect && event.kind === 'native.state' && record(event.payload)
            && ['thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/closed'].includes(String(event.payload.method))) {
            this.invalidateArchives(event.scope.projectId, event.scope.threadId);
          }
          if (result.resynchronize || result.reconnect || event.scope.threadId === this.value.threadId) this.fileContexts.clear();
          if (result.operation) {
            const row = this.journal.list(this.identity()).find(item => item.operationId === result.operation!.operationId);
            if (row && row.projectId === event.scope.projectId && row.threadId === event.scope.threadId) {
              this.journal.settle({ ...this.originalScope(row), operation: result.operation }); this.acceptedArchive(row, result.operation);
            }
          }
          if (result.reconnect) { this.wsReady = false; this.closeEvents?.(); this.scheduleReconnect(); }
          else if (result.resynchronize) { this.firstTurn = undefined; this.scheduleSnapshot(); }
          if (result.projectChanged) void this.loadProjects().catch(() => {});
        }
        this.emit();
      } catch { this.invalidateArchives(); this.firstTurn = undefined; this.fileContexts.clear(); this.projection.invalidate(); this.scheduleSnapshot(); this.emit(); }
    }, () => {
      if (generation !== this.connectionGeneration || this.manualOffline) return;
      this.wsReady = false; this.firstTurn = undefined; this.scheduleReconnect();
    });
    if (generation !== this.connectionGeneration) close();
    else this.closeEvents = close;
  }
  private scheduleSnapshot(delay = 450): void {
    if (this.snapshotTimer || !this.value.threadId || this.manualOffline) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      void this.refreshSnapshot().catch(error => { this.value.notice = code(error); this.emit(); });
    }, delay);
    this.snapshotTimer.unref();
  }
  private async refreshSnapshot(): Promise<void> {
    this.syncProjection();
    const threadId = this.value.threadId, projectId = this.value.projectId;
    if (!threadId || !projectId || this.value.connection.status !== 'connected') return;
    if (this.snapshotBusy) { this.snapshotAgain = true; return; }
    this.snapshotBusy = true; this.fileContexts.clear();
    const ticket = this.projection.ticket(), selection = this.selectionGeneration;
    try {
      const snapshot = await this.read('Snapshot', 'POST', `/threads/${segment(threadId)}/snapshot`, { projectId });
      if (selection !== this.selectionGeneration) return;
      if (!this.projection.applySnapshot(snapshot, ticket)) { this.snapshotAgain = true; return; }
      this.fileContexts.snapshot(snapshot, this.projectRoots.get(projectId) ?? '');
      for (const receipt of snapshot.operations) {
        const row = this.journal.list(this.identity()).find(item => item.operationId === receipt.operationId);
        if (row && row.projectId === projectId && (!row.threadId || row.threadId === threadId)) {
          this.journal.settle({ ...this.originalScope(row), operation: receipt }); this.acceptedArchive(row, receipt);
        }
      }
      if (snapshot.synchronization !== 'current') this.scheduleSnapshot(1800);
      await this.updateSnapshotThreadList(snapshot);
    } finally {
      this.snapshotBusy = false; this.emit();
      if (this.snapshotAgain) { this.snapshotAgain = false; this.scheduleSnapshot(700); }
    }
  }
  private snapshotThreadListKey?: string;
  private archivePage(data: ContractTypes['ThreadPage'], projectId: string, archived: boolean): ContractTypes['ThreadPage'] {
    if (data.threads.some(thread => thread.projectId !== projectId)) fail('SCOPE_MISMATCH');
    for (const thread of data.threads) this.rememberArchive(projectId, thread.id, archived);
    return { ...data, threads: data.threads.map(thread => ({ ...thread, archived })) };
  }
  private async updateSnapshotThreadList(snapshot: ContractTypes['Snapshot']): Promise<void> {
    let page = this.value.threads;
    const thread = snapshot.thread;
    if (!page || thread.projectId !== this.value.projectId || thread.id !== this.value.threadId) return;
    const { archived: _snapshotArchived, ...metadata } = thread;
    const archivedFact = this.archiveFact(thread.projectId, thread.id);
    const existing = page.threads.find(item => item.id === thread.id && item.projectId === thread.projectId);
    if (existing) {
      this.value.threads = { ...page, threads: page.threads.flatMap(item => item !== existing ? [item]
        : archivedFact !== undefined && archivedFact !== this.archived ? [] : [{ ...item, ...metadata, ...(archivedFact === undefined ? {} : { archived: archivedFact }) }]) };
      page = this.value.threads;
    }
    if (archivedFact !== undefined) {
      if (!existing && !this.search && archivedFact === this.archived) this.value.threads = { ...page, threads: [{ ...metadata, archived: archivedFact }, ...page.threads] };
      return;
    }
    // Snapshot does not establish archive membership. Query each archive view
    // at most once for this accepted revision, without guessing false on absence.
    if (snapshot.synchronization !== 'current') return;
    const selection = this.selectionGeneration, generation = this.connectionGeneration;
    const search = this.search, archived = this.archived, revision = this.archiveRevision;
    const key = JSON.stringify([generation, selection, thread.projectId, thread.id, snapshot.history.historyRevision, revision, search, archived]);
    if (key === this.snapshotThreadListKey) return;
    this.snapshotThreadListKey = key;
    try {
      for (const queryArchive of [archived, !archived]) {
        const query = new URLSearchParams({ limit: '30', search: '', archived: String(queryArchive) });
        const response = await this.read('ThreadPage', 'GET', `/projects/${segment(thread.projectId)}/threads?${query}`);
        if (selection !== this.selectionGeneration || generation !== this.connectionGeneration || revision !== this.archiveRevision || search !== this.search || archived !== this.archived
          || thread.projectId !== this.value.projectId || thread.id !== this.value.threadId || this.value.threads !== page) return;
        const data = this.archivePage(response, thread.projectId, queryArchive);
        const confirmed = data.threads.find(item => item.id === thread.id);
        if (!confirmed) continue;
        const remaining = page.threads.filter(item => item.id !== thread.id);
        this.value.threads = { ...page, threads: queryArchive !== archived ? remaining
          : existing ? page.threads.map(item => item.id === thread.id ? { ...item, ...confirmed } : item)
          : !search ? [{ ...confirmed }, ...page.threads] : page.threads };
        return;
      }
    } catch { /* Keep the accepted Snapshot; an explicit list refresh remains available. */ }
  }
  private async loadProjects(): Promise<void> {
    const data = await this.read('Projects', 'GET', '/projects');
    this.projectRoots = new Map(data.projects.map(project => [project.id, project.canonicalPath]));
    this.value.projects = data.projects.map(({ id, name, rootId, available }) => ({ id, name, rootId, available }));
    this.value.roots = data.roots.map(({ id, label }) => ({ id, label }));
  }
  private async selectProject(projectId: string): Promise<void> {
    if (!this.value.projects.some(project => project.id === projectId && project.available)) fail('PROJECT_UNAVAILABLE');
    this.selectionGeneration++; this.firstTurn = undefined; this.details = undefined;
    this.fileContexts.clear(); this.projection.selectScope(projectId);
    this.syncProjection(); this.value.threads = undefined; this.value.attachments = []; this.value.draftId = randomUUID();
    this.attachmentFacts.clear();
    this.value.files = undefined; this.value.preview = undefined; this.value.extensions = undefined; this.value.itemDetails = undefined;
    this.search = ''; this.archived = false;
    await this.loadThreads(false);
    this.value.defaults = await this.read('NativeDefaults', 'GET', `/projects/${segment(projectId)}/native-defaults`).catch(() => undefined);
  }
  private async loadThreads(more: boolean): Promise<void> {
    const projectId = this.value.projectId ?? fail('PROJECT_REQUIRED'), selection = this.selectionGeneration;
    const search = this.search, archived = this.archived, revision = this.archiveRevision;
    const query = new URLSearchParams({ limit: '30', search, archived: String(archived) });
    if (more) { const cursor = this.value.threads?.nextCursor; if (!cursor) return; query.set('cursor', cursor); }
    const response = await this.read('ThreadPage', 'GET', `/projects/${segment(projectId)}/threads?${query}`);
    if (selection !== this.selectionGeneration || search !== this.search || archived !== this.archived || revision !== this.archiveRevision) return;
    const data = this.archivePage(response, projectId, archived);
    this.value.threads = more && this.value.threads ? { ...data, threads: [...this.value.threads.threads, ...data.threads.filter(item => !this.value.threads!.threads.some(existing => existing.id === item.id))] } : data;
  }
  private async selectThread(threadId: string, newlyCreated = false): Promise<void> {
    const projectId = this.value.projectId ?? fail('PROJECT_REQUIRED');
    const thread = await this.read('Thread', 'GET', `/projects/${segment(projectId)}/threads/${segment(threadId)}`);
    if (thread.id !== threadId || thread.projectId !== projectId) fail('SCOPE_MISMATCH');
    this.selectionGeneration++; this.details = undefined; this.firstTurn = undefined;
    this.fileContexts.clear(); this.projection.selectScope(projectId, threadId);
    this.projection.setThreadMetadata(thread);
    this.syncProjection(); this.value.attachments = []; this.value.draftId = randomUUID(); this.value.itemDetails = undefined;
    this.attachmentFacts.clear();
    // Subscribe before snapshot; selection must not reset the device event checkpoint.
    await this.refreshSnapshot().catch(async error => {
      if (!newlyCreated || thread.status !== 'idle' || code(error) !== 'NATIVE_HISTORY_NOT_MATERIALIZED') throw error;
      const ticket = this.projection.ticket(), generation = this.connectionGeneration, selection = this.selectionGeneration;
      const fresh = await this.read('Thread', 'GET', `/projects/${segment(projectId)}/threads/${segment(threadId)}`);
      const current = this.projection.ticket();
      if (ticket.generation !== current.generation || ticket.version !== current.version || generation !== this.connectionGeneration || selection !== this.selectionGeneration
        || fresh.id !== threadId || fresh.projectId !== projectId || fresh.status !== 'idle' || !this.wsReady) throw error;
      this.projection.setThreadMetadata(fresh);
      this.firstTurn = { threadId, epoch: this.value.connection.epoch!, generation: this.connectionGeneration };
      this.value.notice = 'NEW_THREAD_READY';
    });
    for (const row of this.journal.list(this.identity()).filter(item => item.projectId === projectId && item.threadId === threadId && item.kind === 'attachment.upload').slice(-30)) await this.reconcileOne(row);
  }
  private async historyMore(action: Extract<WorkspaceAction, { type: 'historyMore' }>): Promise<void> {
    const { projectId, threadId, history } = this.value;
    if (!projectId || !threadId || !history) return;
    // A cached cursor is a read hint only and must match this live native revision.
    if (action.cursor && (action.historyRevision !== history.historyRevision || this.value.synchronization !== 'current')) fail('HISTORY_STALE');
    const cursor = action.cursor ?? history.nextCursor;
    if (!cursor) return;
    const ticket = this.projection.ticket();
    try {
      const page = await this.read('HistoryPage', 'POST', `/threads/${segment(threadId)}/history/query`, { projectId, cursor, limit: 5 });
      this.projection.appendHistory(page, ticket);
    } catch (error) {
      if (/CURSOR|HISTORY_STALE/.test(code(error))) { this.projection.invalidate(); await this.refreshSnapshot(); }
      else throw error;
    }
  }
  private async loadDetails(action: Extract<WorkspaceAction, { type: 'details' }>): Promise<void> {
    const scope = this.scope(), selection = this.selectionGeneration;
    const current = this.details;
    if (action.cursor && (!current || current.cursor !== action.cursor || current.itemId !== action.itemId || current.turnId !== action.turnId)) fail('DETAIL_CURSOR_INVALID');
    const part = await this.read('ItemDetails', 'POST', `/threads/${segment(scope.threadId!)}/history/details`, {
      projectId: scope.projectId, itemId: action.itemId, turnId: action.turnId, cursor: action.cursor,
    });
    if (selection !== this.selectionGeneration || part.epoch !== scope.epoch || part.itemId !== action.itemId || part.totalBytes > 8 * 1024 * 1024) fail('DETAIL_SCOPE_CHANGED');
    const bytes = Buffer.from(part.chunk, 'base64');
    if (part.offsetBytes !== (action.cursor ? current!.bytes.length : 0) || (action.cursor && (part.sha256 !== current!.digest || part.historyRevision !== current!.revision || part.totalBytes !== current!.total))) fail('DETAIL_INTEGRITY_FAILED');
    const accumulated = action.cursor ? Buffer.concat([current!.bytes, bytes]) : bytes;
    if (accumulated.length > part.totalBytes) fail('DETAIL_INTEGRITY_FAILED');
    this.details = { itemId: action.itemId, turnId: action.turnId, revision: part.historyRevision, digest: part.sha256, total: part.totalBytes, bytes: accumulated, cursor: part.nextCursor ?? undefined };
    if (part.complete) {
      if (accumulated.length !== part.totalBytes || createHash('sha256').update(accumulated).digest('hex') !== part.sha256) fail('DETAIL_INTEGRITY_FAILED');
      const item: unknown = JSON.parse(accumulated.toString('utf8'));
      if (!record(item) || item.id !== action.itemId) fail('DETAIL_INTEGRITY_FAILED');
      this.value.itemDetails = { itemId: action.itemId, turnId: action.turnId, text: JSON.stringify(item, null, 2), complete: true };
    } else this.value.itemDetails = { itemId: action.itemId, turnId: action.turnId, text: `已校验接收 ${accumulated.length} / ${part.totalBytes} bytes；完整摘要通过后显示内容。`, complete: false, nextCursor: part.nextCursor ?? undefined };
  }

  async action(raw: unknown): Promise<WorkspaceState> {
    const action = parseWorkspaceAction(raw);
    if (this.value.busy) fail('ACTION_IN_PROGRESS');
    const draftIdentity = this.transport.identity ?? this.lastIdentity;
    this.value.busy = true; this.value.notice = undefined; this.emit();
    try { await this.perform(action); }
    catch (error) {
      this.value.notice = code(error);
      if (['connect', 'pair', 'reconnect'].includes(action.type) || ['DEVICE_REVOKED', 'UNAUTHENTICATED'].includes(code(error))) this.connectionError(error);
    } finally { this.value.busy = false; this.emit(); }
    const state = this.state();
    if (['send', 'steer', 'checkDraft'].includes(action.type) && 'clientDraftId' in action && action.clientDraftId && action.draftRevision) {
      try {
        const entries = draftIdentity ? this.journal.list(draftIdentity) : [];
        if ((draftIdentity || action.type !== 'checkDraft') && !this.journalFailed && !entries.some(row => row.clientDraftId === action.clientDraftId && row.draftRevision === action.draftRevision)) {
          state.draftDispatch = { clientDraftId: action.clientDraftId, draftRevision: action.draftRevision, status: 'not-dispatched' };
        }
      } catch { /* No negative proof is issued if the durable journal cannot be read. */ }
    }
    return state;
  }
  private async perform(action: WorkspaceAction): Promise<void> {
    if (action.type === 'connect') { await this.connect(action.endpoint); return; }
    if (action.type === 'pair') {
      const result = await this.transport.pair(action.code, action.label);
      await this.connect(result.endpoint); return;
    }
    if (action.type === 'disconnect') { this.connectionPreferences?.save(this.value.connection.endpoint, false); this.manualOffline = true; this.stopConnection(); this.value.connection.status = 'offline'; return; }
    if (action.type === 'reconnect') { await this.connect(this.value.connection.endpoint, true); return; }
    if (action.type === 'checkDraft') return; // Read-only journal proof is attached by action(), including offline.
    this.online();
    if (action.type === 'reconcile') { await this.reconcile(); await this.refreshSnapshot(); return; }
    if (action.type === 'logout') {
      this.connectionPreferences?.save(this.value.connection.endpoint, false, true);
      try { await this.write('auth.logout', '/auth/logout', {}, this.scope(false, false)); }
      finally {
        this.manualOffline = true; this.stopConnection(); this.value.connection.status = 'revoked'; this.clearIdentityDisplay();
      }
      return;
    }
    if (action.type === 'refresh') { await this.reconcile(); await this.loadProjects(); if (this.value.projectId) await this.loadThreads(false); await this.refreshSnapshot(); return; }
    if (action.type === 'selectProject') { await this.selectProject(action.projectId); return; }
    if (action.type === 'directories') {
      this.value.directories = await this.read('DirectoryPage', 'POST', '/project-directories/query', { rootId: action.rootId, path: action.path ?? '', cursor: action.cursor, limit: 50 }); return;
    }
    if (action.type === 'registerProject') {
      this.capability('projects'); await this.write('project.register', '/projects', { rootId: action.rootId, path: action.path }, this.scope(false, false)); await this.loadProjects(); return;
    }
    if (action.type === 'unregisterProject') {
      this.capability('projects');
      if (!this.value.projects.some(item => item.id === action.projectId)) fail('PROJECT_UNAVAILABLE');
      await this.write('project.unregister', `/projects/${segment(action.projectId)}`, {}, { ...this.scope(false, false), projectId: action.projectId }, 'DELETE'); await this.loadProjects(); return;
    }
    if (action.type === 'threads') {
      if (!action.more) { this.search = action.search ?? ''; this.archived = action.archived ?? false; }
      await this.loadThreads(action.more ?? false); return;
    }
    if (action.type === 'selectThread') { await this.selectThread(action.threadId); return; }
    if (action.type === 'startThread') {
      this.capability('thread.start'); const scope = this.scope(true, false);
      const receipt = await this.write('thread.start', `/projects/${segment(scope.projectId!)}/threads`, { expectedEpoch: scope.epoch, ...this.settings(action) }, scope);
      await this.loadThreads(false);
      if (receipt.status === 'accepted' && receipt.nativeThreadId) await this.selectThread(receipt.nativeThreadId, true); return;
    }
    if (action.type === 'historyMore') { await this.historyMore(action); return; }
    if (action.type === 'details') { await this.loadDetails(action); return; }
    if (action.type === 'inspector') {
      if (action.section === 'extensions') this.value.extensions = await this.read('ExtensionsSnapshot', 'GET', `/projects/${segment(this.scope(true, false).projectId!)}/extensions`);
      else {
        const results = await Promise.allSettled([this.read('AccountRateLimits', 'GET', '/account/rate-limits'), this.read('AccountUsage', 'GET', '/account/usage')]);
        if (results[0].status === 'fulfilled') this.value.rateLimits = results[0].value;
        if (results[1].status === 'fulfilled') this.value.accountUsage = results[1].value;
        if (results.some(result => result.status === 'rejected')) this.value.notice = 'USAGE_PARTIALLY_UNAVAILABLE';
      } return;
    }
    if (action.type === 'files') {
      const projectId = this.value.projectId ?? fail('PROJECT_REQUIRED'); this.capability('files');
      const page = await this.read('FilePage', 'POST', `/projects/${segment(projectId)}/files/query`, { path: action.path ?? '', limit: 50, cursor: action.more ? this.value.files?.nextCursor : undefined });
      this.value.files = action.more && this.value.files ? { ...page, entries: [...this.value.files.entries, ...page.entries] } : page; return;
    }
    if (action.type === 'previewFile' || action.type === 'downloadFile') {
      const scope = this.scope(true, false), selection = this.selectionGeneration; this.capability('files');
      const grant = await this.read('FileGrant', 'POST', `/projects/${segment(scope.projectId!)}/files/select`, { path: action.path, threadId: this.value.threadId });
      if (grant.projectId !== scope.projectId || grant.path !== action.path || grant.threadId && grant.threadId !== this.value.threadId) fail('FILE_SCOPE_MISMATCH');
      const result = await this.transport.requestBytes('GET', `/files/${segment(grant.fileId)}/content`);
      if (selection !== this.selectionGeneration || scope.epoch !== this.value.connection.epoch) fail('FILE_SCOPE_CHANGED');
      const bytes = verifyDownload(grant, result);
      if (action.type === 'previewFile') this.value.preview = filePreview(grant, bytes);
      else if (await saveDownload(this.dialogs, grant, bytes)) this.value.notice = 'DOWNLOAD_SAVED'; return;
    }
    if (action.type === 'upload') { await this.upload(); return; }
    const scope = this.scope(), common = { projectId: scope.projectId, expectedEpoch: scope.epoch };
    if (action.type === 'removeAttachment') {
      this.capability('attachments');
      const attachment = this.value.attachments.find(item => item.id === action.attachmentId && item.draftId === this.value.draftId);
      if (!attachment || attachment.state !== 'ready') fail('ATTACHMENT_NOT_READY');
      const result = await this.write('attachment.remove', `/attachments/${segment(action.attachmentId)}`, { projectId: scope.projectId, threadId: scope.threadId, draftId: this.value.draftId }, scope, 'DELETE');
      if (result.status === 'accepted') this.attachmentFacts.delete(action.attachmentId); return;
    }
    if (action.type === 'resumeThread') {
      this.capability('thread.resume');
      await this.write('thread.resume', `/threads/${segment(scope.threadId!)}/resume`, common, scope); await this.refreshSnapshot(); return;
    }
    if (action.type === 'answer') {
      this.capability('interactions');
      const interaction = this.value.interactions.find(item => item.interactionId === action.interactionId) ?? fail('INTERACTION_STALE');
      validateInteractionAnswer(interaction, action, this.fileContexts.forInteraction(interaction));
      assertApprovalVisible(action, interaction.request, interaction.kind, this.projectRoots.get(interaction.projectId));
      if (interaction.epoch !== scope.epoch || interaction.projectId !== scope.projectId || interaction.threadId !== scope.threadId) fail('INTERACTION_STALE');
      await this.write('interaction.respond', `/interactions/${segment(action.interactionId)}/response`, { projectId: scope.projectId, epoch: action.epoch, generation: action.generation, response: action.response }, scope, 'POST', undefined, action.contextDigest);
      await this.refreshSnapshot(); return;
    }
    if (action.type === 'interrupt' || action.type === 'steer') {
      this.capability(action.type === 'interrupt' ? 'turn.interrupt' : 'turn.steer');
      if (action.type === 'steer') this.writableThread();
      const turnId = this.value.activeTurnId ?? fail('ACTIVE_TURN_REQUIRED');
      await this.write(action.type === 'interrupt' ? 'turn.interrupt' : 'turn.steer', `/threads/${segment(scope.threadId!)}/turns/${segment(turnId)}/${action.type === 'interrupt' ? 'interrupt' : 'steer'}`,
        { ...common, ...(action.type === 'steer' ? { input: [{ type: 'text', text: action.text }] } : {}) }, scope, 'POST', undefined, undefined,
        action.type === 'steer' && action.clientDraftId ? { clientDraftId: action.clientDraftId, draftRevision: action.draftRevision! } : undefined);
      this.scheduleSnapshot(); return;
    }
    if (action.type === 'send') {
      this.ready(); this.writableThread(); this.capability('turn.start');
      if (this.value.activeTurnId) fail('TURN_ACTIVE');
      const attachments = this.value.attachments.filter(item => item.draftId === this.value.draftId);
      if (attachments.some(item => item.state !== 'ready')) fail('ATTACHMENT_NOT_READY');
      const result = await this.write('turn.start', `/threads/${segment(scope.threadId!)}/turns`, { ...common, input: [{ type: 'text', text: action.text }], ...this.settings(action),
        ...(attachments.length ? { attachmentIds: attachments.map(item => item.id), draftId: this.value.draftId } : {}) }, scope, 'POST', undefined, undefined,
        action.clientDraftId ? { clientDraftId: action.clientDraftId, draftRevision: action.draftRevision! } : undefined);
      if (result.status === 'accepted') { this.value.draftId = randomUUID(); this.attachmentFacts.clear(); }
      this.projection.invalidate(); this.scheduleSnapshot(100); return;
    }
    if (action.type === 'threadMutation') {
      this.ready(); this.capability(action.action === 'name' ? 'thread.name.set' : `thread.${action.action}`);
      if (action.action === 'archive' || action.action === 'unarchive') this.writableThread(action.action === 'unarchive');
      if (this.value.activeTurnId) fail('TURN_ACTIVE');
      const payload = { ...common, ...(action.action === 'name' ? { name: action.name } : {}), ...(action.action === 'delete' ? { confirm: action.confirm } : {}), ...(action.action === 'revert' ? { beforeTurnId: action.beforeTurnId } : {}) };
      const receipt = await this.write(`thread.${action.action}`, `/threads/${segment(scope.threadId!)}${action.action === 'delete' ? '' : `/${action.action}`}`, payload, scope, action.action === 'delete' ? 'DELETE' : 'POST');
      if (receipt.status === 'accepted' && action.action === 'fork' && receipt.nativeThreadId) await this.selectThread(receipt.nativeThreadId);
      else if (receipt.status === 'accepted' && ['delete', 'archive'].includes(action.action)) await this.selectProject(scope.projectId!);
      else await this.refreshSnapshot();
      await this.loadThreads(false); return;
    }
  }
  private settings(action: { model?: string; effort?: string; permissionPreset?: Preset }): Record<string, string> {
    if (action.model && !this.value.models?.data.some(model => model.model === action.model || model.id === action.model)) fail('MODEL_UNAVAILABLE');
    const model = this.value.models?.data.find(item => item.model === action.model || item.id === action.model);
    if (action.effort && model && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === action.effort)) fail('EFFORT_UNAVAILABLE');
    return { ...(action.model ? { model: action.model } : {}), ...(action.effort ? { effort: action.effort } : {}), ...(action.permissionPreset ? { permissionPreset: action.permissionPreset } : {}) };
  }
  private async upload(): Promise<void> {
    this.ready(); this.writableThread(); this.capability('attachments');
    const scope = this.scope(), generation = this.selectionGeneration;
    const limits = this.value.capabilities!.limits;
    const upload = await selectLocalUpload(this.dialogs, limits.attachmentFileBytes);
    if (!upload) return;
    if (generation !== this.selectionGeneration) fail('SCOPE_CHANGED'); this.ready();
    const draftAttachments = this.value.attachments.filter(item => item.draftId === this.value.draftId);
    if (draftAttachments.length >= limits.attachmentBatchCount || draftAttachments.reduce((total, item) => total + item.size, upload.bytes.length) > limits.attachmentBatchBytes) fail('ATTACHMENT_BATCH_LIMIT');
    const metadata = { projectId: scope.projectId, threadId: scope.threadId, draftId: this.value.draftId, name: upload.name, mime: upload.mime, size: upload.bytes.length };
    const receipt = await this.write('attachment.upload', `/threads/${segment(scope.threadId!)}/attachments`, { ...metadata, digest: upload.digest }, scope, 'POST', async (operationId, beforeDispatch) => {
      const result = await this.transport.requestBytes('POST', `/threads/${segment(scope.threadId!)}/attachments`, { body: upload.bytes,
        headers: { 'X-Oraculum-Upload': Buffer.from(JSON.stringify({ ...metadata, operationId })).toString('base64url') }, beforeDispatch });
      return JSON.parse(result.bytes.toString('utf8'));
    });
    const row = this.journal.list(this.identity()).find(item => item.operationId === receipt.operationId)!;
    await this.reconcileOne(row);
  }
}
