/** Synthetic read benchmark: no installed Gateway, native thread or user data is used. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexError, type NativeItem, type NativeThread, type NativeTurn } from '../gateway/src/codex';
import { NativeHistory } from '../gateway/src/history';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultBaseline = 'f8a11b6992f555d2b7003b13bd092f931afd0b0b';
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--baseline'), 'Usage: pnpm exec tsx scripts/gateway-history-benchmark.ts [--baseline SHA]');
const baseline = args[1] ?? defaultBaseline;
assert.match(baseline, /^[a-f0-9]{7,40}$/, 'The baseline must be an existing commit SHA');
const rpcDelayMs = 10;
const pause = () => new Promise<void>(resolve => setTimeout(resolve, rpcDelayMs));
const scope = 'benchmark-device:benchmark-project';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const nativeTurns: NativeTurn[] = Array.from({ length: 5 }, (_, index) => ({
  id: `turn-${index}`, status: 'completed',
  items: Array.from({ length: 2 }, (_, item) => ({ id: `item-${index}-${item}`, type: 'agentMessage', text: `fixture-${index}-${item}` })),
}));
const nativeThread: NativeThread = { id: 'benchmark-thread', cwd: '/benchmark', preview: '', status: { type: 'idle' }, turns: nativeTurns };

function peer(fallback: boolean) {
  const counts = { listTurns: 0, listItems: 0, readThread: 0 };
  return { counts, adapter: {
    async listTurns({ limit }: { limit: number }) {
      counts.listTurns++; await pause();
      if (fallback) throw new CodexError('NATIVE_PAGINATION_UNSUPPORTED', 'Synthetic unsupported pagination', 'rejected');
      return { data: clone(nativeTurns.slice(-limit).reverse().map(turn => ({ ...turn, items: [] }))), nextCursor: null };
    },
    async listItems({ turnId }: { turnId: string }) {
      counts.listItems++; await pause();
      const turn = nativeTurns.find(turn => turn.id === turnId)!;
      return { data: clone([...turn.items].reverse().map(item => ({ turnId, item }))), nextCursor: null };
    },
    async readThread() { counts.readThread++; await pause(); return { thread: clone(nativeThread) }; },
  } };
}

type Sample = {
  scenario: string;
  requests: number;
  rpc: { listTurns: number; listItems: number; readThread: number };
  elapsedMs: number;
  content: unknown;
};

async function measure(History: typeof NativeHistory, scenario: string, repeats: number, options: { concurrent?: boolean; items?: boolean; fallback?: boolean } = {}): Promise<Sample> {
  const fixture = peer(options.fallback ?? false);
  const history = new History(fixture.adapter as ConstructorParameters<typeof NativeHistory>[0], { epoch: 'benchmark-epoch' });
  const started = performance.now();
  const read = async () => options.items
    ? (await history.items(nativeThread.id, nativeTurns[4].id, { scope })).data
    : (await history.turns(nativeThread.id, { scope, limit: 5 })).data;
  const pages: (NativeItem[] | NativeTurn[])[] = [];
  if (options.concurrent) pages.push(...await Promise.all(Array.from({ length: repeats }, read)));
  else for (let index = 0; index < repeats; index++) pages.push(await read());
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const expected = options.items ? nativeTurns[4].items : nativeTurns;
  for (const page of pages) {
    // Projection adds display-only metadata; compare authoritative fixture identities/text/status.
    const content = options.items ? page : (page as NativeTurn[]).map(({ id, status, items }) => ({ id, status, items }));
    assert.deepEqual(content, expected);
  }
  return { scenario, requests: Object.values(fixture.counts).reduce((sum, count) => sum + count, 0), rpc: fixture.counts, elapsedMs, content: pages[0] };
}

const temporary = await mkdtemp(join(tmpdir(), 'oraculum-history-benchmark-'));
try {
  const oldSource = execFileSync('git', ['show', `${baseline}:gateway/src/history.ts`], { cwd: repository, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const dependency = resolve(repository, 'gateway/src/codex.ts');
  assert.ok(oldSource.includes("from './codex'"), 'The baseline import layout changed; inspect the benchmark loader');
  const filename = join(temporary, 'baseline-history.mts');
  await writeFile(filename, oldSource.replace("from './codex'", `from ${JSON.stringify(dependency)}`)
    .replace("from './read-cache'", `from ${JSON.stringify(resolve(repository, 'gateway/src/read-cache.ts'))}`));
  const PreviousHistory = (await import(pathToFileURL(filename).href)).NativeHistory as typeof NativeHistory;
  const scenarios: [string, number, Parameters<typeof measure>[3]][] = [
    ['cold-five-turn-page', 1, {}],
    ['ten-repeated-five-turn-pages', 10, {}],
    ['two-concurrent-identical-pages', 2, { concurrent: true }],
    ['ten-repeated-item-pages', 10, { items: true }],
    ['ten-repeated-fallback-pages', 10, { fallback: true }],
  ];
  const results = [];
  for (const [scenario, repeats, options] of scenarios) {
    const before = await measure(PreviousHistory, scenario, repeats, options);
    const after = await measure(NativeHistory, scenario, repeats, options);
    assert.deepEqual(after.content, before.content, `${scenario}: baseline and current projections differ`);
    const { content: previousContent, ...previous } = before;
    const { content: currentContent, ...current } = after;
    results.push({ scenario, before: previous, after: current, rpcReductionPercent: Math.round((1 - after.requests / before.requests) * 10000) / 100 });
  }
  process.stdout.write(`${JSON.stringify({ baseline, fixture: { rpcDelayMs, turns: 5, itemsPerTurn: 2 }, results }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
