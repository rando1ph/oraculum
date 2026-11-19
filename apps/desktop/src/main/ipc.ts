import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { DesktopState } from '../contracts/desktop';
import { APP_ENTRY } from './bundle';
import { IPC } from './ipc-channels';
import type { ProfileKind } from './profile';
import type { PreferencesStore } from './preferences';
import type { DesktopWorkspace } from './workspace';
import type { CloseGuard } from './close-guard';

type Frame = { url: string; detached: boolean; isDestroyed(): boolean };
type Sender = { mainFrame: Frame; getURL(): string; isDestroyed(): boolean };

/** Origin alone is insufficient: only this live top-level frame owns the API. */
export function isTrustedSender(event: { sender: unknown; senderFrame: Frame | null }, expected: Sender): boolean {
  try {
    return event.sender === expected && !expected.isDestroyed()
      && event.senderFrame !== null && event.senderFrame === expected.mainFrame
      && !event.senderFrame.isDestroyed() && !event.senderFrame.detached
      && event.senderFrame.url === APP_ENTRY && expected.getURL() === APP_ENTRY;
  } catch { return false; }
}

export function registerDesktopIpc(contents: WebContents, preferences: PreferencesStore, kind: ProfileKind, workspace?: DesktopWorkspace, closeGuard?: CloseGuard): {
  state(): DesktopState;
  publish(appearanceReset?: boolean): void;
  dispose(): void;
} {
  const state = (): DesktopState => ({ ...preferences.read(), profile: kind });
  const publish = (appearanceReset = false): void => {
    if (!contents.isDestroyed() && contents.getURL() === APP_ENTRY) contents.send(IPC.stateChanged, { ...state(), ...(appearanceReset ? { appearanceReset: true } : {}) });
  };
  const authorized = (event: IpcMainInvokeEvent): void => {
    if (!isTrustedSender(event, contents)) throw new Error('IPC_NOT_AUTHORIZED');
  };
  const noArguments = (args: unknown[]): void => {
    if (args.length !== 0) throw new Error('INVALID_ARGUMENTS');
  };
  ipcMain.handle(IPC.getState, (event, ...args: unknown[]) => {
    authorized(event);
    noArguments(args);
    return state();
  });
  ipcMain.handle(IPC.setPreferences, (event, ...args: unknown[]) => {
    authorized(event);
    if (args.length !== 1) throw new Error('INVALID_ARGUMENTS');
    preferences.update(args[0]);
    publish();
    return state();
  });
  ipcMain.handle(IPC.resetAppearance, (event, ...args: unknown[]) => {
    authorized(event);
    noArguments(args);
    preferences.reset();
    contents.setZoomFactor(1);
    publish(true);
    return state();
  });
  ipcMain.handle(IPC.getWorkspace, (event, ...args: unknown[]) => {
    authorized(event); noArguments(args);
    if (!workspace) throw new Error('WORKSPACE_UNAVAILABLE');
    return workspace.state();
  });
  ipcMain.handle(IPC.workspaceAction, (event, ...args: unknown[]) => {
    authorized(event);
    if (!workspace || args.length !== 1) throw new Error('INVALID_ARGUMENTS');
    return workspace.action(args[0]);
  });
  ipcMain.handle(IPC.closeReady, (event, ...args: unknown[]) => {
    authorized(event);
    if (!closeGuard || args.length !== 2) throw new Error('INVALID_ARGUMENTS');
    closeGuard.acknowledge(args[0], args[1]);
  });
  return { state, publish, dispose() {
    for (const channel of [IPC.getState, IPC.setPreferences, IPC.resetAppearance, IPC.getWorkspace, IPC.workspaceAction, IPC.closeReady]) ipcMain.removeHandler(channel);
  } };
}
