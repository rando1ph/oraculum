import { AsyncLocalStorage } from 'node:async_hooks';
// Correlation metadata only. Never put RPC params or native content here.
export const requestTrace = new AsyncLocalStorage<string>();
