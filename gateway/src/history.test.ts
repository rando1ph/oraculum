import { describe, expect, it, vi } from 'vitest';
import { CodexError, type CodexAdapter, type NativeItem, type NativeThread, type NativeTurn } from './codex';
import { NativeHistory, projectItem } from './history';

const scope = 'device-1:project-1';
const item = (id: string, text = id): NativeItem => ({ id, type: 'agentMessage', text });
const turn = (id: string, items: NativeItem[] = []): NativeTurn => ({ id, status: 'completed', items });
const thread = (turns: NativeTurn[]): NativeThread => ({ id: 't', cwd: '/test', preview: '', status: { type: 'idle' }, turns });
function peer() {
  return {
    listTurns: vi.fn().mockResolvedValue({ data: [turn('new'), turn('old')], nextCursor: 'native-secret-cursor' }),
    listItems: vi.fn().mockImplementation(async ({ turnId }) => ({ data: [{ turnId, item: item(`${turnId}-2`) }, { turnId, item: item(`${turnId}-1`) }], nextCursor: null })),
    readThread: vi.fn().mockResolvedValue({ thread: thread([turn('old', [item('i1')]), turn('new', [item('i2')])]) }),
  };
}
describe('bounded native history', () => {
  it('provides chronological stable IDs with opaque device/project-bound cursors', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'epoch-1', sequence: () => 42 });
    const page = await history.turns('t', { scope });
    expect(page.data.map(value => value.id)).toEqual(['old', 'new']);
    expect(page.data[0].items.map(value => value.id)).toEqual(['old-1', 'old-2']);
    expect(page.nextCursor).not.toContain('native-secret');
    expect(page.snapshotSeq).toBe(42);
    await expect(history.turns('t', { scope: 'device-2:project-1', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    await expect(history.turns('other', { scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    await expect(history.turns('t', { scope, limit: 10, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    const replacement = new NativeHistory(codex, { epoch: 'epoch-2' });
    await expect(replacement.turns('t', { scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
  });
  it('invalidates old revision pages, including results that arrive after invalidation', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'epoch-1' });
    const page = await history.turns('t', { scope }); history.invalidate('t');
    await expect(history.turns('t', { scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    codex.listItems.mockImplementationOnce(async ({ turnId }) => { history.invalidate('t'); return { data: [{ turnId, item: item('i') }], nextCursor: null }; });
    await expect(history.turns('t', { scope })).rejects.toMatchObject({ code: 'HISTORY_STALE' });
  });
  it('uses bounded native-read fallback only after identified pagination incompatibility', async () => {
    const codex = peer(); codex.listTurns.mockRejectedValue(new CodexError('NATIVE_PAGINATION_UNSUPPORTED', 'unsupported store', 'rejected'));
    const history = new NativeHistory(codex, { epoch: 'epoch-1' });
    const page = await history.turns('t', { scope, limit: 1 });
    expect(page.source).toBe('native-read'); expect(page.data[0].id).toBe('new');
    const next = await history.turns('t', { scope, limit: 1, cursor: page.nextCursor! });
    expect(next.data[0].id).toBe('old'); expect(next.complete).toBe(true);
    expect(codex.listTurns).toHaveBeenCalledTimes(1);
    expect(codex.readThread.mock.calls.every(call => call[1] === true && call[2] <= 12000)).toBe(true);
  });
  it.each(['NATIVE_TIMEOUT', 'NATIVE_REJECTED', 'NATIVE_PROTOCOL'] as const)('does not turn %s into a full-history read', async code => {
    const codex = peer(); codex.listTurns.mockRejectedValue(new CodexError(code, 'native read failed', 'rejected'));
    await expect(new NativeHistory(codex, { epoch: 'e' }).turns('t', { scope })).rejects.toMatchObject({ code });
    expect(codex.readThread).not.toHaveBeenCalled();
  });
  it('rejects wrong-turn native pages and looping cursors', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    codex.listItems.mockResolvedValueOnce({ data: [{ turnId: 'wrong', item: item('i') }], nextCursor: null });
    await expect(history.items('t', 'right', { scope })).rejects.toMatchObject({ code: 'HISTORY_PROTOCOL' });
    const page = await history.turns('t', { scope });
    await expect(history.turns('t', { scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_PROTOCOL' });
  });
  it('bounds concurrent full-history fallback reads without creating a request queue', async () => {
    const codex = peer(); let release!: () => void;
    codex.listTurns.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ data: [], nextCursor: null }); }));
    const history = new NativeHistory(codex, { epoch: 'e', maxConcurrent: 1 });
    const reading = history.turns('t', { scope });
    await expect(history.turns('t', { scope })).rejects.toMatchObject({ code: 'HISTORY_BUSY' });
    expect(codex.listTurns).toHaveBeenCalledTimes(1); release(); await reading;
  });
  it('limits enormous item and metadata projections and labels incomplete snapshots', async () => {
    const codex = peer();
    codex.listTurns.mockResolvedValue({ data: [{ ...turn('huge'), extra: 'x'.repeat(2_000_000) }], nextCursor: null });
    codex.listItems.mockResolvedValue({ data: [{ turnId: 'huge', item: item('big', '界'.repeat(1_000_000)) }], nextCursor: null });
    const result = await new NativeHistory(codex, { epoch: 'e' }).turns('t', { scope });
    expect(result.truncated).toBe(true); expect(result.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(30_000);
    expect(result.data[0].items[0].id).toBe('big');
    const zero = projectItem(item('kept', 'large'), 0); expect(zero.item.id).toBe('kept'); expect(zero.truncated).toBe(true);
  });
  it('bounds revision tracking from native events and expires evicted cursors', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    const page = await history.turns('t', { scope });
    for (let index = 0; index < 1100; index++) history.invalidate(`native-${index}`);
    await expect(history.turns('t', { scope, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
  });
});

describe('large native item details',()=>{
 it('retrieves complete JSON in bounded chunks and verifies UTF-8 bytes without persisting history',async()=>{
  const native=peer(),large=item('large','界'.repeat(80000));native.listItems.mockResolvedValue({data:[{turnId:'turn',item:large}],nextCursor:null});
  const history=new NativeHistory(native,{epoch:'epoch'}),chunks:Buffer[]=[];let cursor:string|undefined;
  for(let page=0;page<10;page++){
   const part=await history.details('t','turn','large',{scope,cursor});expect(part.chunk.length).toBeLessThanOrEqual(87384);chunks.push(Buffer.from(part.chunk,'base64'));
   if(part.nextCursor===null){const {createHash}=await import('node:crypto');const bytes=Buffer.concat(chunks);expect(bytes.length).toBe(part.totalBytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(part.sha256);expect(JSON.parse(bytes.toString('utf8'))).toEqual(large);return;}
   cursor=part.nextCursor;
   await expect(history.details('t','turn','large',{scope:'other-device',cursor})).rejects.toMatchObject({code:'HISTORY_CURSOR_INVALID'});
  }
  throw new Error('Detail pagination did not terminate');
 });
 it('invalidates detail cursors when a native item changes or history revision changes',async()=>{
  const native=peer();native.listItems.mockResolvedValue({data:[{turnId:'turn',item:item('large','a'.repeat(100000))}],nextCursor:null});const history=new NativeHistory(native,{epoch:'epoch'});
  const first=await history.details('t','turn','large',{scope});native.listItems.mockResolvedValue({data:[{turnId:'turn',item:item('large','b'.repeat(100000))}],nextCursor:null});
  await expect(history.details('t','turn','large',{scope,cursor:first.nextCursor!})).rejects.toMatchObject({code:'HISTORY_STALE'});
  history.invalidate('t');await expect(history.details('t','turn','large',{scope,cursor:first.nextCursor!})).rejects.toMatchObject({code:'HISTORY_CURSOR_INVALID'});
 });
});
