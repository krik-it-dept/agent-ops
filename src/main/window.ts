import { BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';

/** Height of the app bar in the renderer; the window buttons sit in it. */
export const TITLE_BAR_HEIGHT = 38;
/** The app's background and text colours (src/renderer/styles/tokens.css). */
const COLORS = {
  light: { color: '#fafafa', symbolColor: '#262626' },
  dark: { color: '#191919', symbolColor: '#dedede' },
} as const;

function colors() {
  return COLORS[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
}

/**
 * applyWindowTheme follows the app's theme setting: native parts (scroll bars,
 * dialogs) use it, and the Windows caption buttons take the app's colours so
 * the top of the window matches the app bar.
 */
export function applyWindowTheme(
  window: BrowserWindow,
  theme: 'system' | 'light' | 'dark',
): void {
  nativeTheme.themeSource = theme;
  if (window.isDestroyed()) return;
  const { color, symbolColor } = colors();
  window.setBackgroundColor(color);
  if (process.platform === 'win32')
    window.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLE_BAR_HEIGHT,
    });
}

export function createWindow(packaged = true): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'Agent Ops',
    show: false,
    backgroundColor: colors().color,
    // The app bar is the title bar: Windows draws only its caption buttons,
    // in the app's colours (see applyWindowTheme).
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...colors(), height: TITLE_BAR_HEIGHT },
        }
      : {}),
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
