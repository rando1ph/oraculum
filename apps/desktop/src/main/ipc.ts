import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { DesktopState } from '../contracts/desktop';
import { APP_ENTRY } from './bundle';
import { IPC } from './ipc-channels';
import type { ProfileKind } from './profile';
import type { PreferencesStore } from './preferences';

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

export function registerDesktopIpc(contents: WebContents, preferences: PreferencesStore, kind: ProfileKind): {
  state(): DesktopState;
  publish(): void;
  dispose(): void;
} {
  const state = (): DesktopState => ({ ...preferences.read(), profile: kind });
  const publish = (): void => {
    if (!contents.isDestroyed() && contents.getURL() === APP_ENTRY) contents.send(IPC.stateChanged, state());
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
    publish();
    return state();
  });
  return { state, publish, dispose() {
    for (const channel of [IPC.getState, IPC.setPreferences, IPC.resetAppearance]) ipcMain.removeHandler(channel);
  } };
}
