const { app, BrowserWindow, session, Menu, dialog } = require('electron');
const { join, resolve } = require('node:path');
const { prepareDesktopPaths } = require('./paths.cjs');
const { configureRuntime, ensureBridge } = require('./runtime.cjs');
configureRuntime(app);
app.setName('神谕');
app.setDesktopName('oraculum.desktop');
const origin = process.env.ORACULUM_URL || `http://127.0.0.1:${process.env.ORACULUM_PORT || 17860}`;
const url = new URL(origin);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') {
  throw new Error('Oraculum Desktop only loads a local loopback Bridge');
}
const paths = prepareDesktopPaths(process.env);
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
    show: false, icon: paths.icon, backgroundColor: '#000000', title: '神谕',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false },
  });
  window.on('page-title-updated', event => event.preventDefault());
  const splashFile = join(process.env.ORACULUM_RESOURCE_DIR || resolve(__dirname, '../..'), 'apps/desktop/splash.html');
  let splash;
  let connecting = false;
  const showSplash = async (failed = false) => {
    if (!splash || splash.isDestroyed()) {
      splash = new BrowserWindow({ width: 880, height: 720, minWidth: 360, minHeight: 480,
        show: false, autoHideMenuBar: true, backgroundColor: '#000000', title: '神谕', icon: paths.icon,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
      splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      splash.webContents.on('will-navigate', (event, target) => {
        event.preventDefault();
        if (target === 'oraculum://retry') void connect();
        if (target === 'oraculum://quit') app.quit();
      });
      splash.webContents.on('will-redirect', event => event.preventDefault());
      splash.on('closed', () => { if (!window.isDestroyed() && !window.isVisible()) app.quit(); });
    }
    try {
      await splash.loadFile(splashFile, { query: failed ? { state: 'error' } : {} });
    } catch {
      if (window.isDestroyed()) return;
      dialog.showErrorBox('神谕', '本地启动资源无法加载。请核对安装包资源完整性后重新启动。');
      app.quit();
      return;
    }
    if (!splash.isDestroyed()) splash.show();
  };
  const handoff = () => {
    if (window.isDestroyed()) return;
    window.setTitle('神谕');
    window.show();
    if (splash && !splash.isDestroyed()) splash.close();
  };
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A native menu/accelerator cannot be covered by theme CSS. Reload only the
  // configured trusted entry; renderer receives no IPC or OS capability.
  const restoreDefaultTheme = () => {
    const recovery = new URL(url.href); recovery.searchParams.set('theme', 'default');
    void connect(recovery.href);
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
  const connect = async (target = url.href) => {
    if (connecting || window.isDestroyed()) return;
    connecting = true;
    try {
      if (app.isPackaged) await ensureBridge(app, url);
      await window.loadURL(target);
      handoff();
    } catch {
      if (window.isDestroyed()) return;
      window.hide();
      await showSplash(true);
    } finally { connecting = false; }
  };
  await showSplash();
  await connect();
});
app.on('window-all-closed', () => app.quit());
