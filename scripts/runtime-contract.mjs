import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'oraculum-release-'));
let child;
try {
  const resources = join(root, 'installed/resources/runtime');
  await cp(fileURLToPath(new URL('../dist/runtime', import.meta.url)), resources, { recursive: true, verbatimSymlinks: true });
  const home = join(root, 'home'), unrelated = join(root, 'unrelated');
  await mkdir(home); await mkdir(unrelated);
  const native = join(home, '.local/bin'); await mkdir(native, { recursive: true });
  const fixture = join(native, 'codex');
  await writeFile(fixture, `#!${join(resources, 'node/bin/node')}\nif(process.argv[2]==='--version'){console.log('codex-cli 9.9.9-fixture');process.exit(0)}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
require('node:fs').appendFileSync(process.env.FIXTURE_CALLS,m.method+'\\n');
const result=m.method==='initialize'?{userAgent:'fixture'}:m.method==='config/read'?{config:{model:null,model_provider:null,model_reasoning_effort:null}}:{data:[],nextCursor:null};
console.log(JSON.stringify({id:m.id,result}));});`, { mode: 0o700 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { HOME: home, PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'),
    ORACULUM_INIT_STATE: '1', ORACULUM_PORT: String(port), FIXTURE_CALLS: join(root, 'calls') };
  let output = '';
  child = spawn(join(resources, 'bin/oraculum-bridge'), { cwd: unrelated, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(child, 'exit');
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const deadline = Date.now() + 15000;
  while (!output.includes('codex-cli 9.9.9-fixture') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(output, /codex-cli 9.9.9-fixture/, output);
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(html, /Oraculum · 神谕/);
  const calls = await readFile(env.FIXTURE_CALLS, 'utf8');
  assert.doesNotMatch(calls, /thread\/start|turn\/start/);
  child.kill('SIGTERM'); assert.equal((await done)[0], 0); child = undefined;
  console.log('PASS: copied standalone runtime, private Node, production dependencies/assets, unrelated cwd, alternate HOME/XDG, CLI discovery, graceful stop; simulated Codex, zero turns');
} finally {
  if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  await rm(root, { recursive: true, force: true });
}
