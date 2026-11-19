import type { Preset } from '../../../../../packages/gateway-protocol/src/index';
import type { WorkspaceState } from '../../contracts/workspace';

/** A main-process supplied identity. It partitions display data, never grants access. */
export interface LocalIdentity { endpoint: string; installationId: string; deviceId: string }
export interface LocalScope extends LocalIdentity { projectId: string; threadId?: string }
export interface DraftContent { text: string; model: string; effort: string; permissionPreset: Preset | '' }
export interface DraftSubmission {
  revision: number;
  status: 'pending' | 'accepted' | 'rejected';
  operationId?: string;
}
export interface PersistedDraft extends DraftContent {
  clientDraftId: string;
  revision: number;
  updatedAt: number;
  submission?: DraftSubmission;
}
export interface DraftReceipt {
  clientDraftId: string;
  draftRevision: number;
  operationId: string;
  status: 'prepared' | 'unknown' | 'accepted' | 'rejected';
}
/** Last-known display material only; no live permissions, interactions or receipts. */
export interface CachedHistory {
  savedAt: number;
  thread?: WorkspaceState['thread'];
  history?: WorkspaceState['history'];
  streamItems: WorkspaceState['streamItems'];
  plan?: WorkspaceState['plan'];
  diff?: string;
  tokenUsage?: WorkspaceState['tokenUsage'];
}
export interface CachedNavigation {
  savedAt: number;
  projects: WorkspaceState['projects'];
  threadsByProject: Record<string, NonNullable<WorkspaceState['threads']>>;
  projectId?: string;
  threadId?: string;
}
export interface ReadingPosition {
  itemKey?: string;
  offset: number;
  atBottom: boolean;
  historyRevision?: string;
  updatedAt: number;
}
export interface LocalPreferences {
  navigationWidth: number;
  inspectorWidth: number;
  navigationVisible: boolean;
}
export type StorageErrorCode = 'unavailable' | 'blocked' | 'version' | 'corrupt' | 'quota' | 'conflict' | 'pending' | 'invalid';
export class LocalStorageError extends Error {
  constructor(readonly code: StorageErrorCode) { super(`LOCAL_STORAGE_${code.toUpperCase()}`); this.name = 'LocalStorageError'; }
}
