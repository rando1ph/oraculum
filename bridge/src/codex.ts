import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { WireMessage, RpcId } from '../../packages/shared/protocol';

export class NativeRpcError extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

export class Codex extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  alive = true;
  constructor(cwd: string) {
    super();
    if (execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.160.0') {
      throw new Error('Codex version changed. Regenerate and review the protocol before running.');
    }
    // Read only MCP names; override enabled flags in a TOML value, because the
    // CLI splits dotted override keys even inside quoted server names.
    const names: string[] = JSON.parse(execFileSync('python3', ['-c',
      'import pathlib,tomllib,json,os; p=pathlib.Path(os.environ.get("CODEX_HOME",str(pathlib.Path.home()/".codex")))/"config.toml"; print(json.dumps(list(tomllib.loads(p.read_text()).get("mcp_servers",{})) if p.exists() else []))'
    ], { encoding: 'utf8' }));
    const disabledMcp = `{${names.map(name => `${JSON.stringify(name)}={enabled=false}`).join(',')}}`;
    const overrides = [
      `mcp_servers=${disabledMcp}`, 'features.apps=false', 'features.plugins=false',
      'features.multi_agent=false', 'web_search="disabled"',
    ];
    this.child = spawn('codex', ['app-server', '--listen', 'stdio://', ...overrides.flatMap(value => ['-c', value])], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Drain stderr without logging configuration, prompts, or credentials.
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line) as WireMessage); }
      catch { this.fail(new Error('Invalid App Server message')); this.child.kill(); }
    });
    this.child.on('error', () => this.fail(new Error('App Server process failed')));
    this.child.on('exit', () => this.fail(new Error('App Server exited; outstanding operations may have unknown results')));
  }
  private receive(message: WireMessage) {
    if (message.method) { this.emit('message', message); return; }
    if (message.id === undefined) return;
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.error) request.reject(new NativeRpcError(message.error.message, message.error.code));
    else request.resolve(message.result);
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
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.send({ id, method, params: params as Record<string, unknown> });
    });
  }
  async initialize(experimentalApi = false) {
    const result = await this.request('initialize', {
      clientInfo: { name: 'oraculum', title: 'Oraculum', version: '0.1.0' },
      capabilities: { experimentalApi },
    });
    this.send({ method: 'initialized', params: {} });
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
