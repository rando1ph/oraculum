import type { Page } from '@playwright/test';
import type { Snapshot } from '../packages/shared/protocol';

// Test identities belong in metadata, not developer diagnostics in ordinary chat.
export async function selectedThreadId(page: Page): Promise<string> {
  const id = await page.locator('.conversation').getAttribute('data-thread-id');
  if (id === null) throw new Error('Conversation identity metadata is missing');
  return id;
}

// Read receipts through the same authenticated Bridge protocol as the UI. This
// opens no turn and performs no approval; closing the probe leaves the UI alone.
export async function sessionSnapshot(page: Page): Promise<Snapshot> {
  const threadId = await selectedThreadId(page);
  if (!threadId) throw new Error('Select a conversation before checking its snapshot');
  return page.evaluate(threadId => new Promise<Snapshot>((resolve, reject) => {
    const url = new URL('ws', new URL('.', location.href));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href), id = crypto.randomUUID();
    // A method avoids tsx's inferred-function-name helper in serialized browser
    // code; that helper exists in Node, not the target Electron/WebView page.
    const probe = { finish(error?: Error, snapshot?: Snapshot) {
      clearTimeout(timeout); socket.onclose = null; socket.onerror = null; socket.close();
      if (error) reject(error); else resolve(snapshot!);
    }
    };
    const timeout = setTimeout(() => probe.finish(new Error('Snapshot probe timed out')), 30_000);
    socket.onopen = () => socket.send(JSON.stringify({ id, method: 'bridge/subscribe', params: { threadId } }));
    socket.onerror = () => probe.finish(new Error('Snapshot probe could not connect'));
    socket.onclose = () => probe.finish(new Error('Snapshot probe closed before replying'));
    socket.onmessage = ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.id !== id) return;
        if (message.error) probe.finish(new Error(message.error.message));
        else probe.finish(undefined, message.result as Snapshot);
      } catch (error) { probe.finish(error instanceof Error ? error : new Error(String(error))); }
    };
  }), threadId);
}
