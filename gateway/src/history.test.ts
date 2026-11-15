import { describe, expect, it, vi } from 'vitest';
import { CodexError, type CodexAdapter, type NativeItem, type NativeThread, type NativeTurn } from './codex';
import { NativeHistory, nativeItemTiming, projectItem } from './history';

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
  it('preserves producer item timing separately from native Item contents and Turn timing', async () => {
    const codex = peer();
    codex.listTurns.mockResolvedValue({ data: [{ ...turn('timed'), startedAt: 1700000000, completedAt: 1700000002, durationMs: 2150 }], nextCursor: null });
    codex.listItems.mockResolvedValue({ data: [{ turnId: 'timed', item: item('i'), startedAtMs: 1700000000123, completedAtMs: 1700000002345 }], nextCursor: null });
    const history = new NativeHistory(codex, { epoch: 'e' });
    const page = await history.turns('t', { scope });
    expect(page.data[0]).toMatchObject({ startedAt: 1700000000, completedAt: 1700000002, durationMs: 2150 });
    expect(page.itemTimings).toEqual({ i: { startedAtMs: 1700000000123, completedAtMs: 1700000002345 } });
    expect(page.data[0].items[0]).toEqual(item('i'));
    expect((await history.items('t', 'timed', { scope })).itemTimings).toEqual(page.itemTimings);
  });
  it('does not invent timing for full-read fallback or accept invalid native timestamps', async () => {
    const codex = peer(); codex.listTurns.mockRejectedValue(new CodexError('NATIVE_PAGINATION_UNSUPPORTED', 'unsupported store', 'rejected'));
    expect((await new NativeHistory(codex, { epoch: 'e' }).turns('t', { scope })).itemTimings).toBeUndefined();
    expect(nativeItemTiming({ startedAtMs: '1700000000000', completedAtMs: -1 })).toEqual({});
    expect(nativeItemTiming({ startedAtMs: Number.NaN, completedAtMs: 253402300800000 })).toEqual({});
    expect(nativeItemTiming({ startedAtMs: 1700000000000 })).toEqual({ startedAtMs: 1700000000000 });
  });
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
  it('coalesces identical reads but bounds distinct reads without creating a request queue', async () => {
    const codex = peer(); let release!: () => void;
    codex.listTurns.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ data: [], nextCursor: null }); }));
    const history = new NativeHistory(codex, { epoch: 'e', maxConcurrent: 1 });
    const reading = history.turns('t', { scope });
    const shared = history.turns('t', { scope });
    await expect(history.turns('t', { scope: 'other-device' })).rejects.toMatchObject({ code: 'HISTORY_BUSY' });
    expect(codex.listTurns).toHaveBeenCalledTimes(1); release();
    expect((await Promise.all([reading, shared])).map(page => page.data)).toEqual([[], []]);
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

describe('disposable history page reuse', () => {
  it('serves ten repeated pages with one native load and detaches native and caller objects', async () => {
    const codex = peer(), nativeTurns = [turn('new'), turn('old')];
    codex.listTurns.mockResolvedValue({ data: nativeTurns, nextCursor: null });
    const history = new NativeHistory(codex, { epoch: 'e' });
    for (let index = 0; index < 10; index++) {
      const page = await history.turns('t', { scope });
      expect(page.data[0].items[0].text).toBe('old-1');
      page.data[0].items[0].text = 'caller edit';
    }
    expect(codex.listTurns).toHaveBeenCalledTimes(1);
    expect(codex.listItems).toHaveBeenCalledTimes(2);
    expect(nativeTurns).toEqual([turn('new'), turn('old')]);
  });
  it('keeps device/project scopes isolated and reuses identical item queries', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    await history.items('t', 'old', { scope });
    await history.items('t', 'old', { scope });
    expect(codex.listItems).toHaveBeenCalledTimes(1);
    await history.items('t', 'old', { scope: 'device-2:project-1' });
    await history.items('t', 'old', { scope: 'device-1:project-2' });
    expect(codex.listItems).toHaveBeenCalledTimes(3);
  });
  it('revalidates roots under a thread lease and expires old windows without native event evidence', async () => {
    let now = 1000;
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e', now: () => now });
    const first = await history.turns('t', { scope, limit: 2 });
    now += 5001;
    const sameWindow = await history.turns('t', { scope, limit: 2 });
    expect(sameWindow.revision).toBe(first.revision);
    now += 25000;
    const revalidated = await history.turns('t', { scope: 'device-2:project-1', limit: 2 });
    expect(revalidated.revision).not.toBe(first.revision);
    await expect(history.turns('t', { scope, limit: 2, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    const anotherLimit = await history.turns('t', { scope, limit: 5 });
    expect(anotherLimit.revision).toBe(revalidated.revision);
    expect(codex.listTurns).toHaveBeenCalledTimes(4);
  });
  it('rotates a still-valid lease when fresh root contents reveal an external change', async () => {
    let now = 1000;
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e', now: () => now });
    const first = await history.turns('t', { scope });
    now += 5001;
    codex.listItems.mockResolvedValue({ data: [], nextCursor: null });
    const changed = await history.turns('t', { scope });
    expect(changed.revision).not.toBe(first.revision);
    await expect(history.turns('t', { scope, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    expect(changed.data.every(turn => turn.items.length === 0)).toBe(true);
  });
  it('does not return expired or evicted cursor tokens from the cached projection', async () => {
    let now = 1000;
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e', now: () => now, cursorTtlMs: 10, maxCursors: 1 });
    const first = await history.turns('t', { scope });
    now += 11;
    const second = await history.turns('t', { scope });
    expect(second.nextCursor).not.toBe(first.nextCursor);
    expect(codex.listTurns).toHaveBeenCalledTimes(1);
    await expect(history.turns('t', { scope, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'HISTORY_CURSOR_INVALID' });
    codex.listTurns.mockResolvedValueOnce({ data: [], nextCursor: null });
    expect((await history.turns('t', { scope, cursor: second.nextCursor! })).complete).toBe(true);
  });
  it('bounds retained entries and skips retaining pages larger than the byte budget', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e', cacheMaxEntries: 1 });
    await history.turns('t', { scope });
    await history.items('t', 'old', { scope });
    await history.turns('t', { scope });
    expect(codex.listTurns).toHaveBeenCalledTimes(2);
    const tiny = new NativeHistory(codex, { epoch: 'e', cacheMaxBytes: 1 });
    await tiny.items('t', 'old', { scope });
    await tiny.items('t', 'old', { scope });
    expect(codex.listItems).toHaveBeenCalledTimes(7);
  });
  it('discards affected pages for a content event without rotating the history revision', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    const first = await history.turns('t', { scope });
    history.discardCached('t');
    const next = await history.turns('t', { scope });
    expect(next.revision).toBe(first.revision);
    expect(codex.listTurns).toHaveBeenCalledTimes(2);
  });
  it('rejects late reads after invalidation and does not repopulate old content', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    let release!: () => void;
    codex.listItems.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ data: [{ turnId: 'old', item: item('stale') }], nextCursor: null }); }));
    const reading = history.items('t', 'old', { scope });
    await vi.waitFor(() => expect(codex.listItems).toHaveBeenCalledTimes(1));
    history.discardCached('t'); release();
    await expect(reading).rejects.toMatchObject({ code: 'HISTORY_STALE' });
    expect((await history.items('t', 'old', { scope })).data.map(item => item.id)).toEqual(['old-1', 'old-2']);
    expect(codex.listItems).toHaveBeenCalledTimes(2);
  });
  it('does not cache errors or retain stale pages when a security-sensitive read forces fresh data', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e' });
    codex.listItems.mockRejectedValueOnce(new CodexError('NATIVE_TIMEOUT', 'timeout', 'rejected'));
    await expect(history.items('t', 'old', { scope })).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' });
    await history.items('t', 'old', { scope });
    codex.listItems.mockResolvedValue({ data: [{ turnId: 'old', item: item('fresh') }], nextCursor: null });
    expect((await history.items('t', 'old', { scope, forceFresh: true })).data[0].id).toBe('fresh');
    expect((await history.items('t', 'old', { scope })).data[0].id).toBe('fresh');
    expect(codex.listItems).toHaveBeenCalledTimes(4);
  });
  it('drains parallel item RPCs before releasing history capacity on an early failure', async () => {
    const codex = peer(), history = new NativeHistory(codex, { epoch: 'e', maxConcurrent: 1 });
    let release!: () => void;
    codex.listItems.mockImplementation(async ({ turnId }) => {
      if (turnId === 'new') throw new CodexError('NATIVE_TIMEOUT', 'failure', 'rejected');
      return new Promise(resolve => { release = () => resolve({ data: [], nextCursor: null }); });
    });
    const reading = history.turns('t', { scope });
    await vi.waitFor(() => expect(codex.listItems).toHaveBeenCalledTimes(2));
    await expect(history.items('t', 'elsewhere', { scope })).rejects.toMatchObject({ code: 'HISTORY_BUSY' });
    release(); await expect(reading).rejects.toMatchObject({ code: 'NATIVE_TIMEOUT' });
  });
});
