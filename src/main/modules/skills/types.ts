// Plain serialisable types of the Skills module (Settings > Skills).

import type { DiffLine } from './text.js';

/**
 * One folder that receives the task-plan skill (<skillDir>\task-plan\SKILL.md),
 * stored in config.json "integrations". Field names and meaning match the
 * baseline; unknown keys of a stored entry are kept in `extra` and written back.
 */
export interface SkillTarget {
  id: string;
  label: string;
  skillDir: string;
  instructionFile?: string;
  /** True while Agent Ops' reminder block is in instructionFile. */
  instructionBlock: boolean;
  enabled: boolean;
  source: 'detected' | 'custom';
  addedAt?: string;
  version?: number;
  /** Hash of the LF text of the skill Agent Ops last wrote. */
  sha256?: string;
  installedAt?: string;
  /** Hash of a locally modified skill the owner chose to keep. */
  kept?: string;
  instructionSha256?: string;
  /** Hash an earlier installer recorded, so an unedited old copy shows Update available. */
  legacySha256?: string;
  /** Keys of the stored entry this version does not know, preserved as they were. */
  extra: Record<string, unknown>;
}

/** A workspace project root; the Skills module never writes inside one. */
export interface WorkspaceRef {
  name: string;
  path: string;
}

export type SkillState =
  | 'missing-folder'
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'modified';
export type InstructionState =
  'none' | 'missing-folder' | 'off' | 'on' | 'outdated' | 'modified';

export interface InstructionStatus {
  path: string;
  state: InstructionState;
  /** The reminder line Agent Ops writes between its markers. */
  line: string;
}

export interface TargetStatus {
  id: string;
  label: string;
  skillDir: string;
  skillFile: string;
  instructionFile: string;
  enabled: boolean;
  source: 'detected' | 'custom';
  state: SkillState;
  /** The state for the owner: Not installed, Installed v3, Update available, Modified locally, Missing folder. */
  stateText: string;
  installedVersion: number;
  /** The owner chose Keep mine for the file as it is now. */
  kept: boolean;
  instructions: InstructionStatus;
}

export interface TargetSuggestion {
  client: 'claude' | 'codex' | 'gemini' | 'orca';
  label: string;
  skillDir: string;
  instructionFile?: string;
}

export interface SkillsOverview {
  skillVersion: number;
  targets: TargetStatus[];
  /** Why the list cannot be changed now; empty when it can. */
  readOnly: string;
}

export interface TargetInput {
  skillDir?: string;
  instructionFile?: string;
  label?: string;
  enabled?: boolean;
}

export type SkillAction =
  | 'install'
  | 'update'
  | 'replace'
  | 'keep'
  | 'remove'
  | 'instructions-on'
  | 'instructions-off';

export const SKILL_ACTIONS: readonly SkillAction[] = [
  'install',
  'update',
  'replace',
  'keep',
  'remove',
  'instructions-on',
  'instructions-off',
];

export interface TargetDiff {
  path: string;
  identical: boolean;
  lines: DiffLine[];
}

export interface AddTargetResult {
  id: string;
  overview: SkillsOverview;
}

/** What recording the detected skills did (the one-time seeding of the list). */
export interface SeedReport {
  added: string[];
  refreshed: string[];
  problems: string[];
}
