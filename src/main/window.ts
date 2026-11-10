import { BrowserWindow } from 'electron';
import { join } from 'node:path';

export function createWindow(packaged = true): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'Agent Ops',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !packaged,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) =>
    event.preventDefault(),
  );
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  );
  window.once('ready-to-show', () => window.show());
  return window;
}
