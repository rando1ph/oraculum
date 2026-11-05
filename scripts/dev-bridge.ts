import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { developmentEnvironment } = require('./dev-environment.cjs');
const production: NodeJS.ProcessEnv[] = [];
let active = true;
try {
  const pid = Number(execFileSync('systemctl', ['--user', 'show', 'oraculum-bridge.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim());
  active = pid > 0;
  // Include the installed launcher and its runtime child, without logging values.
  const visit = (id: number) => {
    if (!id) return;
    production.push(Object.fromEntries(readFileSync(`/proc/${id}/environ`, 'utf8').split('\0').filter(v => v.includes('=')).map(v => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)])));
    for (const child of readFileSync(`/proc/${id}/task/${id}/children`, 'utf8').trim().split(/\s+/).filter(Boolean)) visit(Number(child));
  };
  visit(pid);
} catch { throw new Error('Cannot inspect the installed Bridge; refusing an unverified development launch'); }
const env = developmentEnvironment(process.env, resolve('.'), production) as NodeJS.ProcessEnv;
const port = Number(env.ORACULUM_PORT);
if (port === 17860 && (active || process.env.ORACULUM_DEV_ALLOW_PUBLIC_TEST !== '1')) throw new Error('Public-chain test port requires a stopped production Bridge and ORACULUM_DEV_ALLOW_PUBLIC_TEST=1');
await new Promise<void>((yes, no) => { const probe = createServer(); probe.once('error', no); probe.listen(port, '127.0.0.1', () => probe.close(() => yes())); });
mkdirSync(env.HOME!, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ mode: 'isolated-development', port, root: env.ORACULUM_DEV_ROOT }));
const child = spawn(process.execPath, ['--import', 'tsx', 'bridge/src/main.ts'], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => child.kill(signal));
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
