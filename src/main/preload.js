/**
 * Preload script: exposes a small `window.cursorWidget` API (IPC only; no Node in renderer).
 * @see docs/ARCHITECTURE.md
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cursorWidget", {
  platform: process.platform,

  signIn: () => ipcRenderer.invoke("cursor:sign-in"),

  refreshStats: () => ipcRenderer.invoke("cursor:refresh-stats"),

  getPricing: () => ipcRenderer.invoke("cursor:get-pricing"),

  getLastStats: () => ipcRenderer.invoke("cursor:last-stats"),

  getChartData: () => ipcRenderer.invoke("cursor:get-chart-data"),

  getSession: () => ipcRenderer.invoke("cursor:get-session"),

  onStats: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("cursor:stats", handler);
    return () => ipcRenderer.removeListener("cursor:stats", handler);
  },

  onLoginClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("cursor:login-closed", handler);
    return () => ipcRenderer.removeListener("cursor:login-closed", handler);
  },

  onChart: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("cursor:chart", handler);
    return () => ipcRenderer.removeListener("cursor:chart", handler);
  },

  onSession: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("cursor:session", handler);
    return () => ipcRenderer.removeListener("cursor:session", handler);
  },

  openExternal: (url) => ipcRenderer.invoke("cursor:open-external", url),
});
