// Opt-in installed-binary contract check. No model calls, credentials or global config writes.
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { BridgeService } from '../bridge/src/service';
import type { LocalConfig, Snapshot } from '../packages/shared/protocol';
import type { ThreadStartResponse } from '../.local/codex-protocol/v2/ThreadStartResponse';
import type { ConfigReadResponse } from '../.local/codex-protocol/v2/ConfigReadResponse';

const previous = process.env.CODEX_HOME;
const fixture = await mkdtemp(join(tmpdir(), 'oraculum-native-config-'));
try {
  process.env.CODEX_HOME = fixture;
  for (const enabled of [false, true]) {
    const sandbox = enabled ? 'workspace-write' : 'read-only';
    const approval = enabled ? 'on-request' : 'never';
    await writeFile(join(fixture, 'config.toml'), `sandbox_mode = "${sandbox}"
approval_policy = "${approval}"
web_search = "${enabled ? 'cached' : 'disabled'}"
[features]
apps = ${enabled}
plugins = ${enabled}
multi_agent = ${enabled}
[mcp_servers.explicitly_disabled]
command = "must-never-be-launched"
enabled = false
`, { mode: 0o600 });
    const cliFeatures = execFileSync('codex', ['features', 'list'], { cwd: fixture, encoding: 'utf8' });
    for (const flag of ['apps', 'plugins', 'multi_agent']) {
      assert.match(cliFeatures, new RegExp(`^${flag}\\s+\\S+\\s+${enabled}$`, 'm'));
    }
    const codex = new Codex(fixture);
    const service = new BridgeService(codex, fixture);
    try {
      await codex.initialize();
      const raw = await codex.request<ConfigReadResponse>('config/read', { cwd: fixture });
      for (const flag of ['apps', 'plugins', 'multi_agent']) assert.equal((raw.config.features as Record<string, boolean>)[flag], enabled);
      assert.equal((raw.config.mcp_servers as any).explicitly_disabled.enabled, false);
      const projected = await service.dispatch('bridge/config', {}) as LocalConfig;
      assert.equal(projected.sandbox, sandbox);
      assert.equal(projected.approvalPolicy, approval);
      assert.equal(projected.webSearch, enabled ? 'cached' : 'disabled');
      const started = await service.dispatch('thread/start', {}) as ThreadStartResponse;
      assert.equal(started.approvalPolicy, approval);
      assert.equal(started.sandbox.type, enabled ? 'workspaceWrite' : 'readOnly');
      const initial = await service.dispatch('bridge/subscribe', { threadId: started.thread.id }) as Snapshot;
      assert.deepEqual(initial.settings, { approvalPolicy: started.approvalPolicy, sandbox: started.sandbox, approvalsReviewer: started.approvalsReviewer });
      // Empty threads are not persisted by 0.160.0. Restart/resume is covered
      // separately using real completed turns, never fabricated history here.
      console.log(JSON.stringify({ enabled, cliMatchesBridge: true, explicitDisabledMcpPreserved: true, sandbox, approval }));
    } finally { await codex.close(); }
  }
} finally {
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
  await rm(fixture, { recursive: true, force: true });
}
