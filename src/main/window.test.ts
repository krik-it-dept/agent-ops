import { describe, expect, it, vi } from 'vitest';
import { BrowserWindow, nativeTheme } from 'electron';
import { applyWindowTheme, createWindow } from './window';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(
    class {
      webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
      removeMenu = vi.fn();
      once = vi.fn();
      isDestroyed = vi.fn(() => false);
      setBackgroundColor = vi.fn();
      setTitleBarOverlay = vi.fn();
    },
  ),
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
}));

describe('window security policy', () => {
  it('creates only a sandboxed isolated renderer and denies navigation and new windows', () => {
    const window = createWindow();
    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
        }),
      }),
    );
    const open = vi.mocked(window.webContents.setWindowOpenHandler).mock
      .calls[0]![0];
    expect(open({ url: 'https://example.com' } as never)).toEqual({
      action: 'deny',
    });
    const listeners = vi.mocked(window.webContents.on).mock.calls;
    for (const name of [
      'will-navigate',
      'will-frame-navigate',
      'will-redirect',
      'will-attach-webview',
    ]) {
      const callback = listeners.find(
        (call) => call[0] === name,
      )![1] as (event: { preventDefault(): void }) => void;
      const preventDefault = vi.fn();
      callback({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });
  it('disables DevTools for packaged windows and permits them only in development', () => {
    createWindow(true);
    expect(BrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ devTools: false }),
      }),
    );
    createWindow(false);
    expect(BrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({ devTools: true }),
      }),
    );
  });
  it.skipIf(process.platform !== 'win32')(
    'makes the app bar the title bar and paints the caption buttons in the theme colours',
    () => {
      const window = createWindow();
      expect(BrowserWindow).toHaveBeenLastCalledWith(
        expect.objectContaining({
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#fafafa',
            symbolColor: '#262626',
            height: 38,
          },
        }),
      );
      const theme = nativeTheme as { shouldUseDarkColors: boolean };
      theme.shouldUseDarkColors = true;
      applyWindowTheme(window, 'dark');
      expect(nativeTheme.themeSource).toBe('dark');
      expect(window.setTitleBarOverlay).toHaveBeenCalledWith({
        color: '#191919',
        symbolColor: '#dedede',
        height: 38,
      });
      expect(window.setBackgroundColor).toHaveBeenCalledWith('#191919');
      theme.shouldUseDarkColors = false;
    },
  );
});
