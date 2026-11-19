// Internal constants only; the renderer receives named methods, never channels.
export const IPC = Object.freeze({
  getState: 'oraculum-desktop:state:get',
  setPreferences: 'oraculum-desktop:appearance:set',
  resetAppearance: 'oraculum-desktop:appearance:reset',
  stateChanged: 'oraculum-desktop:state:changed',
  getWorkspace: 'oraculum-desktop:workspace:get',
  workspaceAction: 'oraculum-desktop:workspace:action',
  workspaceChanged: 'oraculum-desktop:workspace:changed',
  beforeClose: 'oraculum-desktop:close:prepare',
  closeReady: 'oraculum-desktop:close:ready',
});
