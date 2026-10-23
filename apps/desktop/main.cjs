const { app, BrowserWindow, session, Menu, dialog } = require('electron');
const { prepareDesktopPaths } = require('./paths.cjs');
const { configureRuntime, ensureBridge } = require('./runtime.cjs');
configureRuntime(app);
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
  const connect = async () => {
    try {
      if (app.isPackaged) await ensureBridge(app, url);
      await window.loadURL(url.href);
    } catch {
      const result = await dialog.showMessageBox(window, { type: 'error', title: '神谕',
        message: '无法连接本机 Bridge', detail: '请检查已选择的运行配置、官方 Codex 和用户服务。首次安装须先完成明确的数据选择与服务注册。',
        buttons: ['重试', '退出'], defaultId: 0, cancelId: 1 });
      if (result.response === 0) void connect(); else app.quit();
    }
  };
  await connect();
});
app.on('window-all-closed', () => app.quit());
