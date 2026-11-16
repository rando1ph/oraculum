import type { Interaction } from '../../../../packages/gateway-protocol/src/index';
import type { FileChangeContext, WorkspaceState } from '../contracts/workspace';
import { Diff } from './Native';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const redacted = (value: string): boolean => value.includes('[主机路径]') || value.includes('[内容过深]');
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value);
const relativePath = (value: unknown): value is string => identifier(value) && value === value.normalize('NFC')
  && !redacted(value) && !/^[\/\\]|[\\:%]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.trim() === part);
const contextKeys = ['interactionId', 'generation', 'epoch', 'projectId', 'threadId', 'turnId', 'itemId', 'digest', 'changes'];

/** Only exact, bounded proof supplied for this live pending interaction may
 * enable file approval. Ordinary conversation/Inspector Diff is never evidence. */
export function validFileChangeContext(state: WorkspaceState, interaction: Interaction): FileChangeContext | undefined {
  if (state.connection.status !== 'connected' || state.synchronization === 'stale'
    || interaction.kind !== 'fileChange' || interaction.status !== 'pending'
    || interaction.epoch !== state.connection.epoch || interaction.projectId !== state.projectId || interaction.threadId !== state.threadId
    || !Number.isSafeInteger(interaction.generation) || interaction.generation < 1
    || ![interaction.interactionId, interaction.epoch, interaction.projectId, interaction.threadId, interaction.turnId].every(identifier)
    || !object(interaction.request) || interaction.request.grantRoot != null
    || interaction.request.truncated === true || interaction.request.detailsAvailable === true
    || interaction.request.threadId !== interaction.threadId || interaction.request.turnId !== interaction.turnId
    || !identifier(interaction.request.itemId)) return;
  const live = state.interactions.find(value => value.interactionId === interaction.interactionId);
  if (!live || live.kind !== 'fileChange' || live.status !== 'pending' || live.generation !== interaction.generation
    || live.epoch !== interaction.epoch || live.projectId !== interaction.projectId || live.threadId !== interaction.threadId
    || live.turnId !== interaction.turnId || !object(live.request) || live.request.threadId !== interaction.threadId
    || live.request.turnId !== interaction.turnId || live.request.itemId !== interaction.request.itemId
    || live.request.grantRoot != null || live.request.truncated === true || live.request.detailsAvailable === true) return;
  const contexts = state.fileChangeContexts;
  if (!contexts || !Object.hasOwn(contexts, interaction.interactionId)) return;
  const context = contexts[interaction.interactionId];
  if (!object(context) || Object.keys(context).some(key => !contextKeys.includes(key))
    || context.interactionId !== interaction.interactionId || context.generation !== interaction.generation
    || context.epoch !== interaction.epoch || context.projectId !== interaction.projectId || context.threadId !== interaction.threadId
    || context.turnId !== interaction.turnId || context.itemId !== interaction.request.itemId
    || typeof context.digest !== 'string' || !/^[a-f0-9]{64}$/.test(context.digest)
    || !Array.isArray(context.changes) || context.changes.length === 0 || context.changes.length > 20) return;
  let lines = 0;
  const paths = new Set<string>();
  for (const change of context.changes) {
    if (!object(change) || Object.keys(change).some(key => !['path', 'kind', 'movePath', 'diff'].includes(key))
      || !relativePath(change.path) || paths.has(change.path) || !['add', 'delete', 'update'].includes(change.kind)
      || !(change.movePath === null || relativePath(change.movePath))
      || change.movePath !== null && change.kind !== 'update'
      || typeof change.diff !== 'string' || !change.diff.trim() || redacted(change.diff)
      || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]/u.test(change.diff)) return;
    paths.add(change.path);
    lines += 1 + (change.diff.match(/\r\n|[\r\n\u2028\u2029]/g)?.length ?? 0);
    if (lines > 256) return;
  }
  const destinations = new Set<string>();
  for (const change of context.changes) if (change.movePath !== null) {
    if (paths.has(change.movePath) || destinations.has(change.movePath)) return;
    destinations.add(change.movePath);
  }
  try { if (new TextEncoder().encode(JSON.stringify(context)).byteLength > 16 * 1024) return; }
  catch { return; }
  return context;
}

/** Render every byte of the validated patch as escaped text, without clipping,
 * Markdown, remote assets or collapsed changes. The shared Diff keeps 10px. */
export function FileChangeEvidence({ context }: { context: FileChangeContext }) {
  const labels: Record<string, string> = { add: '新增', delete: '删除', update: '修改' };
  return <section className="file-change-evidence" aria-label="本次文件审批的完整变更证据">
    <p className="inspector-note">以下 {context.changes.length} 个文件与本次审批请求绑定。允许本次仅批准这里展示的完整变更。</p>
    {context.changes.map(change => <section key={change.path} className="file-change-proof">
      <p className="file-path"><b>{labels[change.kind] ?? change.kind}</b> · {change.path}{change.movePath !== null && <> → {change.movePath}</>}</p>
      <Diff value={change.diff} />
    </section>)}
  </section>;
}
