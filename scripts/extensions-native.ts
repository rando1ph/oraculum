// Read-only real App Server probe. No threads/turns, config writes, tool calls,
// feature overrides or remote marketplace refresh. Persist counts only.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Codex } from '../bridge/src/codex';
import { readExtensions } from '../bridge/src/extensions';

const codex = new Codex(resolve('.'));
try {
  await codex.initialize();
  const value = await readExtensions((method, params) => codex.request(method, params), resolve('.'));
  const evidence = { version: codex.version, experimentalApi: false, nativeTurns: 0,
    scope: 'project inventory; no loaded thread, so MCP runtime can be unknown',
    lists: Object.fromEntries(Object.entries(value.lists).map(([kind, list]) => [kind, {
      status: list.status, count: list.entries.length,
      enabled: list.entries.filter(entry => entry.enabled === true).length,
      installed: list.entries.filter(entry => entry.installed === true).length,
      callable: list.entries.filter(entry => entry.callable === true).length,
      unknownRuntime: list.entries.filter(entry => entry.runtimeStatus === null).length,
      message: list.message,
    }])) };
  await mkdir('.local/evidence/r1-b6', { recursive: true });
  await writeFile('.local/evidence/r1-b6/native-inventory.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await codex.close(); }
