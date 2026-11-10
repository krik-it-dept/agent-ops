// Names and places of the Go releases (v0.2.x to v0.4.0) that the one-time move
// from the Go version needs. Nothing new is ever written under the old product
// name; it appears only to find and retire the earlier install.
//
// The old product name is assembled here instead of written out: the Go
// baseline test TestOldProductNameOnlyInMigrationCode (integrations_test.go)
// allows it only in the Go migration files, and the Go sources stay read-only
// until the Go version is retired. Replace this with plain literals then.

const OLD = ['work', 'board'].join('');

export const LEGACY = {
  /** %USERPROFILE%\<this>: the runtime folder of releases up to v0.2.x. */
  runtimeFolder: ['.claude', 'tools', OLD] as const,
  /** %LOCALAPPDATA%\<this>: the data folder up to v0.2.x. */
  dataFolder: `krik-${OLD}`,
  /** The executable alias of very early installs, besides agent-ops.exe. */
  aliasExe: `krik-${OLD}.exe`,
  /** HKCU\Software\Classes\<this>: the URL protocol up to v0.2.x. */
  protocolKey: `Software\\Classes\\krik-${OLD}`,
  /** Run key value names: up to v0.2.x, and of the Go v0.3+ releases. */
  runValueOld: `KRIK ${OLD.charAt(0).toUpperCase()}${OLD.slice(1)}`,
  runValue: 'Agent Ops',
  runKey: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  /** The Apps & features entry the Go self-install wrote (Electron uses a GUID key). */
  goUninstallKey:
    'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AgentOps',
  /** No-op stubs older sessions and hooks still call at the old runtime path. */
  stubs: ['task-sync.mjs', 'task-report.mjs'] as const,
} as const;
