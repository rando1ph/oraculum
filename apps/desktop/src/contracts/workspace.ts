import type { AccountRateLimits, AccountUsage, Attachment, Capabilities, DirectoryPage, ExtensionsSnapshot, FilePage, HistoryPage, Interaction, InteractionAnswer, ModelPage, NativeDefaults, NativeItem, OperationReceipt, Preset, Snapshot, Thread, ThreadPage } from '../../../../packages/gateway-protocol/src/index';

export type ConnectionStatus = 'idle' | 'connecting' | 'pairing' | 'connected' | 'offline' | 'revoked' | 'error';
export interface OperationView {
  operationId: string; kind: string; projectId?: string; threadId?: string;
  status: 'prepared' | 'unknown' | 'accepted' | 'rejected'; createdAt: number; errorCode?: string;
}
export interface FileChangeContext {
  interactionId: string; generation: number; epoch: string; projectId: string; threadId: string;
  turnId: string; itemId: string; digest: string;
  changes: { path: string; kind: string; movePath: string | null; diff: string }[];
}
export interface WorkspaceState {
  connection: { status: ConnectionStatus; endpoint: string; installationId?: string; deviceId?: string; epoch?: string; errorCode?: string; secureStorage: boolean };
  capabilities?: Capabilities;
  projects: { id: string; name: string; rootId: string; available: boolean }[];
  roots: { id: string; label: string }[];
  directories?: DirectoryPage;
  projectId?: string;
  threadId?: string;
  threads?: ThreadPage;
  thread?: Thread;
  history?: HistoryPage;
  itemDetails?: { itemId: string; turnId: string; text: string; complete: boolean; nextCursor?: string };
  streamItems: { turnId: string; item: NativeItem }[];
  interactions: Interaction[];
  commandScopes?: Record<string, { relativeCwd: '.' }>;
  fileChangeContexts?: Record<string, FileChangeContext>;
  synchronization: 'stale' | 'synchronizing' | 'current';
  activeTurnId?: string;
  firstTurnReady?: boolean;
  models?: ModelPage;
  defaults?: NativeDefaults;
  plan?: unknown;
  diff?: string;
  tokenUsage?: unknown;
  rateLimits?: AccountRateLimits;
  accountUsage?: AccountUsage;
  extensions?: ExtensionsSnapshot;
  files?: FilePage;
  preview?: { name: string; mime: string; text?: string; image?: string; limited: boolean };
  attachments: Attachment[];
  draftId: string;
  operations: OperationView[];
  busy: boolean;
  notice?: string;
}

/** Closed business intents. No URL, headers, RPC method, credentials or local paths. */
export type WorkspaceAction =
  | { type: 'connect'; endpoint: string }
  | { type: 'pair'; code: string; label: string }
  | { type: 'disconnect' | 'reconnect' | 'refresh' | 'reconcile' | 'logout' }
  | { type: 'directories'; rootId: string; path?: string; cursor?: string }
  | { type: 'registerProject'; rootId: string; path: string }
  | { type: 'unregisterProject'; projectId: string; confirm: true }
  | { type: 'selectProject'; projectId: string }
  | { type: 'threads'; search?: string; archived?: boolean; more?: boolean }
  | { type: 'selectThread'; threadId: string }
  | { type: 'startThread'; model?: string; effort?: string; permissionPreset?: Preset }
  | { type: 'resumeThread' | 'historyMore' | 'interrupt' }
  | { type: 'send'; text: string; model?: string; effort?: string; permissionPreset?: Preset }
  | { type: 'steer'; text: string }
  | { type: 'threadMutation'; action: 'name' | 'archive' | 'unarchive' | 'delete' | 'fork' | 'revert' | 'compact'; name?: string; beforeTurnId?: string; confirm?: boolean }
  | { type: 'answer'; interactionId: string; generation: number; epoch: string; response: InteractionAnswer; contextDigest?: string }
  | { type: 'details'; turnId: string; itemId: string; cursor?: string }
  | { type: 'files'; path?: string; more?: boolean }
  | { type: 'previewFile' | 'downloadFile'; path: string }
  | { type: 'upload' }
  | { type: 'removeAttachment'; attachmentId: string }
  | { type: 'inspector'; section: 'usage' | 'extensions' };

export interface WorkspaceBridge {
  getWorkspace(): Promise<WorkspaceState>;
  workspaceAction(action: WorkspaceAction): Promise<WorkspaceState>;
  onWorkspaceChanged(listener: (state: WorkspaceState) => void): () => void;
}
export type { Snapshot, OperationReceipt };
