const { app, BrowserWindow, session, Menu } = require('electron');
const { desktopPaths } = require('./paths.cjs');
const origin = process.env.ORACULUM_URL || 'http://127.0.0.1:17860';
const url = new URL(origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
  throw new Error('Oraculum Desktop only loads a local loopback Bridge');
}
const paths = desktopPaths(process.env);
app.setPath('userData', paths.userData);
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
    icon: paths.icon, backgroundColor: '#000000', title: 'Oraculum · 神谕',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A native menu/accelerator cannot be covered by theme CSS. Reload only the
  // configured trusted entry; renderer receives no IPC or OS capability.
  const restoreDefaultTheme = () => {
    const recovery = new URL(url.href); recovery.searchParams.set('theme', 'default');
    void window.loadURL(recovery.href);
  };
  // Shift+0 produces ')' on common Linux keyboard layouts. Match the physical
  // key in the native process; menu accelerator matching alone can miss it.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && input.control && input.shift && !input.alt && !input.meta && input.code === 'Digit0') {
      event.preventDefault();
      restoreDefaultTheme();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '神谕', submenu: [
      { id: 'restore-default-theme', label: '恢复默认主题', accelerator: 'CommandOrControl+Shift+0', click: restoreDefaultTheme },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { role: 'editMenu', label: '编辑' }, { role: 'viewMenu', label: '视图' },
  ]));
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (new URL(target).origin !== url.origin) event.preventDefault();
  });
  await window.loadURL(url.href);
});
app.on('window-all-closed', () => app.quit());
