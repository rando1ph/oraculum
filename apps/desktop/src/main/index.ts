import { app, BrowserWindow, dialog, Menu, nativeImage, protocol, session } from 'electron';
import { join } from 'node:path';
import { APP_ENTRY, APP_SCHEME, isBundleRequest, loadBundle, respondToBundleRequest } from './bundle';
import { registerDesktopIpc } from './ipc';
import { PreferencesStore } from './preferences';
import { prepareProfile } from './profile';

// This entry has no Gateway/Bridge transport, process execution or service lifecycle.
app.setName('神谕 Desktop');
app.setDesktopName('oraculum-desktop.desktop');
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let window: BrowserWindow | undefined;
let failureReported = false;

async function startupFailure(): Promise<void> {
  if (failureReported) return;
  failureReported = true;
  await app.whenReady();
  dialog.showErrorBox('神谕无法启动', '本地应用资源或独立配置未通过安全检查。请重新构建应用，或检查 Desktop 专用配置目录的权限。原有数据未被清除。');
  app.exit(1);
}

async function start(): Promise<void> {
  if (app.commandLine.hasSwitch('no-sandbox') || app.commandLine.hasSwitch('disable-setuid-sandbox')) {
    throw new Error('DESKTOP_SANDBOX_REQUIRED');
  }
  const distribution = join(__dirname, '..');
  const bundle = loadBundle(join(distribution, 'renderer'), join(distribution, 'renderer-manifest.json'));
  const profile = prepareProfile(app.isPackaged);
  app.setPath('userData', profile.directory);
  app.setPath('sessionData', profile.session);
  app.setPath('crashDumps', profile.crashDumps);
  app.setAppLogsPath(profile.logs);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  const preferences = new PreferencesStore(profile.directory);
  await app.whenReady();
  const isolatedSession = session.defaultSession;
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setDevicePermissionHandler(() => false);
  isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  isolatedSession.setSpellCheckerEnabled(false);
  isolatedSession.on('will-download', event => event.preventDefault());
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isBundleRequest(details.url, details.method, bundle) });
  });
  isolatedSession.protocol.handle(APP_SCHEME, request => respondToBundleRequest(request, bundle));

  const icon = nativeImage.createFromPath(join(distribution, 'icon.png'));
  if (icon.isEmpty()) throw new Error('DESKTOP_BUNDLE_INVALID');
  const initial = preferences.read().preferences;
  const background = initial.theme === 'light' ? '#fbfcf9' : initial.theme === 'oled' ? '#000000' : '#171b16';
  window = new BrowserWindow({
    width: 1440, height: 960, minWidth: 960, minHeight: 640,
    show: false, title: '神谕 · Oraculum', icon, backgroundColor: background,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(distribution, 'preload/index.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, webviewTag: false, allowRunningInsecureContent: false,
      spellcheck: false, navigateOnDragDrop: false,
    },
  });
  const currentWindow = window;
  const contents = currentWindow.webContents;
  const ipc = registerDesktopIpc(contents, preferences, profile.kind);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  currentWindow.on('page-title-updated', event => event.preventDefault());
  currentWindow.on('closed', () => { ipc.dispose(); window = undefined; });

  const restoreAppearance = (): void => {
    if (currentWindow.isDestroyed()) return;
    try {
      preferences.reset();
      contents.setZoomFactor(1);
      currentWindow.setBackgroundColor('#fbfcf9');
      ipc.publish();
      void contents.loadURL(APP_ENTRY).catch(() => startupFailure());
    } catch {
      dialog.showErrorBox('外观尚未保存', '无法写入 Desktop 的外观设置。原有文件已保留，请检查专用配置目录的权限后重试。');
    }
  };
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !input.isAutoRepeat && input.control && input.shift
      && !input.alt && !input.meta && input.code === 'Digit0') {
      event.preventDefault();
      restoreAppearance();
    }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '神谕', submenu: [
      { id: 'restore-default-appearance', label: '恢复内置外观', accelerator: 'CommandOrControl+Shift+0', click: restoreAppearance },
      { type: 'separator' }, { role: 'quit', label: '退出' },
    ] },
    { role: 'editMenu', label: '编辑' },
    { label: '视图', submenu: [
      { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
      { role: 'resetZoom', label: '实际大小' }, { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ] },
  ]));
  contents.on('render-process-gone', () => {
    if (currentWindow.isDestroyed() || failureReported) return;
    void dialog.showMessageBox(currentWindow, {
      type: 'error', title: '界面已停止响应', message: '神谕界面意外退出。可以重新加载本地界面，或退出应用。',
      buttons: ['重新加载', '退出'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !currentWindow.isDestroyed()) void contents.loadURL(APP_ENTRY).catch(() => startupFailure());
      else app.quit();
    });
  });
  await contents.loadURL(APP_ENTRY);
  currentWindow.show();
}

app.on('window-all-closed', () => app.quit());
void start().catch(() => startupFailure());
