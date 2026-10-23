import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { WireMessage, RpcId } from '../../packages/shared/protocol';
import { codexExecutable, readCodexVersion } from './version';
import { CodexCompatibilityError, validateNativeResponse } from './compatibility';

export class NativeRpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

export class Codex extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<RpcId, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly version: string;
  alive = true;
  constructor(private readonly cwd: string) {
    super();
    const binary = codexExecutable();
    this.version = readCodexVersion(binary);
    // Codex owns effective config resolution (including CODEX_HOME, project
    // layers, enabled and explicitly disabled capabilities). Do not override it.
    this.child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Drain stderr without logging configuration, prompts, or credentials.
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line) as WireMessage); }
      catch { this.fail(new Error(`${this.version}: invalid App Server message; outstanding operation results may be unknown`)); this.child.kill(); }
    });
    this.child.on('error', () => this.fail(new Error('App Server process failed')));
    this.child.on('exit', () => this.fail(new Error('App Server exited; outstanding operations may have unknown results')));
  }
  private receive(message: WireMessage) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid RPC envelope');
    if (message.method) { this.emit('message', message); return; }
    if (message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if ('error' in message) {
      if (!message.error || typeof message.error.message !== 'string' || !Number.isInteger(message.error.code) || 'result' in message) {
        request.reject(new CodexCompatibilityError(this.version, request.method, 'error'));
      } else request.reject(new NativeRpcError(`${this.version}: ${request.method}: ${message.error.message}`, message.error.code));
    } else {
      try {
        if (!('result' in message)) throw new CodexCompatibilityError(this.version, request.method, 'result');
        validateNativeResponse(this.version, request.method, message.result);
        request.resolve(message.result);
      } catch (error) { request.reject(error as Error); }
    }
  }
  private fail(error: Error) {
    if (!this.alive) return;
    this.alive = false;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.emit('unavailable', error.message);
  }
  send(message: WireMessage) {
    if (!this.alive) throw new Error('App Server unavailable');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request<T>(method: string, params: object): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('App Server unavailable'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: response timeout; result unknown, do not retry automatically`));
      }, 60_000);
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer });
      this.send({ id, method, params: params as Record<string, unknown> });
    });
  }
  async initialize(experimentalApi = false) {
    const result = await this.request('initialize', {
      clientInfo: { name: 'oraculum', title: 'Oraculum', version: '0.1.0' },
      capabilities: { experimentalApi },
    });
    this.send({ method: 'initialized', params: {} });
    // Detect missing essential read APIs before advertising a usable Bridge.
    // Native thread/turn mutation is only validated when explicitly requested.
    await this.request('config/read', { cwd: this.cwd, includeLayers: false });
    await this.request('model/list', { limit: 1, includeHidden: false });
    await this.request('thread/list', { cwd: this.cwd, limit: 1, modelProviders: [] });
    return result;
  }
  async close() {
    if (!this.alive) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
