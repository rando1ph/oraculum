const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const origin = process.env.ORACULUM_URL || 'http://127.0.0.1:17860';
const url = new URL(origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
  throw new Error('Oraculum Desktop only loads a local loopback Bridge');
}
app.setPath('userData', process.env.ORACULUM_USER_DATA_DIR || path.join(app.getPath('appData'), 'oraculum-phase0b'));
app.whenReady().then(async () => {
  // Copy buttons may write text. Clipboard reads and every other permission stay denied.
  const allowCopy = (contents, permission, details) => {
    try {
      return permission === 'clipboard-sanitized-write' && details.isMainFrame &&
        new URL(details.requestingUrl).origin === url.origin &&
        contents && new URL(contents.getURL()).origin === url.origin;
    } catch { return false; }
  };
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(allowCopy(contents, permission, details)));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    requestingOrigin === url.origin && Boolean(allowCopy(contents, permission, details)));
  const window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 720, minHeight: 560, autoHideMenuBar: true,
    icon: path.join(__dirname, '../../design/reference/02_Brand_OracleEye_App_Icon.png'), backgroundColor: '#000000', title: 'Oraculum · 神谕',
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
