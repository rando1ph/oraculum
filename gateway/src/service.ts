import { randomUUID } from 'node:crypto';
import gatewayRelease from '../../packaging/gateway/metadata.json';
import type { Readable } from 'node:stream';
import { GatewayStore, GatewayError, type Operation } from './store';
import type { GatewayConfig } from './config';
import { GatewayAuth } from './auth';
import { ProjectRegistry, HostFileError } from './projects';
import { FileService } from './files';
import { AttachmentStore, type AttachmentOwner, type AttachmentRow } from './attachments';
import { CodexAdapter, CodexError, record, type NativeThread, type NativeNotification, type NativeRequest } from './codex';
import { NativeHistory, nativeItemTiming, projectItem } from './history';
import { Interactions, InteractionError, type Interaction, type InteractionResponse } from './interactions';
import { extensionSection } from './extensions';
import { permissionReadback, type PermissionReadback } from './permission-readback';
import { EventFeeds, type EventInput } from './events';
import { PROTOCOL, type ThreadStartRequest, type ThreadResumeRequest, type TurnStartRequest, type TurnInterruptRequest, type InteractionResponseRequest, type HistoryQuery, type AttachmentUploadMetadata, type AttachmentDeleteRequest } from '../../packages/gateway-protocol/src/index';
export type Authorized = {
    deviceId: string;
    check: () => void;
};
export type ServiceOptions = {
    codexVersion?: string;
    auth?: GatewayAuth;
};
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const receipt = (op: Operation) => clean({ operationId: op.operationId, status: op.status,
    nativeThreadId: op.nativeThreadId ?? undefined, nativeTurnId: op.nativeTurnId ?? undefined, errorCode: op.errorCode ?? undefined });
const fail = (code: string, status: number, message: string): never => { throw new GatewayError(code, status, message); };
/** Coordinates delivery and host authorization; all execution remains inside Codex App Server. */
export class GatewayService {
    epoch = randomUUID();
    readonly auth: GatewayAuth;
    readonly projects: ProjectRegistry;
    readonly files: FileService;
    readonly attachments: AttachmentStore;
    readonly feeds: EventFeeds;
    history: NativeHistory;
    interactions: Interactions;
    private readonly threads = new Map<string, string>();
    private readonly activeTurns = new Map<string, string>();
    private readonly observed = new Set<string>();
    private readonly permissions = new Map<string, PermissionReadback>();
    private extensionReads = 0;
    private readonly answers = new Map<string, {
        operationId: string;
        deviceId: string;
    }>();
    private readonly feedDevices = new Set<string>();
    private readonly threadCursors = new Map<string, {
        deviceId: string;
        projectId: string;
        search?: string;
        archived?: boolean;
        native: string;
        expires: number;
        epoch: string;
    }>();
    private eventQueue = Promise.resolve();
    private queuedEvents = 0;
    private queuedBytes = 0;
    private closing = false;
    constructor(readonly store: GatewayStore, readonly config: GatewayConfig, readonly codex: CodexAdapter, private readonly options: ServiceOptions = {}) {
        this.auth = options.auth ?? new GatewayAuth(store);
        this.projects = new ProjectRegistry(store, config);
        this.files = new FileService(this.projects);
        this.attachments = new AttachmentStore(store, this.projects);
        this.feeds = new EventFeeds(store.installationId, this.epoch);
        this.history = new NativeHistory(codex, { epoch: this.epoch });
        this.interactions = this.newInteractions();
        codex.on('notification', (message: NativeNotification) => this.enqueue(() => this.notification(message), undefined, Buffer.byteLength(JSON.stringify(message))));
        codex.on('request', (request: NativeRequest) => this.enqueue(() => this.nativeRequest(request), request, Buffer.byteLength(JSON.stringify(request))));
        codex.on('unavailable', () => this.invalidateConnection());
    }
    private newInteractions() {
        const interactions = new Interactions(this.codex, { epoch: this.epoch });
        interactions.on('changed', (interaction: Interaction) => this.enqueue(async () => {
            await this.projects.validate(interaction.projectId);
        if(interaction.status==='pending')this.observed.add('interactions');
            const answer = this.answers.get(interaction.interactionId);
            if (interaction.status === 'resolved' && answer) {
                const op = this.store.getOperation(answer.operationId, answer.deviceId);
                if (op?.status === 'unknown') {
                    this.store.finishOperation(answer.operationId, 'accepted', { nativeThreadId: interaction.threadId });
                    this.operationChanged({ deviceId: answer.deviceId, check: () => { } }, answer.operationId);
                }
                this.answers.delete(interaction.interactionId);
            }
            this.broadcast({ kind: interaction.status === 'pending' ? 'interaction.opened' : 'interaction.resolved', impact: 'state',
                scope: { projectId: interaction.projectId, threadId: interaction.threadId }, payload: interaction });
        }, undefined, Buffer.byteLength(JSON.stringify(interaction))));
        return interactions;
    }
    private enqueue(work: () => Promise<void>, request?: NativeRequest, bytes = 1024) {
        if (this.closing)
            return;
        if (this.queuedEvents >= 256 || this.queuedBytes + bytes > 2 * 1024 * 1024) {
            if (request)
                void this.codex.rejectRequest(request.id, 'Gateway event capacity exhausted').catch(() => { });
            void this.codex.close();
            return;
        }
        const epoch = this.epoch;
        this.queuedEvents++;
        this.queuedBytes += bytes;
        this.eventQueue = this.eventQueue.then(async () => { if (epoch === this.epoch)
            await work(); })
            .catch(() => { if (request)
            void this.codex.rejectRequest(request.id, 'Native interaction authorization failed').catch(() => { }); })
            .finally(() => { this.queuedEvents--; this.queuedBytes -= bytes; });
    }
    async settled() { let pending: Promise<void>; do {
        pending = this.eventQueue;
        await pending;
    } while (pending !== this.eventQueue); }
    private invalidateConnection() {
        this.epoch = randomUUID();
        this.history.clear();
        this.history = new NativeHistory(this.codex, { epoch: this.epoch });
        this.interactions.removeAllListeners();
        this.interactions.clear();
        this.interactions = this.newInteractions();
        this.threads.clear();
        this.activeTurns.clear();
        this.threadCursors.clear();
        this.observed.clear();
        this.permissions.clear();
        this.answers.clear();
        this.feeds.reset(this.epoch);
    }
    observe(deviceId: string) {
        this.feeds.ensure(deviceId);
        this.feedDevices.add(deviceId);
        // Keep only the feed budget, not one permanent entry for every paired device.
        while (this.feedDevices.size > 128)
            this.feedDevices.delete(this.feedDevices.values().next().value!);
    }
    private broadcast(event: EventInput, owner?: string) {
        for (const id of this.feedDevices) {
            const device = this.store.getDevice(id);
            if (!device || device.revokedAt !== null) {
                this.feeds.drop(id);
                this.feedDevices.delete(id);
                continue;
            }
            if (owner && owner !== id)
                continue;
            try {
                this.feeds.publish(id, event);
            }
            catch {
                this.feedDevices.delete(id);
            }
        }
    }
    private async notification(message: NativeNotification) {
        const p = message.params;
        if(message.method==='gateway/unsupportedNativeEvent'&&typeof p.threadId!=='string'){
            this.permissions.clear();this.history.clear();this.broadcast({kind:'history.invalidated',impact:'state',scope:{},payload:{reasonCode:'UNSUPPORTED_NATIVE_EVENT'}});return;
        }
        if (message.method === 'thread/started' && record(p.thread) && typeof p.thread.id === 'string' && typeof p.thread.cwd === 'string') {
            const project = this.store.listProjects().find(project => project.canonicalPath === (p.thread as Record<string, unknown>).cwd);
            if (project) {
                await this.projects.validate(project.id);
                this.remember(p.thread.id, project.id);
            }
        }
        const threadId = typeof p.threadId === 'string' ? p.threadId : record(p.thread) && typeof p.thread.id === 'string' ? p.thread.id : undefined;
        const projectId = threadId && this.threads.get(threadId);
        if (!threadId || !projectId)
            return;
        await this.projects.validate(projectId);
        if(message.method==='gateway/unsupportedNativeEvent'||((message.method==='item/started'||message.method==='item/completed')&&record(p.item)&&p.item.type==='contextCompaction')){
            this.permissions.delete(threadId);
            this.history.invalidate(threadId);this.broadcast({kind:'history.invalidated',impact:'state',scope:{projectId,threadId},payload:{reasonCode:message.method==='gateway/unsupportedNativeEvent'?'UNSUPPORTED_NATIVE_EVENT':'NATIVE_COMPACTION'}});
            if(message.method==='gateway/unsupportedNativeEvent')return;
        }
        const scope = { projectId, threadId, ...(typeof p.turnId === 'string' ? { turnId: p.turnId } : {}), ...(typeof p.itemId === 'string' ? { itemId: p.itemId } : {}) };
        if (message.method === 'turn/started' && record(p.turn) && typeof p.turn.id === 'string')
            this.activeTurns.set(threadId, p.turn.id);
        if (message.method === 'turn/started' || /thread\/(?:archived|unarchived|closed|deleted)/.test(message.method) ||
            (message.method === 'thread/status/changed' && record(p.status) && p.status.type === 'notLoaded'))
            this.permissions.delete(threadId);
        if (message.method === 'turn/completed') {
            if (record(p.turn) && this.activeTurns.get(threadId) === p.turn.id)
                this.activeTurns.delete(threadId);
            this.history.invalidate(threadId);
        }
        if (message.method === 'serverRequest/resolved' && (typeof p.requestId === 'number' || typeof p.requestId === 'string'))
            this.interactions.resolve(p.requestId, threadId);
        if (/thread\/(?:archived|unarchived|closed|deleted)|contextCompacted|compaction/i.test(message.method))
            this.history.invalidate(threadId);
        if (message.method === 'item/agentMessage/delta' || message.method === 'item/reasoning/textDelta' || message.method === 'item/commandExecution/outputDelta') {
            if (typeof p.delta === 'string')
                this.broadcast({ kind: 'item.delta', impact: 'state', scope,
                    payload: { delta: p.delta, nativeMethod: message.method } });
        }
        else if ((message.method === 'item/completed' || message.method === 'item/started') && record(p.item) && typeof p.item.id === 'string' && typeof p.item.type === 'string') {
            const projected = projectItem(p.item as {
                id: string;
                type: string;
            });
            this.broadcast({ kind: message.method === 'item/completed' ? 'item.completed' : 'item.started', impact: 'state', scope: { ...scope, itemId: p.item.id },
                payload: { item: { id: p.item.id, type: p.item.type, data: projected.item, truncated: projected.truncated, detailsAvailable: projected.truncated }, complete: !projected.truncated, ...nativeItemTiming(p) } });
        }
        else if (/^(turn\/|thread\/|serverRequest\/)/.test(message.method)) {
            const projected = projectItem({ ...p, id: threadId, type: message.method });
            this.broadcast({ kind: 'native.state', impact: 'state', scope, payload: { method: message.method, data: projected.item, truncated: projected.truncated } });
        }
    }
    private async nativeRequest(request: NativeRequest) {
        const threadId = typeof request.params.threadId === 'string' ? request.params.threadId : undefined;
        const projectId = threadId && this.threads.get(threadId);
        if (projectId)
            await this.projects.validate(projectId);
        await this.interactions.receive(request, projectId || null);
    }
    private remember(threadId: string, projectId: string) {
        this.threads.set(threadId, projectId);
        if (this.threads.size > 1024) {
            const oldest = this.threads.keys().next().value!;
            this.threads.delete(oldest);
            this.activeTurns.delete(oldest);
            this.permissions.delete(oldest);
        }
    }
    capabilities() {
        const names = ['projects', 'files', 'attachments', 'thread.list', 'thread.read', 'thread.start', 'thread.resume', 'turn.start', 'turn.interrupt', 'history', 'interactions', 'extensions.read'];
        return { protocol: PROTOCOL, gatewayVersion: gatewayRelease.version, installationId: this.store.installationId, epoch: this.epoch,
            codex: { version: this.options.codexVersion ?? 'unknown', connectionState: this.codex.alive ? 'connected' : 'disconnected' },
            capabilities: [...names.map(name => ({ name, supported: true, availability: ['projects', 'files', 'attachments'].includes(name) || this.observed.has(name) ? 'available' : this.codex.alive ? 'unverified' : 'unavailable', maturity: ['projects', 'files', 'attachments'].includes(name) ? 'gateway' : 'default-surface', verified: ['projects', 'files', 'attachments'].includes(name) || this.observed.has(name), reasonCode: this.observed.has(name) ? 'OBSERVED' : 'AWAITING_FIRST_USER_OPERATION', observedVersion: this.options.codexVersion ?? 'unknown', epoch: this.epoch })),
                ...['plan.mode', 'plugins.catalog', 'turn.steer'].map(name => ({ name, supported: false, availability: 'unsupported', maturity: 'under-development', verified: false, reasonCode: 'NOT_IN_VERIFIED_CORE', observedVersion: this.options.codexVersion ?? 'unknown', epoch: this.epoch }))],
            limits: { attachmentFileBytes: 20 * 1024 * 1024, attachmentBatchBytes: 50 * 1024 * 1024, attachmentBatchCount: 6, eventReplayCount: 1024, historyPageItems: 20, requestBytes: 128 * 1024 } };
    }
    async requireThread(auth: Authorized, projectId: string, threadId: string) {
        auth.check();
        const project = await this.projects.validate(projectId);
        const { thread } = await this.codex.readThread(threadId);
        auth.check();
        await this.projects.validate(projectId);
        if (thread.id !== threadId || thread.cwd !== project.canonicalPath)
            fail('PROJECT_UNAVAILABLE', 403, 'Thread is outside this registered project');
        this.remember(threadId, projectId);
        this.observed.add('thread.read');
        if (thread.status.type === 'notLoaded') this.permissions.delete(threadId);
        return thread;
    }
    async extensions(auth: Authorized, projectId: string) {
        auth.check();
        const project = await this.projects.validate(projectId), epoch = this.epoch;
        if (this.extensionReads >= 2) fail('NATIVE_BUSY', 429, 'Extension read capacity exhausted');
        this.extensionReads++;
        try {
            const sections = await Promise.all((['skills', 'mcp', 'apps', 'plugins'] as const).map(kind => extensionSection(this.codex, kind, project.canonicalPath)));
            auth.check();
            await this.projects.validate(projectId);
            this.expectEpoch(epoch);
            this.observed.add('extensions.read');
            return { projectId, sections };
        } finally { this.extensionReads--; }
    }
    threadView(thread: NativeThread, projectId: string) {
        const permission = thread.status.type === 'notLoaded' ? undefined : this.permissions.get(thread.id);
        return clean({ id: thread.id, projectId, status: typeof thread.status?.type === 'string' ? thread.status.type : 'unknown',
            title: typeof thread.name === 'string' ? thread.name : undefined, preview: thread.preview?.slice(0, 4096),
            model: typeof thread.model === 'string' ? thread.model : undefined, reasoningEffort: typeof thread.reasoningEffort === 'string' ? thread.reasoningEffort : undefined,
            parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : undefined,
            permissionPreset: permission?.preset ?? undefined, permissionReadback: permission,
            createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : undefined, updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : undefined });
    }
    async listThreads(auth: Authorized, projectId: string, query: {
        limit?: number;
        cursor?: string;
        archived?: boolean;
        search?: string;
    }) {
        auth.check();
        const project = await this.projects.validate(projectId);
        let native: string | undefined;
        if (query.cursor) {
            const cursor = this.threadCursors.get(query.cursor);
            if (!cursor || cursor.deviceId !== auth.deviceId || cursor.projectId !== projectId || cursor.epoch !== this.epoch || cursor.expires < Date.now() || cursor.search !== query.search || cursor.archived !== query.archived)
                fail('CURSOR_RESET_REQUIRED', 409, 'Thread cursor is stale or outside this query');
            native = cursor!.native;
        }
        const epoch = this.epoch;
        const page = await this.codex.listThreads({ cwd: project.canonicalPath, cursor: native, limit: query.limit ?? 20, searchTerm: query.search, archived: query.archived });
        auth.check();
        await this.projects.validate(projectId);
        if (epoch !== this.epoch)
            fail('STALE_EPOCH', 409, 'Native connection changed while reading');
        let nextCursor: string | null = null;
        if (page.nextCursor) {
            nextCursor = randomUUID();
            this.threadCursors.set(nextCursor, { deviceId: auth.deviceId, projectId, native: page.nextCursor, search: query.search, archived: query.archived, expires: Date.now() + 300000, epoch });
            while (this.threadCursors.size > 256)
                this.threadCursors.delete(this.threadCursors.keys().next().value!);
        }
        this.observed.add('thread.list');
        return { threads: page.data.filter(thread => thread.cwd === project.canonicalPath).map(thread => this.threadView(thread, projectId)), nextCursor, source: 'native', truncated: false };
    }
    private expectEpoch(epoch: string) { if (epoch !== this.epoch)
        fail('STALE_EPOCH', 409, 'Refresh the current native connection before writing'); }
    private async settings(model?: string, effort?: string, nativeModel?: unknown) {
        if (!model && !effort)
            return;
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
            const result = await this.codex.listModels({ limit: 100, cursor });
            const selected = result.data.find(item => item.model === (model ?? nativeModel) || (!model && !nativeModel && item.isDefault === true));
            if (selected) {
                if (effort && !selected.supportedReasoningEfforts.some(item => item.reasoningEffort === effort))
                    fail('INVALID_REQUEST', 400, 'The selected model does not support this reasoning effort');
                return;
            }
            if (!result.nextCursor)
                break;
            cursor = result.nextCursor;
        }
        fail('CAPABILITY_UNAVAILABLE', 409, 'Requested model or reasoning effort is not available in the native catalog');
    }
    async write(auth: Authorized, input: {
        operationId: string;
        projectId?: string;
        threadId?: string;
        kind: string;
        expectedEpoch?: string;
        allowUnknown?: boolean;
        attachments?: AttachmentRow[];
    }, work: () => Promise<{
        nativeThreadId?: string;
        nativeTurnId?: string;
        awaitingNativeResolution?: boolean;
    }>) {
        auth.check();
        if (input.projectId)
            await this.projects.validate(input.projectId);
        auth.check();
        if (input.expectedEpoch)
            this.expectEpoch(input.expectedEpoch);
        this.store.transaction(() => {
            if (this.store.getOperation(input.operationId, auth.deviceId))
                fail('OPERATION_ALREADY_RECORDED', 409, 'Operation ID was already used; query its receipt');
            if (input.projectId && !input.allowUnknown && this.store.hasUnknownOperation(input.projectId, input.threadId))
                fail('OPERATION_UNKNOWN', 409, 'This project or thread has an unconfirmed operation; query native state first');
            this.store.reserveOperation({ operationId: input.operationId, deviceId: auth.deviceId, projectId: input.projectId, threadId: input.threadId, kind: input.kind });
            if (input.attachments)
                this.attachments.claim(input.attachments, input.operationId);
        });
        let result: {
            nativeThreadId?: string;
            nativeTurnId?: string;
            awaitingNativeResolution?: boolean;
        };
        try {
            result = await work();
        }
        catch (error) {
            const rejected = error instanceof CodexError ? error.outcome === 'rejected' : error instanceof GatewayError || error instanceof HostFileError || error instanceof InteractionError;
            const code = record(error) && typeof error.code === 'string' ? error.code : 'DELIVERY_UNKNOWN';
            if (this.store.getOperation(input.operationId, auth.deviceId)?.status !== 'unknown')
                return this.operationChanged(auth, input.operationId);
            this.store.transaction(() => {
                this.store.finishOperation(input.operationId, rejected ? 'rejected' : 'unknown', { errorCode: code });
                if (rejected)
                    this.attachments.rejected(input.operationId);
                else
                    this.attachments.unknown(input.operationId);
            });
            return this.operationChanged(auth, input.operationId);
        }
        if(this.store.getOperation(input.operationId,auth.deviceId)?.status!=='unknown')return this.operationChanged(auth,input.operationId);
        this.store.transaction(() => { this.store.finishOperation(input.operationId, result.awaitingNativeResolution ? 'unknown' : 'accepted', result); if (result.nativeTurnId && !result.awaitingNativeResolution)
            this.attachments.accepted(input.operationId, result.nativeTurnId); });
        this.observed.add(input.kind);
        return this.operationChanged(auth, input.operationId);
    }
    private operationChanged(auth: Authorized, id: string) {
        const operation = this.store.getOperation(id, auth.deviceId)!;
        this.broadcast({ kind: 'operation.changed', impact: 'state', scope: clean({ projectId: operation.projectId ?? undefined, threadId: operation.threadId ?? undefined }), payload: receipt(operation) }, auth.deviceId);
        return receipt(operation);
    }
    async startThread(auth: Authorized, projectId: string, input: ThreadStartRequest) {
        const project = await this.projects.validate(projectId);
        await this.settings(input.model);
        return this.write(auth, { ...input, projectId, kind: 'thread.start' }, async () => {
            const result = await this.codex.startThread({ cwd: project.canonicalPath, model: input.model, permissionPreset: input.permissionPreset });
            if (result.thread.cwd !== project.canonicalPath)
                throw new CodexError('NATIVE_PROTOCOL', 'New thread project does not match authorization', 'unknown');
            this.remember(result.thread.id, projectId);
            const permission = permissionReadback(result, 'thread.start', project.canonicalPath);
            if (permission && input.expectedEpoch === this.epoch) this.permissions.set(result.thread.id, permission);
            return { nativeThreadId: result.thread.id };
        });
    }
    async resumeThread(auth: Authorized, threadId: string, input: ThreadResumeRequest) {
        await this.requireThread(auth, input.projectId, threadId);
        return this.write(auth, { ...input, threadId, kind: 'thread.resume' }, async () => {
            const result = await this.codex.resumeThread(threadId);
            if (result.thread.id !== threadId || result.thread.cwd !== this.projects.get(input.projectId).canonicalPath)
                throw new CodexError('NATIVE_PROTOCOL', 'Resumed thread project changed', 'unknown');
            const permission = permissionReadback(result, 'thread.resume', result.thread.cwd);
            if (permission && input.expectedEpoch === this.epoch) this.permissions.set(threadId, permission);
            else this.permissions.delete(threadId);
            return { nativeThreadId: result.thread.id };
        });
    }
    owner(auth: Authorized, projectId: string, threadId: string, draftId: string): AttachmentOwner {
        const epoch = this.epoch;
        return { deviceId: auth.deviceId, projectId, threadId, draftId, authorized: () => { try {
                auth.check();
                return true;
            }
            catch {
                return false;
            } }, validate: async () => { this.expectEpoch(epoch); auth.check(); await this.projects.validate(projectId); } };
    }
    async startTurn(auth: Authorized, threadId: string, input: TurnStartRequest) {
        const thread = await this.requireThread(auth, input.projectId, threadId);
        await this.settings(input.model, input.effort, thread.model);
        const prepared = await this.attachments.prepare(input.attachmentIds ?? [], this.owner(auth, input.projectId, threadId, input.draftId ?? ''));
        const nativeInput = [...input.input.map(item => ({ type: 'text' as const, text: item.text })), ...prepared.input];
        if (prepared.referenceText)
            nativeInput.push({ type: 'text', text: prepared.referenceText });
        return this.write(auth, { ...input, threadId, kind: 'turn.start', attachments: prepared.rows }, async () => {
            this.permissions.delete(threadId);
            const result = await this.codex.startTurn({ threadId, input: nativeInput, model: input.model, effort: input.effort, permissionPreset: input.permissionPreset, clientUserMessageId: input.operationId });
            this.activeTurns.set(threadId, result.turn.id);
            return { nativeThreadId: threadId, nativeTurnId: result.turn.id };
        });
    }
    async interrupt(auth: Authorized, threadId: string, turnId: string, input: TurnInterruptRequest) {
        await this.requireThread(auth, input.projectId, threadId);
        await this.settled();
        if (this.activeTurns.get(threadId) !== turnId)
            fail('TURN_NOT_ACTIVE', 409, 'Interrupt requires a currently observed native turn');
        return this.write(auth, { ...input, threadId, kind: 'turn.interrupt', allowUnknown: true }, async () => { await this.codex.interruptTurn(threadId, turnId); return { nativeThreadId: threadId, nativeTurnId: turnId }; });
    }
    async answer(auth: Authorized, interactionId: string, input: InteractionResponseRequest) {
        const interaction = this.interactions.get(interactionId);
        if (!interaction || interaction.projectId !== input.projectId)
            fail('INTERACTION_STALE', 409, 'Interaction is unavailable');
        await this.requireThread(auth, input.projectId, interaction!.threadId);
        return this.write(auth, { ...input, threadId: interaction!.threadId, expectedEpoch: input.epoch, kind: 'interaction.respond', allowUnknown: true }, async () => {
            const current = this.interactions.get(interactionId);
            if (!current || current.status !== 'pending' || current.generation !== input.generation || current.epoch !== input.epoch)
                throw new InteractionError('INTERACTION_STALE', 'Interaction was already answered or is stale');
            this.answers.set(interactionId, { operationId: input.operationId, deviceId: auth.deviceId });
            try {
                await this.interactions.respond({ ...input, interactionId, response: input.response as InteractionResponse }, { deviceId: auth.deviceId, projectId: input.projectId, threadId: interaction!.threadId });
            }
            catch (error) {
                if (error instanceof InteractionError)
                    this.answers.delete(interactionId);
                throw error;
            }
            // Native JSON-RPC server responses have no ACK. Delivery into stdin is not native acceptance.
            return { nativeThreadId: interaction!.threadId, awaitingNativeResolution: true };
        });
    }
    async historyPage(auth: Authorized, threadId: string, input: HistoryQuery) {
        await this.requireThread(auth, input.projectId, threadId);
        const epoch = this.epoch;
        const page = input.turnId ? await this.history.items(threadId, input.turnId, { cursor: input.cursor ?? undefined, scope: `${auth.deviceId}:${input.projectId}` })
            : await this.history.turns(threadId, { cursor: input.cursor ?? undefined, limit: input.limit, scope: `${auth.deviceId}:${input.projectId}` });
        auth.check();
        await this.projects.validate(input.projectId);
        if (epoch !== this.epoch)
            fail('STALE_EPOCH', 409, 'Native connection changed while reading');
        this.observed.add('history');
        return { epoch, historyRevision: page.revision, source: page.source === 'native-read' ? 'native-read-projection' : 'native-pagination', items: page.data,
            nextCursor: page.nextCursor, ...(page.itemCursors ? { itemCursors: page.itemCursors } : {}),
            ...(page.itemTimings ? { itemTimings: page.itemTimings } : {}), complete: page.complete, truncated: page.truncated };
    }
    async itemDetails(auth: Authorized, threadId: string, input: {
        projectId: string;
        turnId: string;
        itemId: string;
        cursor?: string | null;
    }) {
        await this.requireThread(auth, input.projectId, threadId);
        const epoch = this.epoch;
        const result = await this.history.details(threadId, input.turnId, input.itemId, { scope: `${auth.deviceId}:${input.projectId}`, cursor: input.cursor ?? undefined });
        auth.check();
        await this.projects.validate(input.projectId);
        this.expectEpoch(epoch);
        return result;
    }
    async snapshot(auth: Authorized, threadId: string, projectId: string) {
        this.observe(auth.deviceId);
        const observedStartSeq = this.feeds.head(auth.deviceId);
        const epoch = this.epoch;
        const thread = await this.requireThread(auth, projectId, threadId);
        const history = await this.historyPage(auth, threadId, { projectId, limit: 5 });
        await this.settled();
        auth.check();
        if (epoch !== this.epoch)
            fail('STALE_EPOCH', 409, 'Native connection changed while reading');
        const operations = (this.store.db.prepare('SELECT operation_id FROM operations WHERE device_id=? AND project_id=? AND (thread_id=? OR thread_id IS NULL) ORDER BY created_at DESC LIMIT 100').all(auth.deviceId, projectId, threadId) as {
            operation_id: string;
        }[]).map(row => receipt(this.store.getOperation(row.operation_id, auth.deviceId)!));
        const scopeChanged = this.feeds.hasChangesSince(auth.deviceId, { epoch, afterSeq: observedStartSeq }, { projectId, threadId });
        // NativeHistory preserves validated Turn IDs/status independently of bounded Item text.
        // A shortened output preview remains incomplete history, not uncertain execution state.
        return { epoch, thread: this.threadView(thread, projectId), history, observedStartSeq, observedEndSeq: this.feeds.head(auth.deviceId),
            synchronization: this.activeTurns.has(threadId) || thread.status.type === 'active' || history.items.some(turn => record(turn) && turn.status === 'inProgress') || scopeChanged ? 'synchronizing' : 'current', interactions: this.interactions.list(projectId, threadId), operations };
    }
    async upload(auth: Authorized, input: AttachmentUploadMetadata, stream: Readable) {
        await this.requireThread(auth, input.projectId, input.threadId);
        return this.write(auth, { ...input, kind: 'attachment.upload', allowUnknown: true }, async () => {
            await this.attachments.upload(input, stream, this.owner(auth, input.projectId, input.threadId, input.draftId));
            return {};
        });
    }
    async removeAttachment(auth: Authorized, attachmentId: string, input: AttachmentDeleteRequest) {
        await this.requireThread(auth, input.projectId, input.threadId);
        return this.write(auth, { ...input, kind: 'attachment.delete', allowUnknown: true }, async () => { await this.attachments.remove(attachmentId, this.owner(auth, input.projectId, input.threadId, input.draftId)); return {}; });
    }
    async close() { this.closing = true; await this.codex.close(); await this.eventQueue; }
}
