const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadRuntimeConfig } = require('./runtime-config.cjs');
loadRuntimeConfig();
process.env.ORACULUM_RESOURCE_DIR = __dirname;
const command = process.argv[2];
if (command && !['trust', 'preflight'].includes(command)) throw new Error('Usage: oraculum-bridge [trust pair|list|revoke | preflight]');
if (command) process.argv.splice(2, 1);
import(pathToFileURL(join(__dirname, 'bridge', command === 'trust' ? 'trust.mjs' : command === 'preflight' ? 'preflight.mjs' : 'main.mjs')).href);
