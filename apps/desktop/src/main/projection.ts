import { validateContract, type EventEnvelope, type HistoryPage, type Interaction, type NativeItem, type OperationReceipt, type Snapshot, type Thread } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceState } from '../contracts/workspace';

export type ProjectionView = Pick<WorkspaceState, 'projectId' | 'threadId' | 'thread' | 'history' | 'streamItems' | 'interactions' | 'synchronization' | 'activeTurnId' | 'plan' | 'diff' | 'tokenUsage'>;
export interface ProjectionTicket { generation: number; version: number }
export interface EventResult { resynchronize: boolean; reconnect?: boolean; operation?: OperationReceipt; projectChanged?: boolean }
export interface ConnectionResult { reset: boolean; replay: boolean; reconnect?: boolean }
type RecordValue = Record<string, unknown>;
type NativeTurn = RecordValue & { id: string; status: string; items: NativeItem[] };
type ItemState = { turnId: string; item: NativeItem; terminal: boolean; appendable: boolean; baseline?: NativeItem; stream: string };
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEM_BYTES = 256 * 1024;
const MAX_ITEMS = 1000;
const terminal = (status: unknown) => ['completed', 'failed', 'interrupted', 'declined', 'cancelled'].includes(String(status));
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const itemKey = (turn: string, item: string) => JSON.stringify([turn, item]);
const copy = <T>(value: T): T => structuredClone(value);
function bounded(value: unknown, bytes = MAX_BYTES): boolean {
  try { return Buffer.byteLength(JSON.stringify(value)) <= bytes; } catch { return false; }
}
function nativeItem(value: unknown): value is NativeItem {
  return record(value) && identifier(value.id) && identifier(value.type) && bounded(value, MAX_ITEM_BYTES);
}
function nativeTurns(value: unknown, threadId: string | undefined, limit: number): value is NativeTurn[] {
  if (!Array.isArray(value) || value.length > limit) return false;
  const turns = new Set<string>();
  return value.every(turn => {
    if (!record(turn) || !identifier(turn.id) || turns.has(turn.id) || !identifier(turn.status)
      || (turn.threadId !== undefined && turn.threadId !== threadId) || !Array.isArray(turn.items) || turn.items.length > MAX_ITEMS) return false;
    turns.add(turn.id);
    const items = new Set<string>();
    return turn.items.every(item => {
      if (!nativeItem(item) || items.has(item.id)) return false;
      items.add(item.id); return true;
    });
  });
}
function textOf(item: NativeItem): string {
  if (item.type === 'commandExecution') return typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
  if (item.type === 'reasoning') return Array.isArray(item.content) ? item.content.filter(part => typeof part === 'string').join('\n') : '';
  return typeof item.text === 'string' ? item.text : '';
}
function withText(item: NativeItem, text: string): NativeItem {
  if (item.type === 'commandExecution') return { ...item, aggregatedOutput: text };
  if (item.type === 'reasoning') return { ...item, content: [text] };
  return { ...item, text };
}

/** Replaceable display projection. It never dispatches, retries or authorizes a write. */
export class Projection {
  installationId = '';
  epoch = '';
  seq = 0;
  generation = 0;
  private version = 0;
  private state: ProjectionView = this.empty();
  private items = new Map<string, ItemState>();
  private turnStatuses = new Map<string, string>();
  private diffTurnId?: string;
  private resolvedInteractions = new Map<string, { generation: number; status: Interaction['status'] }>();

  private empty(): ProjectionView { return { streamItems: [], interactions: [], synchronization: 'stale' }; }
  initialize(installationId: string, epoch: string, projectId?: string, threadId?: string): void {
    this.installationId = installationId; this.epoch = epoch; this.seq = 0; this.generation++; this.version++;
    this.state = { ...this.empty(), projectId, threadId };
    this.diffTurnId = undefined;
    this.items.clear(); this.turnStatuses.clear(); this.resolvedInteractions.clear();
  }
  /** Selection does not reset the device-wide event feed cursor. */
  selectScope(projectId?: string, threadId?: string): void {
    this.generation++; this.version++;
    this.state = { ...this.empty(), projectId, threadId };
    this.diffTurnId = undefined;
    this.items.clear(); this.turnStatuses.clear(); this.resolvedInteractions.clear();
  }
  /** Fresh metadata can label a not-yet-materialized thread, never unlock writes. */
  setThreadMetadata(value: unknown): boolean {
    if (!bounded(value) || !validateContract('Thread', value) || value.id !== this.state.threadId || value.projectId !== this.state.projectId) return false;
    this.state.thread = copy(value); this.state.synchronization = 'stale'; this.version++;
    return true;
  }
  ticket(): ProjectionTicket { return { generation: this.generation, version: this.version }; }
  private current(ticket?: ProjectionTicket): boolean {
    return !ticket || ticket.generation === this.generation && ticket.version === this.version;
  }
  private nativeActivity(): void {
    this.state.synchronization = 'synchronizing';
    if (this.state.thread) delete this.state.thread.permissionReadback;
  }
  /** Keep readable content but remove every transient fact that could appear actionable. */
  invalidate(): void {
    this.version++;
    this.state.synchronization = 'stale';
    this.state.activeTurnId = undefined;
    this.state.interactions = [];
    if (this.state.thread) {
      const { permissionReadback: _readback, ...thread } = this.state.thread;
      this.state.thread = thread;
    }
    for (const item of this.items.values()) {
      item.appendable = false; item.stream = '';
      if (item.baseline) item.item = item.baseline;
    }
  }
  view(): ProjectionView {
    const result = copy(this.state);
    const represented = new Set<string>();
    if (result.history && Array.isArray(result.history.items)) {
      result.history.items = (result.history.items as NativeTurn[]).map(turn => ({ ...turn, items: turn.items.map(item => {
        const key = itemKey(turn.id, item.id); represented.add(key);
        return copy(this.items.get(key)?.item ?? item);
      }) }));
    }
    // Overlays for items already in history are applied above, never rendered twice.
    result.streamItems = [...this.items.entries()].filter(([key]) => !represented.has(key)).map(([, entry]) => ({ turnId: entry.turnId, item: copy(entry.item) }));
    return result;
  }
  acceptConnection(value: unknown): ConnectionResult {
    if (!bounded(value) || !validateContract('EventConnection', value) || value.installationId !== this.installationId) {
      this.invalidate(); return { reset: true, replay: false, reconnect: true };
    }
    if (value.epoch !== this.epoch) {
      this.epoch = value.epoch; this.seq = value.headSeq; this.generation++;
      this.items.clear(); this.turnStatuses.clear(); this.resolvedInteractions.clear(); this.invalidate();
      this.state.plan = undefined; this.state.diff = undefined; this.state.tokenUsage = undefined;
      this.diffTurnId = undefined;
      return { reset: true, replay: false };
    }
    if (value.resetRequired || value.headSeq < this.seq) {
      // A reset connection explicitly sends no replay. Its head is the new
      // event baseline; unlike Snapshot observed seq this is a feed watermark.
      this.seq = value.headSeq; this.generation++; this.invalidate();
      return { reset: true, replay: false };
    }
    return { reset: false, replay: value.headSeq > this.seq };
  }
  applyEvent(value: unknown): EventResult {
    if (!bounded(value) || !validateContract('EventEnvelope', value) || value.installationId !== this.installationId || value.epoch !== this.epoch) {
      this.invalidate(); return { resynchronize: true, reconnect: true };
    }
    if (value.seq <= this.seq) return { resynchronize: false };
    if (value.seq !== this.seq + 1) { this.invalidate(); return { resynchronize: true, reconnect: true }; }
    // Advance only after a state mutation or explicit invalidation has been applied.
    const result = this.event(value);
    this.seq = value.seq;
    return result;
  }
  private event(event: EventEnvelope): EventResult {
    const invalid = (): EventResult => { this.invalidate(); return { resynchronize: true }; };
    if (event.kind === 'operation.changed') {
      if (!validateContract('OperationReceipt', event.payload)) return invalid();
      return { resynchronize: false, operation: copy(event.payload) };
    }
    if (event.kind === 'project.changed') {
      if (!validateContract('ProjectChanged', event.payload)) return invalid();
      if (event.scope.projectId !== undefined && event.scope.projectId !== event.payload.project.id) return invalid();
      if (event.payload.project.id === this.state.projectId) this.invalidate();
      return { resynchronize: event.payload.project.id === this.state.projectId, projectChanged: true };
    }
    if (event.kind === 'connection.changed') {
      if (!validateContract('ConnectionChanged', event.payload)) return invalid();
      return invalid();
    }
    if (event.scope.projectId !== undefined && event.scope.projectId !== this.state.projectId
      || event.scope.threadId !== undefined && event.scope.threadId !== this.state.threadId) return { resynchronize: false };
    if (event.kind === 'history.invalidated') {
      if (!validateContract('HistoryInvalidated', event.payload)) return invalid();
      return invalid();
    }
    if (event.kind.startsWith('interaction.')) {
      if (!['interaction.opened', 'interaction.resolved'].includes(event.kind) || !validateContract('Interaction', event.payload)) return invalid();
      const interaction = event.payload;
      if (!this.matchesInteraction(interaction) || event.scope.projectId !== interaction.projectId || event.scope.threadId !== interaction.threadId
        || event.scope.turnId !== undefined && event.scope.turnId !== interaction.turnId) return invalid();
      this.version++;
      if (!this.rememberInteraction(interaction)) return invalid();
      this.state.interactions = this.state.interactions.filter(entry => entry.interactionId !== interaction.interactionId);
      if (event.kind !== 'interaction.resolved' && interaction.status !== 'resolved') this.state.interactions.push(copy(interaction));
      // Snapshot remains the source for the current approval context and write readiness.
      this.state.synchronization = 'synchronizing';
      return { resynchronize: true };
    }
    if (event.kind === 'native.state') return this.nativeState(event);
    if (['item.started', 'item.completed', 'item.delta'].includes(event.kind)) {
      const { projectId, threadId, turnId, itemId } = event.scope;
      if (projectId !== this.state.projectId || threadId !== this.state.threadId || !identifier(turnId) || !identifier(itemId)) return invalid();
      const key = itemKey(turnId, itemId), old = this.items.get(key);
      if (event.kind === 'item.delta') {
        if (!validateContract('ItemDelta', event.payload)) return invalid();
        if (terminal(this.turnStatuses.get(turnId))) return { resynchronize: false };
        if (old?.terminal) return { resynchronize: false };
        if (!old?.appendable) { this.version++; this.state.synchronization = 'synchronizing'; return { resynchronize: true }; }
        const expectedMethod = ({ agentMessage: 'item/agentMessage/delta', commandExecution: 'item/commandExecution/outputDelta', reasoning: 'item/reasoning/textDelta' } as Record<string, string>)[old.item.type];
        if (!expectedMethod || event.payload.nativeMethod !== undefined && event.payload.nativeMethod !== expectedMethod) return invalid();
        if (event.payload.offset !== undefined && event.payload.offset !== Buffer.byteLength(old.stream)) return invalid();
        const text = old.stream + event.payload.delta;
        if (Buffer.byteLength(text) > MAX_ITEM_BYTES) return invalid();
        old.stream = text; old.item = withText(old.item, text); this.version++; this.nativeActivity();
        return { resynchronize: false };
      }
      if (!validateContract('ItemCompleted', event.payload)) return invalid();
      const wrapper = event.payload.item, item = wrapper.data;
      if (!nativeItem(item) || item.id !== itemId || wrapper.id !== itemId || item.type !== wrapper.type || old && old.item.type !== item.type) return invalid();
      if (terminal(this.turnStatuses.get(turnId)) && event.kind === 'item.started') return { resynchronize: false };
      const complete = event.payload.complete && wrapper.truncated !== true;
      const done = event.kind === 'item.completed';
      if (old?.terminal && (!done || !complete)) return { resynchronize: false };
      this.version++;
      this.nativeActivity();
      if (!done && old) {
        old.appendable = false; this.state.synchronization = 'synchronizing';
        return { resynchronize: true };
      }
      const normalized = { ...copy(item), ...(complete ? {} : { truncated: true, detailsAvailable: true }) };
      if (!this.items.has(key) && this.items.size >= MAX_ITEMS) return invalid();
      this.items.set(key, { turnId, item: normalized, terminal: done, appendable: !done && complete, baseline: done ? normalized : undefined, stream: done ? '' : textOf(normalized) });
      if (!complete) this.state.synchronization = 'synchronizing';
      return { resynchronize: !complete };
    }
    if (event.impact === 'informational') return { resynchronize: false };
    return invalid();
  }
  private nativeState(event: EventEnvelope): EventResult {
    const invalid = (): EventResult => { this.invalidate(); return { resynchronize: true }; };
    if (!validateContract('NativeStateEvent', event.payload) || event.payload.truncated
      || event.scope.projectId !== this.state.projectId || event.scope.threadId !== this.state.threadId) return invalid();
    const { method, data } = event.payload;
    const nativeThread = data.threadId ?? (record(data.thread) ? data.thread.id : undefined);
    if (nativeThread !== this.state.threadId) return invalid();
    const turnId = record(data.turn) ? data.turn.id : data.turnId;
    if (event.scope.turnId !== undefined && event.scope.turnId !== turnId) return invalid();
    if (method === 'turn/started' || method === 'turn/completed') {
      if (!record(data.turn) || !identifier(turnId) || !identifier(data.turn.status)
        || method === 'turn/started' && data.turn.status !== 'inProgress'
        || method === 'turn/completed' && !terminal(data.turn.status)) return invalid();
      const oldTurn = (this.state.history?.items as NativeTurn[] | undefined)?.find(turn => turn.id === turnId);
      if (method === 'turn/started' && (terminal(this.turnStatuses.get(turnId)) || oldTurn && terminal(oldTurn.status))) return { resynchronize: false };
      this.version++;
      this.turnStatuses.set(turnId, data.turn.status);
      if (oldTurn) Object.assign(oldTurn, { status: data.turn.status });
      if (method === 'turn/started') {
        this.state.activeTurnId = turnId; this.state.synchronization = 'synchronizing';
        if (this.state.thread) { delete this.state.thread.permissionReadback; this.state.thread.status = 'active'; }
        return { resynchronize: true };
      }
      for (const item of this.items.values()) if (item.turnId === turnId) { item.terminal = true; item.appendable = false; }
      return invalid();
    }
    if (method === 'turn/plan/updated') {
      if (!identifier(turnId) || !Array.isArray(data.plan) || data.plan.length > 100 || !data.plan.every(step => record(step)
        && typeof step.step === 'string' && step.step.length <= 16000 && ['pending', 'inProgress', 'completed'].includes(String(step.status)))) return invalid();
      this.state.plan = copy({ turnId, plan: data.plan, ...(typeof data.explanation === 'string' ? { explanation: data.explanation } : {}) });
    } else if (method === 'turn/diff/updated') {
      if (!identifier(turnId) || typeof data.diff !== 'string' || Buffer.byteLength(data.diff) > MAX_ITEM_BYTES) return invalid();
      this.state.diff = data.diff;
      this.diffTurnId = turnId;
    } else if (method === 'thread/tokenUsage/updated') {
      if (!identifier(turnId) || !record(data.tokenUsage) || !this.validUsage(data.tokenUsage)) return invalid();
      this.state.tokenUsage = copy({ ...data.tokenUsage, turnId });
    } else if (method === 'thread/name/updated') {
      if (!(data.threadName === null || typeof data.threadName === 'string' && data.threadName.length <= 1000)) return invalid();
      if (this.state.thread) this.state.thread.title = data.threadName;
      this.version++; return { resynchronize: true };
    } else if (['thread/started', 'thread/status/changed', 'thread/archived', 'thread/unarchived', 'thread/closed', 'thread/deleted', 'serverRequest/resolved'].includes(method)) {
      return invalid();
    } else return invalid();
    this.version++;
    return { resynchronize: false };
  }
  private validUsage(value: RecordValue): boolean {
    const count = (number: unknown) => number === null || typeof number === 'number' && Number.isSafeInteger(number) && number >= 0;
    if (value.modelContextWindow !== undefined && !count(value.modelContextWindow)) return false;
    for (const key of ['total', 'last']) {
      if (value[key] === undefined) continue;
      if (!record(value[key]) || !Object.entries(value[key]).every(([name, number]) => !name.endsWith('Tokens') || count(number))) return false;
    }
    return record(value.total) || record(value.last);
  }
  private matchesInteraction(value: Interaction): boolean {
    return value.epoch === this.epoch && value.projectId === this.state.projectId && value.threadId === this.state.threadId
      && value.request.threadId === value.threadId && (value.request.turnId === undefined || value.request.turnId === value.turnId);
  }
  private rememberInteraction(value: Interaction): boolean {
    const old = this.resolvedInteractions.get(value.interactionId);
    if (old && (old.generation !== value.generation || old.status !== 'pending' && value.status === 'pending')) return false;
    this.resolvedInteractions.set(value.interactionId, { generation: value.generation, status: value.status });
    return true;
  }
  applySnapshot(value: unknown, ticket?: ProjectionTicket): boolean {
    if (!this.current(ticket)) return false;
    if (!bounded(value) || !validateContract('Snapshot', value) || value.epoch !== this.epoch || value.history.epoch !== this.epoch
      || value.thread.id !== this.state.threadId || value.thread.projectId !== this.state.projectId || !nativeTurns(value.history.items, this.state.threadId, 5)
      || value.interactions.some(interaction => !this.matchesInteraction(interaction))) { this.invalidate(); return false; }
    const snapshot: Snapshot = copy(value);
    const seenInteractions = new Set<string>();
    for (const interaction of snapshot.interactions) {
      const old = this.resolvedInteractions.get(interaction.interactionId);
      if (seenInteractions.has(interaction.interactionId) || old && (old.generation !== interaction.generation || old.status !== 'pending' && interaction.status === 'pending')) {
        this.invalidate(); return false;
      }
      seenInteractions.add(interaction.interactionId);
    }
    const sameRevision = this.state.history?.historyRevision === snapshot.history.historyRevision && this.state.history.epoch === this.epoch;
    const incoming = snapshot.history.items as NativeTurn[];
    const oldTurns = sameRevision ? this.state.history!.items as NativeTurn[] : [];
    const oldItems = this.items;
    const latest = new Map(incoming.map(turn => [turn.id, turn]));
    const merged = oldTurns.filter(turn => !latest.has(turn.id)).concat(incoming);
    if (merged.reduce((count, turn) => count + turn.items.length, 0) > MAX_ITEMS) { this.invalidate(); return false; }
    this.items = new Map();
    if (!sameRevision) this.turnStatuses.clear();
    const regressedTurns = new Set<string>();
    for (const turn of merged) {
      const status = this.turnStatuses.get(turn.id);
      if (sameRevision && terminal(status) && !terminal(turn.status)) { regressedTurns.add(turn.id); turn.status = status!; }
      this.turnStatuses.set(turn.id, turn.status);
    }
    for (const turn of merged) for (const item of turn.items) {
      const key = itemKey(turn.id, item.id), old = oldItems.get(key);
      const done = terminal(turn.status) || terminal(item.status);
      // Concurrent complete native facts win only for an identity in this root/revision.
      if (sameRevision && old?.terminal && old.item.type === item.type && (!done || regressedTurns.has(turn.id) || snapshot.history.truncated)) {
        this.items.set(key, old);
        const priorTurn = oldTurns.find(prior => prior.id === turn.id);
        if (priorTurn && terminal(priorTurn.status)) turn.status = priorTurn.status;
      } else this.items.set(key, { turnId: turn.id, item, baseline: item, terminal: done, appendable: false, stream: '' });
    }
    // A continuously observed complete start has its own stream; never concatenate a baseline.
    if (sameRevision) for (const [key, old] of oldItems) if (old.appendable && !old.terminal) {
      const current = this.items.get(key);
      if (!current?.terminal) this.items.set(key, old);
    }
    const interactions: Interaction[] = [];
    for (const interaction of snapshot.interactions) {
      this.rememberInteraction(interaction);
      if (interaction.status !== 'resolved') interactions.push(interaction);
    }
    const preserveCursor = sameRevision && oldTurns.some(turn => !latest.has(turn.id));
    this.state.thread = snapshot.thread as Thread;
    this.state.history = { ...snapshot.history, items: merged,
      ...(sameRevision ? { itemCursors: { ...this.state.history?.itemCursors, ...snapshot.history.itemCursors }, itemTimings: { ...this.state.history?.itemTimings, ...snapshot.history.itemTimings } } : {}),
      ...(preserveCursor ? { nextCursor: this.state.history!.nextCursor } : {}) };
    this.state.interactions = interactions;
    this.state.activeTurnId = [...merged].reverse().find(turn => turn.status === 'inProgress')?.id;
    this.state.synchronization = this.state.activeTurnId || snapshot.thread.status === 'active' ? 'synchronizing'
      : ['idle', 'notLoaded', 'systemError'].includes(snapshot.thread.status) ? snapshot.synchronization : 'stale';
    if (!sameRevision) {
      // Producer metadata has no independent read endpoint. A new revision is
      // not evidence that a still-present native Turn lost its observed facts.
      const retained = new Set(merged.map(turn => turn.id));
      if (!record(this.state.plan) || !retained.has(String(this.state.plan.turnId))) this.state.plan = undefined;
      if (!this.diffTurnId || !retained.has(this.diffTurnId)) { this.state.diff = undefined; this.diffTurnId = undefined; }
      if (!record(this.state.tokenUsage) || !retained.has(String(this.state.tokenUsage.turnId))) this.state.tokenUsage = undefined;
    }
    this.version++;
    return true;
  }
  appendHistory(value: unknown, ticket?: ProjectionTicket): boolean {
    if (!this.current(ticket)) return false;
    if (!this.state.history || !bounded(value) || !validateContract('HistoryPage', value) || value.epoch !== this.epoch
      || value.historyRevision !== this.state.history.historyRevision || !nativeTurns(value.items, this.state.threadId, 20)) { this.invalidate(); return false; }
    const page: HistoryPage = copy(value), existing = this.state.history.items as NativeTurn[], ids = new Set(existing.map(turn => turn.id));
    const older = (page.items as NativeTurn[]).filter(turn => !ids.has(turn.id));
    if (older.reduce((count, turn) => count + turn.items.length, this.items.size) > MAX_ITEMS) { this.invalidate(); return false; }
    for (const turn of older) {
      this.turnStatuses.set(turn.id, turn.status);
      for (const item of turn.items) this.items.set(itemKey(turn.id, item.id), { turnId: turn.id, item, baseline: item,
        terminal: terminal(turn.status) || terminal(item.status), appendable: false, stream: '' });
    }
    this.state.history = { ...this.state.history, items: [...older, ...existing], nextCursor: page.nextCursor,
      complete: this.state.history.complete && page.complete, truncated: this.state.history.truncated || page.truncated,
      itemCursors: { ...page.itemCursors, ...this.state.history.itemCursors }, itemTimings: { ...page.itemTimings, ...this.state.history.itemTimings } };
    this.version++;
    return true;
  }
}
