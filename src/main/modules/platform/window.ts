import type { Activation, WindowPort } from './types';

export function createWindowController(
  window: WindowPort,
  options: {
    background?: boolean;
    icon: string;
    activate: (target: Activation) => void;
  },
) {
  let quitting = false,
    hiddenStart = options.background === true;
  window.setIcon(options.icon);
  const offClose = window.onClose((event) => {
    if (!quitting && !window.isDestroyed()) {
      event.preventDefault();
      window.hide();
    }
  });
  // Also suppress a previously registered ready-to-show callback on background launch.
  const offShow = window.onShow(() => {
    if (hiddenStart) window.hide();
  });
  if (hiddenStart) window.hide();
  return {
    open(target: Activation = {}): void {
      if (window.isDestroyed()) return;
      hiddenStart = false;
      if (window.isMinimized()) window.restore();
      options.activate(target);
      window.show();
      window.focus();
    },
    beforeQuit(): void {
      quitting = true;
    },
    dispose(): void {
      offClose();
      offShow();
    },
  };
}
