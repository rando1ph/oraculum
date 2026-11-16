import { describe, expect, it } from 'vitest';
import { APP_ENTRY } from './bundle';
import { isTrustedSender } from './ipc';

function fixture() {
  const frame = { url: APP_ENTRY, detached: false, isDestroyed: () => false };
  const sender = { mainFrame: frame, getURL: () => APP_ENTRY, isDestroyed: () => false };
  return { sender, event: { sender, senderFrame: frame } };
}

describe('Desktop IPC sender boundary', () => {
  it('accepts only the live registered window main frame', () => {
    const { sender, event } = fixture();
    expect(isTrustedSender(event, sender)).toBe(true);
  });
  it.each(['other-window', 'child-frame', 'no-frame', 'foreign-url', 'same-origin-path', 'query', 'destroyed-window', 'destroyed-frame', 'detached-frame'])('rejects %s', scenario => {
    const { sender, event } = fixture();
    if (scenario === 'other-window') event.sender = { ...sender };
    if (scenario === 'child-frame') event.senderFrame = { ...sender.mainFrame };
    if (scenario === 'no-frame') Object.assign(event, { senderFrame: null });
    if (scenario === 'foreign-url') sender.mainFrame.url = 'https://example.invalid/';
    if (scenario === 'same-origin-path') sender.mainFrame.url = 'oraculum-app://bundle/other.html';
    if (scenario === 'query') sender.mainFrame.url = `${APP_ENTRY}?untrusted=1`;
    if (scenario === 'destroyed-window') sender.isDestroyed = () => true;
    if (scenario === 'destroyed-frame') sender.mainFrame.isDestroyed = () => true;
    if (scenario === 'detached-frame') sender.mainFrame.detached = true;
    expect(isTrustedSender(event, sender)).toBe(false);
  });
});
