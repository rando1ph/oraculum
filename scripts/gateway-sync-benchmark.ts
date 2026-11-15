import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { GatewayConfig } from '../gateway/src/config';
import type { CodexAdapter, NativeThread, NativeTurn } from '../gateway/src/codex';
import type { GatewayService as Service } from '../gateway/src/service';
import type { GatewayStore as Store } from '../gateway/src/store';
import type { createGatewayServer as serverFactory } from '../gateway/src/server';

/**
 * Isolated HTTP/Service benchmark. RPC latency is synthetic and fixed, not a
 * claim about a physical Android device, public network or production Codex.
 * Baseline source is read with git show; this never checks out another revision.
 *
 * pnpm exec tsx scripts/gateway-sync-benchmark.ts --baseline <commit> --output <file>
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function argument(name: string, fallback?: string) {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
    return value;
}
const baselineRef = argument('--baseline');
const variant = argument('--variant', 'both');
assert(['baseline', 'current', 'both'].includes(variant!), 'Invalid --variant');
assert(variant === 'current' || baselineRef, '--baseline <commit> is required');
const delayMs = Number(argument('--delay-ms', '10'));
assert(Number.isSafeInteger(delayMs) && delayMs >= 1 && delayMs <= 1000, 'Invalid --delay-ms');
const iterations = 10;
const round = (value: number) => Math.round(value * 100) / 100;
type RpcCounts = Record<string, number>;
type Runtime = {
    GatewayService: typeof Service;
    GatewayStore: typeof Store;
    createGatewayServer: typeof serverFactory;
    randomCredential: () => string;
    CodexError: new (code: string, message: string, outcome: string) => Error;
};

async function runtime(directory: string, baseline: boolean): Promise<Runtime> {
    const output = join(directory, `${baseline ? 'baseline' : 'current'}.mjs`);
    await build({
        stdin: {
            contents: [
                "export { GatewayService } from './gateway/src/service.ts';",
                "export { GatewayStore, randomCredential } from './gateway/src/store.ts';",
                "export { createGatewayServer } from './gateway/src/server.ts';",
                "export { CodexError } from './gateway/src/codex.ts';",
            ].join('\n'),
            resolveDir: root,
            sourcefile: 'gateway-sync-benchmark-entry.ts',
            loader: 'ts',
        },
        outfile: output,
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
        plugins: [{
            name: 'resolve-external-packages-at-source',
            setup(builder) {
                builder.onResolve({ filter: /^[^./]/ }, args => {
                    if (isBuiltin(args.path)) return { path: args.path, external: true };
                    return { path: createRequire(join(args.resolveDir || root, '__benchmark__.cjs')).resolve(args.path), external: true };
                });
            },
        }, ...(baseline ? [{
            name: 'read-only-baseline',
            setup(builder: import('esbuild').PluginBuild) {
                builder.onLoad({ filter: /gateway\/src\/(service|history)\.ts$/ }, ({ path }) => ({
                    contents: execFileSync('git', ['show', `${baselineRef}:${relative(root, path)}`], { cwd: root, encoding: 'utf8' }),
                    loader: 'ts',
                    resolveDir: dirname(path),
                }));
            },
        }] : [])],
    });
    return await import(pathToFileURL(output).href) as Runtime;
}

class FixtureCodex extends EventEmitter {
    alive = true;
    readonly counts: RpcCounts = {};
    readonly threadId = 'benchmark-thread';
    readonly turns: NativeTurn[] = Array.from({ length: 5 }, (_, index) => ({
        id: `benchmark-turn-${index}`,
        status: 'completed',
        items: [{ id: `benchmark-item-${index}`, type: 'agentMessage', text: `benchmark content ${index}` }],
    }));
    constructor(readonly cwd: string, private readonly errors: Runtime['CodexError'], private readonly fallback: boolean) { super(); }
    private async rpc(name: string) {
        this.counts[name] = (this.counts[name] ?? 0) + 1;
        await new Promise<void>(done => setTimeout(done, delayMs));
    }
    private thread(includeTurns: boolean): NativeThread {
        return { id: this.threadId, cwd: this.cwd, preview: 'benchmark content', name: 'Benchmark',
            status: { type: 'idle' }, createdAt: 1700000000, updatedAt: 1700000001,
            turns: includeTurns ? structuredClone(this.turns) : [] };
    }
    async readThread(_threadId: string, includeTurns = false) {
        await this.rpc(includeTurns ? 'thread/read:history' : 'thread/read:metadata');
        return { thread: this.thread(includeTurns) };
    }
    async listThreads() {
        await this.rpc('thread/list');
        return { data: [this.thread(false)], nextCursor: null };
    }
    async listTurns() {
        await this.rpc('thread/turns/list');
        if (this.fallback) throw new this.errors('NATIVE_PAGINATION_UNSUPPORTED', 'Synthetic unsupported pagination', 'rejected');
        return { data: [...this.turns].reverse().map(turn => ({ ...structuredClone(turn), items: [] })), nextCursor: null };
    }
    async listItems({ turnId }: { turnId: string }) {
        await this.rpc('thread/items/list');
        return { data: structuredClone(this.turns.find(turn => turn.id === turnId)!.items).reverse().map(item => ({ turnId, item })), nextCursor: null };
    }
    async close() { this.alive = false; }
}

async function fixture(api: Runtime, fallback = false) {
    const directory = await mkdtemp(join(tmpdir(), 'oraculum-sync-benchmark-'));
    const projectPath = join(directory, 'projects', 'fixture');
    await mkdir(projectPath, { recursive: true, mode: 0o700 });
    const store = new api.GatewayStore(join(directory, 'state'), { create: true });
    const config: GatewayConfig = { configVersion: 2, stateDir: store.stateDir, host: '127.0.0.1', port: 18796,
        basePath: '/', externalOrigin: null, allowedRoots: [{ id: 'fixture', path: join(directory, 'projects') }], codexCommand: 'unused-synthetic-fixture' };
    const codex = new FixtureCodex(projectPath, api.CodexError, fallback);
    const service = new api.GatewayService(store, config, codex as unknown as CodexAdapter);
    const app = await api.createGatewayServer(service, config);
    const device = service.auth.pair({ installationId: store.installationId, code: store.createPairing().code,
        deviceId: randomUUID(), deviceCredential: api.randomCredential(), label: 'Synthetic benchmark fixture' });
    const project = await service.projects.register('fixture', 'fixture');
    async function request(kind: 'snapshot' | 'list') {
        const start = performance.now();
        const response = await app.inject({ method: kind === 'snapshot' ? 'POST' : 'GET',
            url: kind === 'snapshot' ? `/api/v2/threads/${codex.threadId}/snapshot` : `/api/v2/projects/${project.id}/threads`,
            headers: { host: '127.0.0.1:18796', 'x-oraculum-protocol': '2', authorization: `Bearer ${device.accessToken}` },
            ...(kind === 'snapshot' ? { payload: { projectId: project.id } } : {}),
        });
        const durationMs = performance.now() - start;
        assert.equal(response.statusCode, 200, `${kind} failed: ${response.json().error?.code}`);
        const data = response.json().data;
        if (kind === 'snapshot') assert.equal(data.history.items.length, 5);
        else assert.equal(data.threads.length, 1);
        return { durationMs, data };
    }
    return { request, codex, service, async close() {
        await app.close(); await service.close(); store.close(); await rm(directory, { recursive: true, force: true });
    } };
}

function summary(samples: number[], counts: RpcCounts, totalMs: number, sequentialSamples = true) {
    const sorted = [...samples].sort((a, b) => a - b);
    const warm = sequentialSamples ? samples.slice(1) : [];
    return { samples: samples.length, rpcCount: Object.values(counts).reduce((a, b) => a + b, 0), rpcByMethod: { ...counts },
        totalMs: round(totalMs), coldMs: round(samples[0]),
        warmMeanMs: warm.length ? round(warm.reduce((a, b) => a + b, 0) / warm.length) : null,
        p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]) };
}

async function sequential(api: Runtime, kind: 'snapshot' | 'list', fallback = false) {
    const current = await fixture(api, fallback);
    try {
        const samples: number[] = [], start = performance.now();
        for (let index = 0; index < iterations; index++) samples.push((await current.request(kind)).durationMs);
        return summary(samples, current.codex.counts, performance.now() - start);
    } finally { await current.close(); }
}

async function concurrent(api: Runtime) {
    const current = await fixture(api);
    try {
        const start = performance.now();
        const results = await Promise.all([current.request('snapshot'), current.request('snapshot')]);
        return summary(results.map(result => result.durationMs), current.codex.counts, performance.now() - start, false);
    } finally { await current.close(); }
}

async function invalidated(api: Runtime) {
    const current = await fixture(api);
    try {
        await current.request('snapshot');
        for (const key of Object.keys(current.codex.counts)) delete current.codex.counts[key];
        const turn = current.codex.turns.at(-1)!;
        turn.items[0].text = 'updated after native event';
        current.codex.emit('notification', { method: 'item/completed', params: { threadId: current.codex.threadId,
            turnId: turn.id, item: structuredClone(turn.items[0]) } });
        await current.service.settled();
        const result = await current.request('snapshot');
        assert(result.data.history.items.some((entry: NativeTurn) => entry.items.some(item => item.text === 'updated after native event')),
            'Native event invalidation must return updated content');
        return { ...summary([result.durationMs], current.codex.counts, result.durationMs), updatedContentVerified: true };
    } finally { await current.close(); }
}

// Bundles live below the repository solely so external dependencies resolve from
// its node_modules. They and all databases are removed in finally, not committed.
await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
const bundleDirectory = await mkdtemp(join(root, '.local', 'sync-benchmark-bundles-'));
try {
    const results: Record<string, unknown> = { format: 1, measurement: 'synthetic authenticated Fastify inject + Gateway Service + temporary SQLite',
        limitations: ['Fixed synthetic native RPC delay; no physical Android, public network or production Codex measurement.',
            'Sequential warm reads occur inside the configured TTL; cold and invalidated reads are reported separately.'],
        delayPerRpcMs: delayMs, iterations, baselineCommit: baselineRef ?? null,
        baselineFiles: ['gateway/src/service.ts', 'gateway/src/history.ts'],
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0 };
    for (const name of ['baseline', 'current'] as const) {
        if (variant !== 'both' && variant !== name) continue;
        const api = await runtime(bundleDirectory, name === 'baseline');
        results[name] = { snapshotSequential: await sequential(api, 'snapshot'), threadListSequential: await sequential(api, 'list'),
            snapshotConcurrentTwo: await concurrent(api), snapshotAfterEvent: await invalidated(api),
            fallbackSnapshotSequential: await sequential(api, 'snapshot', true) };
    }
    const output = JSON.stringify(results, null, 2) + '\n';
    const destination = argument('--output');
    if (destination) { await mkdir(dirname(resolve(destination)), { recursive: true, mode: 0o700 }); await writeFile(destination, output, { mode: 0o600 }); }
    process.stdout.write(output);
} finally { await rm(bundleDirectory, { recursive: true, force: true }); }
