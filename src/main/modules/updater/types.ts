// Plain serialisable types of the updater (docs/electron/ipc-contract.md,
// "Update DTOs and channels").

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'updated'
  | 'error';

/** The `updates:get` / `updates:changed` DTO. Versions are in tag form, e.g. v1.2.3. */
export interface UpdateState {
  current: string;
  commit: string;
  processId: number;
  latest: string;
  /** Release notes as plain text (never HTML). */
  notes: string;
  available: boolean;
  skipped: boolean;
  phase: UpdatePhase;
  /** A plain sentence when the last operation failed; empty otherwise. */
  error: string;
  /** A plain sentence for the current phase (progress, restart notice, result). */
  message: string;
  checkedAt: string;
}

/** Typed progress events, for a notice or progress bar. */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes: string }
  | { type: 'not-available' }
  | { type: 'downloading'; version: string; percent: number }
  | { type: 'verifying'; version: string }
  | { type: 'ready'; version: string; restartInMs: number }
  | { type: 'installing'; version: string }
  | { type: 'error'; kind: UpdateErrorKind; message: string };

export type UpdateErrorKind =
  | 'offline'
  | 'rate-limited'
  | 'no-release'
  | 'checksum'
  | 'metadata'
  | 'install'
  | 'failed';

/** A newer release the provider found. */
export interface UpdateCandidate {
  /** Semver without "v", as in latest.yml. */
  version: string;
  /** Release notes as the provider returns them (may be HTML). */
  notes: string;
}

export interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

/**
 * Where releases come from. The production adapter wraps electron-updater with
 * the GitHub provider (electron-provider.ts); tests use a fake.
 */
export interface UpdateProvider {
  /** The latest release when it is newer than the running version, else null. */
  check(): Promise<UpdateCandidate | null>;
  /** Downloads and verifies (SHA-512 from latest.yml) the installer of version. */
  download(
    version: string,
    onProgress: (progress: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Starts the downloaded installer silently and quits the app; the installer
   * restarts it. Resolves only after the installer was started and the app was
   * told to quit; rejects (and leaves the app running) when the installer could
   * not be started, also when that is reported after a short delay.
   */
  install(): Promise<void>;
}
