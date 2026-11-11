import { execFileSync } from 'node:child_process';
import { loadGatewayConfig, defaultConfigPath } from './config';
import { GatewayStore } from './store';
import { acquireGatewayLock } from './process-lock';
import { CodexAdapter } from './codex';
import { GatewayService } from './service';
import { createGatewayServer } from './server';
async function main() {
    process.umask(0o077);
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--config'))
        throw new Error('Usage: oraculum-gateway [--config PATH]');
    const config = loadGatewayConfig(args[1] ?? defaultConfigPath());
    const release = acquireGatewayLock(config.stateDir);
    const store = new GatewayStore(config.stateDir);
    // Neutral private cwd avoids inheriting this source repository's project instructions.
    const codex = new CodexAdapter({ cwd: config.stateDir, executable: config.codexCommand });
    let codexVersion = 'unknown';
    try {
        codexVersion = execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().slice(0, 100);
    }
    catch { }
    const service = new GatewayService(store, config, codex, { codexVersion });
    let app: Awaited<ReturnType<typeof createGatewayServer>> | undefined;
    let stopping = false;
    const stop = async () => { if (stopping)
        return; stopping = true; try {
        await app?.close();
        await service.close();
    }
    finally {
        store.close();
        release();
    } };
    codex.on('unavailable', () => { if (!stopping) {
        process.exitCode = 1;
        void stop();
    } });
    process.once('SIGTERM', () => void stop());
    process.once('SIGINT', () => void stop());
    try {
        await codex.start();
        app = await createGatewayServer(service, config);
        await app.listen({ host: config.host, port: config.port });
        process.stdout.write('Oraculum Gateway is listening on the configured loopback endpoint.\n');
    }
    catch (error) {
        await stop();
        throw error;
    }
}
main().catch(() => { process.stderr.write('Gateway could not start. Check its private configuration, state permissions, port, and official Codex installation.\n'); process.exitCode = 1; });
