import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseContract, type Interaction, type Snapshot } from '../../../../packages/gateway-protocol/src/index';

export interface VerifiedFileChange {
  readonly path: string;
  readonly kind: 'add' | 'delete' | 'update';
  readonly movePath: string | null;
  readonly diff: string;
}
export interface FileChangeContext {
  readonly interactionId: string;
  readonly generation: number;
  readonly epoch: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly digest: string;
  readonly changes: readonly VerifiedFileChange[];
}
type ItemContext = Omit<FileChangeContext, 'interactionId' | 'generation'>;
type ObjectValue = Record<string, unknown>;
const MAX_BYTES = 16 * 1024;
const INVISIBLE = /[\x00-\x1f\x7f-\x9f\p{Cf}]/u;
const DIFF_INVISIBLE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\p{Cf}]/u;
const issued = new WeakMap<FileChangeContext, () => boolean>();
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !INVISIBLE.test(value);
const keys = (value: ObjectValue, required: string[], optional: string[] = []): boolean =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const key = (turnId: string, itemId: string): string => JSON.stringify([turnId, itemId]);
function canonical(value: unknown): string {
  const sorted = (input: unknown): unknown => Array.isArray(input) ? input.map(sorted)
    : object(input) ? Object.fromEntries(Object.keys(input).sort().map(name => [name, sorted(input[name])])) : input;
  return JSON.stringify(sorted(value));
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

function projectRoot(value: string): boolean {
  return typeof value === 'string' && value.length > 1 && value.length <= 4096 && value.startsWith('/')
    && value === posix.normalize(value) && !value.endsWith('/') && value === value.normalize('NFC')
    && !/[\\%]/.test(value) && !INVISIBLE.test(value);
}
function relativePath(value: unknown, root: string): string | undefined {
  if (!identifier(value) || value !== value.normalize('NFC') || /[\\:%]/.test(value)) return undefined;
  const relative = value.startsWith('/') ? value.startsWith(`${root}/`) ? value.slice(root.length + 1) : undefined : value;
  if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part)) return undefined;
  return relative;
}
function boundary(value: string, offset: number): boolean {
  if (offset === 0 || /[\s"'`=(:,;\[\]{}<>]/.test(value[offset - 1]!)) return true;
  const previous = value[offset - 1]!;
  if (previous.charCodeAt(0) > 127 && /[\p{P}\p{S}]/u.test(previous)) return true;
  return /^[+-]{1,3}$/.test(value.slice(value.lastIndexOf('\n', offset - 1) + 1, offset));
}
function displayDiff(value: unknown, root: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || DIFF_INVISIBLE.test(value)) return undefined;
  // Replace only exact, token-boundary occurrences of the canonical project
  // root. A shared prefix such as /project-other is never made to look local.
  let displayed = '', cursor = 0;
  while (cursor < value.length) {
    const at = value.indexOf(root, cursor);
    if (at < 0) { displayed += value.slice(cursor); break; }
    const end = at + root.length, next = value[end];
    if (boundary(value, at) && (next === '/' || next === undefined || /[\s"'`]/.test(next))) {
      if (next === '/') {
        const suffix = value.slice(end + 1).split(/[\r\n\t"'`\u2018\u2019\u201c\u201d]/, 1)[0]!;
        if (/(?:^|\/)\.{1,2}(?:\/|\s|$)/u.test(suffix) || `/${suffix}`.includes('//')) return undefined;
      }
      displayed += value.slice(cursor, at) + (next === '/' ? './' : '.');
      cursor = end + (next === '/' ? 1 : 0);
    } else { displayed += value.slice(cursor, end); cursor = end; }
  }
  // HTTP(S) values are data, never navigation capabilities. Other absolute path
  // spellings would hide part of the patch in the renderer and cannot approve.
  const inspected = displayed.replace(/\bhttps?:\/\/[^\s"'`<>]+/g, '[url]');
  for (let at = 0; at < inspected.length; at++) {
    if (inspected[at] === '/' && boundary(inspected, at) && !/\s/.test(inspected[at + 1] ?? '')) return undefined;
    if (boundary(inspected, at) && (/^[A-Za-z]:[\\/]/.test(inspected.slice(at)) || inspected.slice(at, at + 2) === '\\\\')) return undefined;
  }
  return displayed;
}

function requestMatches(context: Pick<FileChangeContext, 'epoch' | 'projectId' | 'threadId' | 'turnId' | 'itemId'>, interaction: Interaction): boolean {
  const request = interaction.request;
  return interaction.kind === 'fileChange' && interaction.status === 'pending'
    && identifier(interaction.interactionId) && Number.isSafeInteger(interaction.generation) && interaction.generation > 0
    && interaction.epoch === context.epoch && interaction.projectId === context.projectId && interaction.threadId === context.threadId
    && interaction.turnId === context.turnId && object(request) && request.threadId === context.threadId
    && request.turnId === context.turnId && request.itemId === context.itemId && request.grantRoot == null;
}

/** Only issued, unmodified proofs from a still-current store may unlock accept.
 * Renderer receives a serialized display copy and returns only its digest. */
export function fileChangeContextMatches(context: FileChangeContext | undefined, interaction: Interaction, displayedDigest: string | undefined): boolean {
  return !!context && issued.get(context)?.() === true && context.digest === displayedDigest
    && context.interactionId === interaction.interactionId && context.generation === interaction.generation && requestMatches(context, interaction);
}

/** The owner supplies only a snapshot accepted against its current read ticket,
 * and clears this ephemeral store on every relevant event/disconnect/selection.
 * History pagination, cache entries and item previews cannot establish proof. */
export class FileChangeContexts {
  private readonly items = new Map<string, ItemContext>();
  private revision = 0;

  clear(): void { this.revision++; this.items.clear(); }

  snapshot(snapshot: Snapshot, canonicalProjectRoot: string): void {
    this.clear();
    try {
      parseContract('Snapshot', snapshot);
      if (!projectRoot(canonicalProjectRoot) || snapshot.history.truncated !== false || snapshot.history.epoch !== snapshot.epoch
        || snapshot.observedStartSeq > snapshot.observedEndSeq || snapshot.synchronization === 'stale'
        || !identifier(snapshot.thread.id) || !identifier(snapshot.thread.projectId)) return;
      const candidates = new Map<string, ItemContext>(), turns = new Set<string>(), seen = new Set<string>();
      for (const turn of snapshot.history.items) {
        if (!object(turn) || !identifier(turn.id) || turns.has(turn.id)) return;
        turns.add(turn.id);
        if (turn.status !== 'inProgress') continue;
        if (!Array.isArray(turn.items)) return;
        for (const raw of turn.items) {
          if (!object(raw)) return;
          if (raw.type !== 'fileChange') continue;
          if (!identifier(raw.id)) return;
          const identity = key(turn.id, raw.id);
          if (seen.has(identity)) return;
          seen.add(identity);
          const context = this.completeItem(snapshot, turn.id, raw, canonicalProjectRoot);
          if (context) candidates.set(identity, context);
          if (candidates.size > 32) return;
        }
      }
      for (const [identity, context] of candidates) this.items.set(identity, context);
    } catch { this.clear(); }
  }

  forInteraction(interaction: Interaction): FileChangeContext | undefined {
    if (!object(interaction.request) || !identifier(interaction.request.turnId) || !identifier(interaction.request.itemId)) return undefined;
    const itemKey = key(interaction.request.turnId, interaction.request.itemId), item = this.items.get(itemKey);
    if (!item || !requestMatches(item, interaction)) return undefined;
    const version = this.revision;
    const result: FileChangeContext = Object.freeze({ ...item, interactionId: interaction.interactionId, generation: interaction.generation,
      digest: digest({ itemDigest: item.digest, interactionId: interaction.interactionId, generation: interaction.generation }) });
    if (Buffer.byteLength(canonical(result)) > MAX_BYTES) return undefined;
    issued.set(result, () => this.revision === version && this.items.get(itemKey) === item);
    return result;
  }

  assertCurrent(interaction: Interaction, displayedDigest: string): void {
    if (!fileChangeContextMatches(this.forInteraction(interaction), interaction, displayedDigest)) throw new Error('FILE_CHANGE_CONTEXT_STALE');
  }

  private completeItem(snapshot: Snapshot, turnId: string, item: ObjectValue, root: string): ItemContext | undefined {
    if (item.status !== 'inProgress' || !keys(item, ['id', 'type', 'status', 'changes']) || Buffer.byteLength(canonical(item)) > MAX_BYTES
      || !Array.isArray(item.changes) || item.changes.length < 1 || item.changes.length > 20) return undefined;
    const changes: VerifiedFileChange[] = [], paths = new Set<string>();
    let lines = 0;
    for (const raw of item.changes) {
      if (!object(raw) || !keys(raw, ['path', 'kind', 'diff']) || !object(raw.kind) || !keys(raw.kind, ['type'], ['move_path'])) return undefined;
      const path = relativePath(raw.path, root), kind = raw.kind.type;
      if (!path || paths.has(path) || (kind !== 'add' && kind !== 'delete' && kind !== 'update')
        || (kind !== 'update' && Object.hasOwn(raw.kind, 'move_path'))) return undefined;
      paths.add(path);
      const movePath = raw.kind.move_path == null ? null : relativePath(raw.kind.move_path, root);
      if (movePath === undefined || movePath === path) return undefined;
      const diff = displayDiff(raw.diff, root);
      if (diff === undefined) return undefined;
      lines += 1 + (diff.match(/\r\n|[\r\n\u2028\u2029]/g)?.length ?? 0);
      if (lines > 256) return undefined;
      changes.push(Object.freeze({ path, kind, movePath, diff }));
    }
    // A move into another changed path (or a repeated destination) is ambiguous.
    const moves = new Set<string>();
    for (const change of changes) if (change.movePath !== null) {
      if (paths.has(change.movePath) || moves.has(change.movePath)) return undefined;
      moves.add(change.movePath);
    }
    const scope = { epoch: snapshot.epoch, projectId: snapshot.thread.projectId, threadId: snapshot.thread.id, turnId, itemId: item.id as string };
    const proof = { ...scope, root, original: item, changes };
    if (Buffer.byteLength(canonical({ ...scope, changes })) > MAX_BYTES) return undefined;
    return Object.freeze({ ...scope, digest: digest(proof), changes: Object.freeze(changes) });
  }
}
