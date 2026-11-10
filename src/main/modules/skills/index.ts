// Skills module: the task-plan skill in the owner's AI tool folders
// (Settings > Skills). A plain Node library; the Electron main process wires it
// to IPC with a config store, the canonical skill text and the workspace list.

export { ClientFiles } from './client-files.js';
export {
  ConfigChangedError,
  JsonFileSkillsConfigStore,
} from './config-store.js';
export type {
  SkillsConfigSnapshot,
  SkillsConfigStore,
} from './config-store.js';
export { claudeHomes, detectionEnvironment, detectTargets } from './detect.js';
export type { DetectionEnvironment } from './detect.js';
export { FileChangedError, FileLinkedError, SkillsError } from './errors.js';
export type { SkillsErrorCode } from './errors.js';
export { cleanInputPath, PathTools } from './paths.js';
export { nodePlatform } from './platform.js';
export type { SkillsPlatform } from './platform.js';
export { defaultLabel, SkillsService, targetIdFor } from './service.js';
export type { SkillsServiceHooks, SkillsServiceOptions } from './service.js';
export { parseTargets, serializeTarget, skillFileOf } from './targets.js';
export {
  INSTRUCTION_END,
  INSTRUCTION_LINE,
  INSTRUCTION_START,
  instructionBlock,
  lineDiff,
  skillVersionOf,
} from './text.js';
export type { DiffLine } from './text.js';
export * from './types.js';
