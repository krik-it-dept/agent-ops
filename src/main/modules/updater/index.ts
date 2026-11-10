// Updater module: in-app updates (electron-updater, GitHub Releases) and the
// one-time move from the Go version. The composition root (src/main/index.ts)
// wires it; this module registers no IPC handlers itself.
//
// Wiring, in the packaged app only:
//   const updater = createElectronUpdater({ dataDir, currentVersion: app.getVersion(),
//     packaged: app.isPackaged, beforeInstall, log });
//   updates:get -> updater.getState(); updates:check -> updater.check();
//   updates:apply -> updater.apply(version); updates:skip -> updater.skip(version);
//   updates:changed <- updater.onState(...); then updater.start().
//   On first start: runLegacyMove({ localAppData, userProfile, dataDir,
//     executablePath: process.execPath, stubsDir: join(process.resourcesPath, 'legacy-stubs'),
//     registry: regExeRegistry(), processes: powershellProcesses(), log }).

export {
  createElectronUpdater,
  electronUpdateProvider,
} from './electron-provider';
export type {
  ElectronProviderOptions,
  ElectronUpdaterOptions,
} from './electron-provider';
export { classifyUpdateError, UPDATE_MESSAGES, UpdaterError } from './errors';
export type { UpdaterErrorCode } from './errors';
export { detectLegacy, legacyMoveFolder, runLegacyMove } from './legacy-move';
export type {
  LegacyDetection,
  LegacyMoveOptions,
  LegacyMoveResult,
  LegacyStep,
  ProcessLayer,
  RegistryLayer,
} from './legacy-move';
export { UpdaterService } from './service';
export type { Scheduler, UpdaterOptions } from './service';
export { UpdateStore } from './store';
export type { UpdatePreferences, UpdateResult } from './store';
export type * from './types';
export {
  isNewer,
  isStableVersion,
  notesToText,
  tagOf,
  updatesAllowed,
} from './versions';
export { parseRegQuery, powershellProcesses, regExeRegistry } from './windows';
