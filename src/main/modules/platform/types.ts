export type NativeErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BUSY'
  | 'TIMEOUT'
  | 'IO_ERROR'
  | 'CONFLICT';
export class PlatformError extends Error {
  constructor(
    public readonly code: NativeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}
export type Dispose = () => void;
export type PickPurpose = 'workspace' | 'skills' | 'tasks' | 'instruction-file';
export interface PickRequest {
  requestId: string;
  purpose: PickPurpose;
}
export type PickResponse =
  { path: string; cancelled?: never } | { cancelled: true; path?: never };
export interface Activation {
  plan?: string;
  settings?: true;
}
export interface WindowPort {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  hide(): void;
  focus(): void;
  setIcon(path: string): void;
  onClose(callback: (event: { preventDefault(): void }) => void): Dispose;
  onShow(callback: () => void): Dispose;
}
export interface StartupPort {
  /** `name` is the Run value name the item was written under. */
  read(options: { path: string; args: string[]; name: string }): {
    openAtLogin: boolean;
    launchItems?: readonly {
      name: string;
      path: string;
      enabled: boolean;
    }[];
  };
  write(settings: {
    openAtLogin: boolean;
    path: string;
    args: string[];
    name: string;
  }): void;
}
export interface RegistrationPort {
  setProtocol(scheme: string, executable: string, args: string[]): boolean;
  removeProtocol(scheme: string, executable: string, args: string[]): boolean;
}
export interface CommandResult {
  stdout: string;
  code: number;
}
export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
) => Promise<CommandResult>;
export interface RegistrationPolicy {
  platform: NodeJS.Platform;
  development: boolean;
  executable: string;
  installedRoot: string;
  env: Readonly<NodeJS.ProcessEnv>;
}
