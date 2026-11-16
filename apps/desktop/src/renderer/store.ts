import { create } from 'zustand';
import type { Interaction, Preset } from '../../../../packages/gateway-protocol/src/index';
import type { WorkspaceAction, WorkspaceState } from '../contracts/workspace';

export type Draft = { text: string; model: string; effort: string; permissionPreset: Preset | '' };
const emptyDraft: Draft = { text: '', model: '', effort: '', permissionPreset: '' };
type Store = {
  workspace: WorkspaceState | null;
  pending: boolean;
  error: string;
  drafts: Record<string, Draft>;
  receive: (state: WorkspaceState) => void;
  setDraft: (key: string, patch: Partial<Draft>) => void;
  clearError: () => void;
  act: (action: WorkspaceAction) => Promise<WorkspaceState | undefined>;
};
// This is a thin in-memory projection. The main process owns reconciliation,
// credentials and the durable operation journal. P4.3 owns persisted drafts.
let eventRevision = 0;
export const useWorkspace = create<Store>((set, get) => ({
  workspace: null, pending: false, error: '', drafts: {},
  receive: workspace => { eventRevision += 1; set({ workspace }); },
  setDraft: (key, patch) => set(current => ({ drafts: { ...current.drafts, [key]: { ...emptyDraft, ...current.drafts[key], ...patch } } })),
  clearError: () => set({ error: '' }),
  act: async action => {
    if (get().pending || !window.oraculumDesktop) return;
    set({ pending: true, error: '' });
    const revision = eventRevision;
    try {
      const workspace = await window.oraculumDesktop.workspaceAction(action);
      // An IPC result must not overwrite a newer event projection.
      if (revision === eventRevision) set({ workspace });
      return workspace;
    } catch {
      set({ error: '操作未能完成。请查看连接和操作记录；结果不明时先核实原操作。' });
    } finally { set({ pending: false }); }
  },
}));

export function draftKey(state: WorkspaceState): string {
  return JSON.stringify([state.connection.endpoint, state.connection.installationId, state.connection.deviceId,
    state.projectId, state.threadId ?? 'new']);
}
export function getDraft(state: WorkspaceState, drafts: Store['drafts']): Draft { return drafts[draftKey(state)] ?? emptyDraft; }
export function hasPendingOperation(state: WorkspaceState, scope: 'thread' | 'project' | 'identity' = 'thread'): boolean {
  return state.operations.some(operation => ['prepared', 'unknown'].includes(operation.status)
    && (scope === 'identity' || !operation.projectId || operation.projectId === state.projectId)
    && (scope !== 'thread' || !operation.threadId || operation.threadId === state.threadId));
}
export function canUseCapability(state: WorkspaceState, name: string): boolean {
  const capability = state.capabilities?.capabilities.find(item => item.name === name);
  return !!capability?.supported && ['available', 'unverified'].includes(capability.availability);
}
export function canWrite(state: WorkspaceState): boolean {
  return state.connection.status === 'connected' && state.synchronization === 'current' && !state.busy && !hasPendingOperation(state);
}
export function canWriteScope(state: WorkspaceState, scope: 'project' | 'identity'): boolean {
  // No thread snapshot exists before selection. These intents are scoped to a
  // project/identity and are still checked against the durable journal in main.
  return state.connection.status === 'connected' && !state.busy && !hasPendingOperation(state, scope);
}
export function canSendFirstTurn(state: WorkspaceState): boolean {
  // An omitted archived field is unknown, not an unarchived thread. Only a
  // verified fresh-thread permit can bridge that absence for the first Turn.
  if (state.thread?.archived === true || state.thread?.archived !== false && state.firstTurnReady !== true) return false;
  return canWrite(state) || state.firstTurnReady === true && state.connection.status === 'connected' && !state.busy && !hasPendingOperation(state);
}
function liveNativeState(state: WorkspaceState, pending: boolean): boolean {
  return state.connection.status === 'connected' && state.synchronization !== 'stale' && !state.busy && !pending;
}
export function canControlTurn(state: WorkspaceState, action: 'interrupt' | 'steer', pending = false): boolean {
  if (!liveNativeState(state, pending) || !state.projectId || !state.threadId || !state.activeTurnId || !canUseCapability(state, `turn.${action}`)) return false;
  if (action === 'steer') return state.thread?.archived === false && !hasPendingOperation(state);
  // Stopping an observed active Turn is a safety exception. Other unresolved
  // writes must not prevent it, but an unresolved Stop is never sent again.
  return !state.operations.some(operation => operation.kind === 'turn.interrupt' && ['prepared', 'unknown'].includes(operation.status)
    && (!operation.projectId || operation.projectId === state.projectId) && (!operation.threadId || operation.threadId === state.threadId));
}
export function hasPendingInteractionResponse(state: WorkspaceState, interaction: Interaction): boolean {
  return state.operations.some(operation => operation.kind === 'interaction.respond' && ['prepared', 'unknown'].includes(operation.status)
    && (!operation.projectId || operation.projectId === interaction.projectId) && (!operation.threadId || operation.threadId === interaction.threadId));
}
export function canAnswerInteraction(state: WorkspaceState, interaction: Interaction, pending = false): boolean {
  if (!liveNativeState(state, pending) || !canUseCapability(state, 'interactions') || interaction.status !== 'pending'
    || interaction.epoch !== state.connection.epoch || interaction.projectId !== state.projectId || interaction.threadId !== state.threadId
    || hasPendingInteractionResponse(state, interaction)) return false;
  // A current pending interaction is actionable during an active Turn even
  // though its evolving history cannot yet be a settled/current snapshot.
  return state.interactions.some(current => current.interactionId === interaction.interactionId && current.status === 'pending'
    && current.generation === interaction.generation && current.epoch === interaction.epoch
    && current.projectId === interaction.projectId && current.threadId === interaction.threadId);
}

export const connectionLabels: Record<WorkspaceState['connection']['status'], string> = {
  idle: '尚未连接', connecting: '正在连接', pairing: '等待设备配对', connected: '已连接',
  offline: '连接已断开', revoked: '设备信任已失效', error: '连接未完成',
};
