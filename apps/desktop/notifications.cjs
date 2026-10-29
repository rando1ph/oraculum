const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const copy = { completed: '任务已完成', failed: '任务执行失败', approval: '任务等待审批', input: '任务等待你的回答' };
const noticeId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

function startNotifications({ window, origin, icon, userData, Notification }) {
  const file = join(userData, 'notification-seen.json');
  let saved;
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* First launch. */ }
  const seen = new Set(Array.isArray(saved) ? saved.filter(noticeId).slice(-512) : []);
  const active = new Map();
  let stopped = false, timer, expires, controller;
  const clear = () => { for (const notification of active.values()) notification.close(); active.clear(); };
  const trusted = () => !window.isDestroyed() && new URL(window.webContents.getURL()).origin === origin;
  const feed = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await window.webContents.session.fetch(origin + '/notifications', {
        headers: { Origin: origin, 'X-Oraculum-Notifications': '1' }, credentials: 'include',
        cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Notification feed unavailable');
      const body = await response.text();
      if (body.length > 65536) throw new Error('Notification feed too large');
      const value = JSON.parse(body);
      if (!Array.isArray(value.notices) || value.notices.length > 64 || !Number.isFinite(value.generatedAt) ||
          value.validUntil - value.generatedAt <= 0 || value.validUntil - value.generatedAt > 15000) throw new Error('Invalid notification feed');
      return value;
    } finally { clearTimeout(timeout); }
  };
  const poll = async () => {
    try {
      if (!trusted() || !Notification.isSupported()) { clear(); return; }
      const value = await feed();
      if (stopped || !trusted()) return;
      clearTimeout(expires); expires = setTimeout(clear, value.validUntil - value.generatedAt);
      const current = new Set(value.notices.filter(n => noticeId(n.id) && Object.hasOwn(copy, n.kind) && n.expiresAt > value.generatedAt).map(n => n.id));
      for (const [id, notification] of active) if (!current.has(id)) { notification.close(); active.delete(id); }
      for (const notice of value.notices) {
        if (!current.has(notice.id) || seen.has(notice.id)) continue;
        const notification = new Notification({ title: `神谕 · ${copy[notice.kind]}`, body: '点击返回会话查看。', icon, timeoutType: 'default' });
        active.set(notice.id, notification);
        notification.on('click', () => {
          if (!trusted() || !active.has(notice.id)) return;
          // Only an opaque identifier enters the page. React rechecks the live
          // authenticated feed and subscribes normally; clicking never approves.
          if (window.isMinimized()) window.restore();
          window.show(); window.focus();
          void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify('notice=' + notice.id)}`).catch(() => {});
        });
        notification.on('failed', () => { active.delete(notice.id); });
        notification.show(); seen.add(notice.id);
      }
      while (seen.size > 512) seen.delete(seen.values().next().value);
      const serialized = JSON.stringify([...seen]);
      if (serialized !== saved) {
        try { writeFileSync(file, serialized, { mode: 0o600 }); saved = serialized; } catch { /* In-memory deduplication remains available. */ }
      }
    } catch { clear(); }
    finally { if (!stopped) timer = setTimeout(poll, 2000); }
  };
  void poll();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(expires); controller?.abort(); clear(); };
}
module.exports = { startNotifications };
