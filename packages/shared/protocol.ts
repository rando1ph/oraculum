// Generated from the reviewed build-time Codex schema; runtime compatibility is checked separately.
export type { ServerNotification } from '../../.local/codex-protocol/ServerNotification';
export type { ServerRequest } from '../../.local/codex-protocol/ServerRequest';
export type { Thread } from '../../.local/codex-protocol/v2/Thread';
export type { Model } from '../../.local/codex-protocol/v2/Model';
export type { Turn } from '../../.local/codex-protocol/v2/Turn';
export type { ThreadItem } from '../../.local/codex-protocol/v2/ThreadItem';
import type { ServerNotification } from '../../.local/codex-protocol/ServerNotification';
import type { ServerRequest } from '../../.local/codex-protocol/ServerRequest';
import type { Thread } from '../../.local/codex-protocol/v2/Thread';
import type { AskForApproval } from '../../.local/codex-protocol/v2/AskForApproval';
import type { ApprovalsReviewer } from '../../.local/codex-protocol/v2/ApprovalsReviewer';
import type { SandboxMode } from '../../.local/codex-protocol/v2/SandboxMode';
import type { SandboxPolicy } from '../../.local/codex-protocol/v2/SandboxPolicy';
import type { WebSearchMode } from '../../.local/codex-protocol/WebSearchMode';
import type { LimitsSnapshot, ThreadUsage } from './usage';
import type { AttachmentDelivery } from './attachments';

export type RpcId = string | number;
export type WireMessage = {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
export type Approval = Extract<ServerRequest, { method: 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/tool/requestUserInput' | 'mcpServer/elicitation/request' | 'item/permissions/requestApproval' }> & { bridgeToken?: string; displayThreadIds?: string[] };
export type NativeSessionSettings = {
  approvalPolicy: AskForApproval; sandbox: SandboxPolicy; approvalsReviewer: ApprovalsReviewer;
  // Actual native thread settings, never the renderer's requested overrides.
  // Optional for older servers; null effort uses the native model's effort.
  model?: string; effort?: string | null;
};
// Inherit means no override: native turn overrides persist on the thread.
export type PermissionMode = 'inherit' | 'read-only' | 'auto' | 'full-access';
export type NativeOperationMethod = 'thread/name/set' | 'thread/fork' | 'thread/revert' | 'turn/steer' | 'review/start' | 'thread/compact/start';
export type NativeOperation = {
  operationId: string; threadId: string; cwd: string; method: NativeOperationMethod;
  state: 'running' | 'accepted' | 'unknown' | 'rejected' | 'completed'; createdAt: number;
  message?: string; resultThreadId?: string; turnId?: string;
};
export type NativeCapabilities = {
  unsupportedMethods: NativeOperationMethod[];
  plan: { available: false; reason: string };
};
export type BridgeEvent =
  | { type: 'attachmentsChanged'; threadId: string; cwd: string; deliveries: AttachmentDelivery[] }
  | { type: 'nativeOperationChanged'; operation: NativeOperation }
  | { type: 'nativeCapabilitiesChanged'; capabilities: NativeCapabilities }
  | { type: 'threadHistoryChanged'; threadId: string; cwd: string; reason: 'revert' | 'compact'; historyRevision: number }
  | { type: 'accountLimits'; snapshot: LimitsSnapshot }
  | { type: 'threadUsage'; snapshot: ThreadUsage }
  | { type: 'event'; event: ServerNotification }
  | { type: 'approval'; request: Approval }
  | { type: 'requestAnswered'; requestId: RpcId; bridgeToken?: string }
  | { type: 'notice'; threadId?: string; displayThreadIds?: string[]; message: string }
  | { type: 'unavailable'; message: string }
  | { type: 'settingsChanged'; threadId: string; settings?: NativeSessionSettings }
  | { type: 'projectsChanged' }
  | { type: 'threadLifecycleChanged'; threadId: string; cwd: string; state: ThreadLifecycleState };
export type ThreadLifecycleState = 'active' | 'archived' | 'deleted' | 'unknown';
export type ThreadLifecycleResult = { threadId: string; state: Exclude<ThreadLifecycleState, 'unknown'> };
export type Snapshot = {
  attachments?: AttachmentDelivery[];
  thread: Thread;
  pending: Approval[];
  settings?: NativeSessionSettings;
  history?: { source: 'native-read' | 'native-pages'; warning: string; nextCursor?: string | null };
  sendBlocked?: boolean;
  receipts?: SendReceipt[];
  nativeOperations?: NativeOperation[];
  nativeCapabilities?: NativeCapabilities;
  // A native history mutation invalidates all prior pages and observed items.
  historyRevision?: number;
};
export type SendReceipt = {
  operationId: string;
  status: 'unknown' | 'accepted' | 'rejected' | 'completed' | 'failed' | 'interrupted';
  turnId: string | null;
  createdAt: number;
};
export type LocalConfig = {
  cwd: string;
  model: string | null;
  effort: string | null;
  provider: string | null;
  approvalPolicy: AskForApproval | null;
  sandbox: SandboxMode | null;
  approvalsReviewer: ApprovalsReviewer | null;
  webSearch: WebSearchMode | null;
};
export type ProjectList = {
  root: string;
  projects: { name: string; cwd: string; available?: boolean }[];
};

export type DirectoryListing = {
  roots: string[]; cwd: string; parent: string | null;
  directories: { name: string; cwd: string }[];
  nextCursor: string | null; canRegister: boolean;
};
