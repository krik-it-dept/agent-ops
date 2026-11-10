import type { WebContents } from 'electron';

/** Apply to every future webContents as well as the primary window. */
export function guardWebContents(
  contents: Pick<WebContents, 'setWindowOpenHandler' | 'on'>,
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const deny = (request: { preventDefault(): void }) =>
    request.preventDefault();
  contents.on('will-navigate', deny);
  contents.on('will-frame-navigate', deny);
  contents.on('will-redirect', deny);
  contents.on('will-attach-webview', deny);
}
