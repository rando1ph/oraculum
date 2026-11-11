import { it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { GatewayStore } from './store';
import { initGatewayConfig } from './config';
import { acquireGatewayLock } from './process-lock';
it('exits on native loss, releases the kernel lock and restarts with the same fresh installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oraculum-gateway-startup-')), state = join(root, 'state'), configPath = join(root, 'config/config.json');
    let child: ChildProcess | undefined;
    try {
        const probe = createServer();
        probe.listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = (probe.address() as {
            port: number;
        }).port;
        await new Promise<void>(done => probe.close(() => done()));
        const executable = join(root, 'codex-fixture'), exitSignal=join(root,'exit-native');
        await writeFile(executable, `#!${process.execPath}\nimport {createInterface} from 'node:readline';import{existsSync}from'node:fs';\nif(process.argv.includes('--version')){console.log('codex-test 0.0.0');process.exit(0);}\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'codex-test'}})+'\\n');if(m.method==='initialized')setInterval(()=>{if(existsSync(${JSON.stringify(exitSignal)}))process.exit(23);},10);}).on('close',()=>process.exit(0));\n`, { mode: 0o700 });
        initGatewayConfig({ configPath, stateDir: state, port, codexCommand: executable });
        const store = new GatewayStore(state, { create: true }), installationId = store.installationId;
        store.close();
        // The tsx import needs to be resolved before changing cwd.
        const fixtureRun = async () => {
            await rm(exitSignal,{force:true});
            child = spawn(process.execPath, ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href, resolve('gateway/src/main.ts'), '--config', configPath], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            child.stdout!.on('data', chunk => { output += chunk.toString();if(output.includes('Gateway is listening'))writeFileSync(exitSignal,'exit'); });
            child.stderr!.resume();
            const done = once(child, 'exit');
            const timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
            timer.unref();
            const [code, signal] = await done;
            clearTimeout(timer);
            expect({ code, signal }).toEqual({ code: 1, signal: null });
            expect(output).toContain('Gateway is listening');
        };
        await fixtureRun();
        const unlock = acquireGatewayLock(state);
        unlock();
        await fixtureRun();
        const reopened = new GatewayStore(state);
        expect(reopened.installationId).toBe(installationId);
        reopened.close();
    }
    finally {
        child?.kill('SIGKILL');
        await rm(root, { recursive: true, force: true });
    }
}, 20000);
