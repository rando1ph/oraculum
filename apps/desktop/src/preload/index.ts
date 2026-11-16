import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopState } from '../contracts/desktop';
import { IPC } from '../main/ipc-channels';

// No Node, Electron event, channel, filesystem path or generic invoke crosses
// this boundary. The bundled preload is a single sandbox-compatible CJS file.
if (process.isMainFrame && location.href === 'oraculum-app://bundle/index.html') {
  contextBridge.exposeInMainWorld('oraculumDesktop', Object.freeze({
    getState: () => ipcRenderer.invoke(IPC.getState) as Promise<DesktopState>,
    setPreferences: (patch: unknown) => ipcRenderer.invoke(IPC.setPreferences, patch) as Promise<DesktopState>,
    resetAppearance: () => ipcRenderer.invoke(IPC.resetAppearance) as Promise<DesktopState>,
    onStateChanged: (listener: (state: DesktopState) => void) => {
      if (typeof listener !== 'function') throw new TypeError('INVALID_LISTENER');
      const handler = (_event: unknown, state: DesktopState): void => { listener(state); };
      ipcRenderer.on(IPC.stateChanged, handler);
      return () => { ipcRenderer.removeListener(IPC.stateChanged, handler); };
    },
  }));
}
