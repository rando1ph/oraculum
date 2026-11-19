import { app, BrowserWindow, dialog, Menu, nativeImage, protocol, session, safeStorage } from 'electron';
import { join } from 'node:path';
import { APP_ENTRY, APP_SCHEME, isBundleRequest, loadBundle, respondToBundleRequest } from './bundle';
import { registerDesktopIpc } from './ipc';
import { PreferencesStore } from './preferences';
import { prepareProfile } from './profile';
import { CredentialStore } from './credentials';
import { GatewayTransport } from './gateway-transport';
import { OperationJournal } from './journal';
import { DesktopWorkspace } from './workspace';
import { IPC } from './ipc-channels';
import { ConnectionPreferences } from './connection-preferences';
import { CloseGuard } from './close-guard';

// Bundled client only: no process execution or Gateway/Bridge service lifecycle.
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
  const workspace = new DesktopWorkspace(new GatewayTransport({ credentials: new CredentialStore(profile.directory, safeStorage) }),
    new OperationJournal(profile.directory), {
      async chooseUpload() {
        const result = await dialog.showOpenDialog(currentWindow, { title: '选择要发送的附件', properties: ['openFile'],
          filters: [{ name: '图片与文档', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv'] }] });
        return result.canceled ? undefined : result.filePaths[0];
      },
      async chooseDownload(name) {
        const result = await dialog.showSaveDialog(currentWindow, { title: '保存 Gateway 文件', defaultPath: name });
        return result.canceled ? undefined : result.filePath;
      },
    }, state => {
      if (!contents.isDestroyed() && contents.getURL() === APP_ENTRY) contents.send(IPC.workspaceChanged, state);
    }, safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend() === 'gnome_libsecret', new ConnectionPreferences(profile.directory));
  const closeGuard = new CloseGuard(requestId => {
    if (contents.isDestroyed() || contents.getURL() !== APP_ENTRY) throw new Error('RENDERER_UNAVAILABLE');
    contents.send(IPC.beforeClose, requestId);
  }, async () => {
    const result = await dialog.showMessageBox(currentWindow, { type: 'warning', title: '草稿尚未确认保存',
      message: '本地草稿尚未完成保存。继续退出可能丢失最近的编辑；远端执行不会被取消。',
      buttons: ['取消退出', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  }, () => { if (!currentWindow.isDestroyed()) currentWindow.close(); });
  const ipc = registerDesktopIpc(contents, preferences, profile.kind, workspace, closeGuard);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  currentWindow.on('page-title-updated', event => event.preventDefault());
  currentWindow.on('close', event => {
    if (closeGuard.canClose) return;
    event.preventDefault(); closeGuard.request();
  });
  currentWindow.on('closed', () => { closeGuard.dispose(); workspace.dispose(); ipc.dispose(); window = undefined; });

  const restoreAppearance = (): void => {
    if (currentWindow.isDestroyed()) return;
    try {
      preferences.reset();
      contents.setZoomFactor(1);
      currentWindow.setBackgroundColor('#fbfcf9');
      ipc.publish(true);
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
      type: 'error', title: '界面已停止响应', message: '神谕界面意外退出。重新加载后恢复已保存草稿；崩溃前尚未保存的最近编辑可能缺失。远端执行不会被取消。',
      buttons: ['重新加载', '退出'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !currentWindow.isDestroyed()) void contents.loadURL(APP_ENTRY).catch(() => startupFailure());
      else app.quit();
    });
  });
  await contents.loadURL(APP_ENTRY);
  currentWindow.show();
  void workspace.restoreConnection().catch(() => {});
}

app.on('window-all-closed', () => app.quit());
void start().catch(() => startupFailure());
