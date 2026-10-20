const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const origin = process.env.ORACULUM_URL || 'http://127.0.0.1:17860';
const url = new URL(origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
  throw new Error('Phase 0B only loads a local loopback Bridge');
}
app.setPath('userData', path.join(app.getPath('appData'), 'oraculum-phase0b'));
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 1180, height: 850, backgroundColor: '#000000', title: 'Oraculum · 神谕',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  await window.loadURL(url.href);
});
app.on('window-all-closed', () => app.quit());
