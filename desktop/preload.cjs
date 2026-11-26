const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('arenaLocal', {
  getState: invoke('arena:get-state'),
  listFiles: invoke('arena:list-files'),
  readFile: invoke('arena:read-file'),
  chooseWorkspace: invoke('arena:choose-workspace'),
  saveNgrokToken: invoke('arena:save-ngrok-token'),
  forgetNgrokToken: invoke('arena:forget-ngrok-token'),
  startTunnel: invoke('arena:start-tunnel'),
  stopTunnel: invoke('arena:stop-tunnel'),
  connectRobloxMcp: invoke('arena:connect-roblox-mcp'),
  disconnectRobloxMcp: invoke('arena:disconnect-roblox-mcp'),
  rotatePairingToken: invoke('arena:rotate-pairing-token'),
  copyArenaInstructions: invoke('arena:copy-instructions'),
  copyTunnelUrl: invoke('arena:copy-tunnel-url'),
  setPermissionMode: invoke('arena:set-permission-mode'),
  setFullComputerAccess: invoke('arena:set-full-computer-access'),
  beginFullComputerNoAskUnlock: invoke('arena:begin-full-computer-no-ask-unlock'),
  completeFullComputerNoAskUnlock: invoke('arena:complete-full-computer-no-ask-unlock'),
  cancelFullComputerNoAskUnlock: invoke('arena:cancel-full-computer-no-ask-unlock'),
  approveTask: invoke('arena:approve-task'),
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('arena:state', listener);
    return () => ipcRenderer.removeListener('arena:state', listener);
  },
});
