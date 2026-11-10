import { dirname, isAbsolute } from 'node:path';
import { PlatformError, type PickRequest, type PickResponse } from './types';

export interface DialogOptions {
  title: string;
  defaultPath: string;
  kind: 'folder' | 'markdown';
}
export interface DialogSession {
  result: Promise<{ canceled: boolean; filePaths: string[] }>;
  /** Resolves only when the native dialog is confirmed closed. */
  cancel(): Promise<void>;
}
export interface DialogPort {
  available(): boolean;
  focusOwner(): void;
  open(options: DialogOptions): DialogSession;
}
export interface PickerPreferences {
  home: string;
  getDirectory(): string;
  isDirectory(path: string): Promise<boolean>;
  rememberDirectory(path: string): Promise<void>;
}
interface ActivePick {
  requestId: string;
  scope: string;
  cancelled: boolean;
  timedOut: boolean;
  session?: DialogSession;
  closing?: Promise<void>;
  closed: Promise<void>;
  finish(): void;
}
const titles = {
  workspace: 'Choose a workspace folder',
  skills: 'Choose a skills folder',
  tasks: 'Choose the Tasks folder',
  'instruction-file': 'Choose an instruction file',
};
export class PickerService {
  private active: ActivePick | undefined;
  constructor(
    private readonly port: DialogPort,
    private readonly preferences: PickerPreferences,
    private readonly options: {
      timeoutMs?: number;
      onError?: (category: string) => void;
    } = {},
  ) {}
  async pick(request: PickRequest, scope: string): Promise<PickResponse> {
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(request.requestId) ||
      !Object.hasOwn(titles, request.purpose)
    )
      throw new PlatformError('INVALID_REQUEST', 'Invalid picker request.');
    if (this.active)
      throw new PlatformError('BUSY', 'A picker is already open.', true);
    if (!this.port.available())
      throw new PlatformError(
        'NOT_FOUND',
        'Agent Ops window not found. Paste a path instead.',
      );
    let finish = (): void => {};
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActivePick = {
      requestId: request.requestId,
      scope,
      cancelled: false,
      timedOut: false,
      closed,
      finish,
    };
    this.active = active;
    const timer = setTimeout(() => {
      active.timedOut = true;
      void this.close(active).catch(() =>
        this.options.onError?.('picker-close'),
      );
    }, this.options.timeoutMs ?? 120_000);
    timer.unref();
    try {
      const remembered = this.preferences.getDirectory();
      let start = this.preferences.home;
      try {
        if (remembered && (await this.preferences.isDirectory(remembered)))
          start = remembered;
      } catch {
        /* Home is the fallback. */
      }
      if (active.cancelled) {
        if (active.timedOut)
          throw new PlatformError(
            'TIMEOUT',
            'The picker timed out. Paste a path or try again.',
            true,
          );
        return { cancelled: true };
      }
      this.port.focusOwner();
      active.session = this.port.open({
        title: titles[request.purpose],
        defaultPath: start,
        kind: request.purpose === 'instruction-file' ? 'markdown' : 'folder',
      });
      const result = await active.session.result;
      if (active.timedOut)
        throw new PlatformError(
          'TIMEOUT',
          'The picker timed out. Paste a path or try again.',
          true,
        );
      if (active.cancelled || result.canceled || !result.filePaths.length)
        return { cancelled: true };
      const path = result.filePaths[0]!;
      if (
        result.filePaths.length !== 1 ||
        !isAbsolute(path) ||
        path.includes('\0') ||
        (request.purpose === 'instruction-file' && !/\.md$/i.test(path))
      )
        throw new PlatformError(
          'IO_ERROR',
          'The picker did not return a valid selection.',
          true,
        );
      try {
        await this.preferences.rememberDirectory(
          request.purpose === 'instruction-file' ? dirname(path) : path,
        );
      } catch {
        this.options.onError?.('picker-preference');
      }
      return { path };
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError(
        'IO_ERROR',
        'The picker could not be opened. Paste a path or try again.',
        true,
      );
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.active = undefined;
      active.finish();
    }
  }
  private close(active: ActivePick): Promise<void> {
    active.cancelled = true;
    active.closing ??= (async () => {
      if (active.session) {
        try {
          await active.session.cancel();
          await active.session.result;
        } catch {
          throw new PlatformError(
            'IO_ERROR',
            'The picker could not be closed. Close it manually and retry.',
            true,
          );
        }
      }
      await active.closed;
    })();
    return active.closing;
  }
  async cancelPick(
    request: { requestId: string },
    scope: string,
  ): Promise<{ cancelled: boolean }> {
    const active = this.active;
    if (
      !active ||
      active.requestId !== request.requestId ||
      active.scope !== scope
    )
      return { cancelled: false };
    await this.close(active);
    return { cancelled: true };
  }
}
