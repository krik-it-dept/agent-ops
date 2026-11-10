// Settings > Skills: a list of folders, chosen by the owner, that receive the
// task-plan skill (<folder>\task-plan\SKILL.md), each with an optional
// instruction file for a one-line reminder. The list lives in config.json;
// detection only suggests entries. Nothing is added or installed without the
// owner's action; an app update never writes these files, it only makes a newer
// skill show as "Update available".

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ClientFiles, isLinkedFile } from './client-files.js';
import { ConfigChangedError, type SkillsConfigStore } from './config-store.js';
import { detectTargets, type DetectionEnvironment } from './detect.js';
import {
  conflict,
  invalidInput,
  messageOf,
  MODIFIED_TEXT,
  NOT_LISTED_TEXT,
  notFound,
  SkillsError,
} from './errors.js';
import { cleanInputPath, cleanPath, isDir, PathTools } from './paths.js';
import { nodePlatform, type SkillsPlatform } from './platform.js';
import {
  cloneTarget,
  MAX_LABEL,
  parseTargets,
  serializeTarget,
  skillFileOf,
  TARGET_ID_PATTERN,
  TargetListError,
} from './targets.js';
import {
  byteText,
  bytesEqual,
  contentHash,
  findBlock,
  INSTRUCTION_END,
  INSTRUCTION_LINE,
  INSTRUCTION_START,
  instructionBlock,
  isBlank,
  lfText,
  lineDiff,
  removeBlock,
  sha256Hex,
  skillVersionOf,
  textBytes,
} from './text.js';
import {
  SKILL_ACTIONS,
  type AddTargetResult,
  type InstructionStatus,
  type SeedReport,
  type SkillAction,
  type SkillsOverview,
  type SkillTarget,
  type TargetDiff,
  type TargetInput,
  type TargetStatus,
  type TargetSuggestion,
  type WorkspaceRef,
} from './types.js';

export interface SkillsServiceHooks {
  /** Runs after an action read a file's state and before it writes; tests change the file here. */
  afterRead?: (file: string) => void | Promise<void>;
  /** Runs just before the final re-read of a write; tests change the file here. */
  beforeReplace?: (file: string) => void | Promise<void>;
}

export interface SkillsServiceOptions {
  /** The app data folder; backups go to <dataDir>\backups\integrations\<timestamp>. */
  dataDir: string;
  config: SkillsConfigStore;
  /** The canonical skill (skills/task-plan/SKILL.md) and its version (read from the front matter when omitted). */
  skill: { content: string | Uint8Array; version?: number };
  detection: DetectionEnvironment;
  /** The workspace project roots; nothing is ever written inside one. */
  workspaces: () => readonly WorkspaceRef[] | Promise<readonly WorkspaceRef[]>;
  platform?: SkillsPlatform;
  now?: () => Date;
  /** True while the app restarts for an update; changes are refused then. */
  isRestarting?: () => boolean;
  /** Recognises an unedited skill written by an earlier installer (the migration provides it). */
  isUnmodifiedLegacySkill?: (content: Buffer, recordedHash: string) => boolean;
  hooks?: SkillsServiceHooks;
}

const TURNED_OFF_TEXT = 'This folder is turned off. Turn it on first.';
const LABEL_TEXT = `Enter a name of 1 to ${MAX_LABEL} characters.`;
const INPUT_KEYS = ['skillDir', 'instructionFile', 'label', 'enabled'] as const;

/** A stable id from the folder path; matches projectIDFor of the baseline. */
export function targetIdFor(p: string): string {
  return createHash('sha256')
    .update(cleanPath(p).toLowerCase(), 'utf8')
    .digest('hex')
    .slice(0, 8);
}

function validLabel(label: string): boolean {
  return (
    label !== '' && [...label].length <= MAX_LABEL && !/\p{Cc}/u.test(label)
  );
}

/** Names a folder by itself, or by its parent for a "skills" folder. */
export function defaultLabel(dir: string): string {
  let name = path.basename(dir);
  if (name.toLowerCase() === 'skills') {
    name = path.basename(path.dirname(dir));
  }
  name = name.replace(/^\./, '');
  if (name === '' || /[\\/:]/.test(name)) {
    name = dir;
  }
  return [...name].slice(0, MAX_LABEL).join('');
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function backupStamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function readInput(raw: unknown): TargetInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw invalidInput('Send the folder details as an object.');
  }
  const out: TargetInput = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(INPUT_KEYS as readonly string[]).includes(k)) {
      throw invalidInput(`Unknown field “${k}”.`);
    }
    if (v === undefined) {
      continue;
    }
    if (k === 'enabled') {
      if (typeof v !== 'boolean') {
        throw invalidInput('“enabled” must be true or false.');
      }
      out.enabled = v;
    } else {
      if (typeof v !== 'string') {
        throw invalidInput(`“${k}” must be text.`);
      }
      out[k as 'skillDir' | 'instructionFile' | 'label'] = v;
    }
  }
  return out;
}

function skillStateText(
  st: Pick<TargetStatus, 'state' | 'installedVersion' | 'kept'>,
): string {
  switch (st.state) {
    case 'missing-folder':
      return 'Missing folder';
    case 'not-installed':
      return 'Not installed';
    case 'installed':
      return `Installed v${st.installedVersion}`;
    case 'update-available':
      return st.installedVersion > 0
        ? `Update available (v${st.installedVersion} installed)`
        : 'Update available';
    case 'modified':
      return st.kept ? 'Modified locally (kept)' : 'Modified locally';
  }
}

interface SkillRead {
  status: TargetStatus;
  content: Buffer | null;
  readError: unknown;
}

interface InstructionRead {
  status: InstructionStatus;
  content: Buffer | null;
  readError: unknown;
}

interface LoadedList {
  targets: SkillTarget[];
  raw: unknown;
  exists: boolean;
  seeded: boolean;
  readOnly: string;
}

export class SkillsService {
  private readonly platform: SkillsPlatform;
  private readonly paths: PathTools;
  private readonly files: ClientFiles;
  private readonly skillBytes: Buffer;
  private readonly skillLf: string;
  private readonly skillHash: string;
  readonly skillVersion: number;
  private readonly now: () => Date;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: SkillsServiceOptions) {
    this.platform = options.platform ?? nodePlatform();
    this.paths = new PathTools(this.platform);
    const fileHooks = options.hooks?.beforeReplace
      ? { beforeReplace: options.hooks.beforeReplace }
      : {};
    this.files = new ClientFiles(this.platform, fileHooks);
    const content = options.skill.content;
    this.skillBytes =
      typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content);
    this.skillLf = lfText(this.skillBytes);
    this.skillHash = contentHash(this.skillBytes);
    this.skillVersion =
      options.skill.version ?? skillVersionOf(this.skillBytes);
    this.now = options.now ?? (() => new Date());
  }

  // ---------- public API ----------

  /** The folders with the state of their skill and reminder. */
  async listTargets(): Promise<SkillsOverview> {
    const loaded = await this.load();
    const targets: TargetStatus[] = [];
    for (const t of loaded.targets) {
      targets.push((await this.readSkillState(t)).status);
    }
    return {
      skillVersion: this.skillVersion,
      targets,
      readOnly: loaded.readOnly,
    };
  }

  /** AI tool folders found on this computer that are not in the list yet. */
  async suggestTargets(): Promise<TargetSuggestion[]> {
    const loaded = await this.load();
    return detectTargets(
      this.options.detection,
      loaded.targets.map((t) => t.skillDir),
      this.paths,
    );
  }

  /** Adds a folder: "detected" when it is one of the suggestions, otherwise "custom". */
  addTarget(rawInput: TargetInput): Promise<AddTargetResult> {
    return this.exclusive(async () => {
      const input = readInput(rawInput);
      const loaded = await this.begin();
      const list = loaded.targets;
      if (input.skillDir === undefined) {
        throw invalidInput('Choose a skills folder.');
      }
      const dir = await this.checkSkillDir(input.skillDir, list, '');
      const t: SkillTarget = {
        id: targetIdFor(dir),
        label: defaultLabel(dir),
        skillDir: dir,
        instructionBlock: false,
        enabled: input.enabled ?? true,
        source: 'custom',
        addedAt: rfc3339(this.now()),
        extra: {},
      };
      for (const s of await detectTargets(
        this.options.detection,
        list.map((x) => x.skillDir),
        this.paths,
      )) {
        if (await this.paths.samePlace(s.skillDir, dir)) {
          t.source = 'detected';
          t.label = s.label;
        }
      }
      if (input.label !== undefined && input.label.trim() !== '') {
        t.label = input.label.trim();
      }
      if (!validLabel(t.label)) {
        throw invalidInput(LABEL_TEXT);
      }
      if (
        input.instructionFile !== undefined &&
        input.instructionFile.trim() !== ''
      ) {
        t.instructionFile = await this.checkInstructionFile(
          input.instructionFile,
          list,
          '',
        );
      }
      while (list.some((x) => x.id === t.id)) {
        t.id = targetIdFor(t.id + dir);
      }
      await this.save([...list, t], loaded);
      return { id: t.id, overview: await this.listTargets() };
    });
  }

  /**
   * Changes a folder's name, paths or on/off switch. Recorded hashes are content
   * hashes and stay. The instruction file cannot change while the reminder is in
   * it (the block would be left behind unmanaged).
   */
  updateTarget(id: string, rawInput: TargetInput): Promise<SkillsOverview> {
    return this.exclusive(async () => {
      const input = readInput(rawInput);
      const loaded = await this.begin();
      const list = loaded.targets;
      const i = this.findTarget(list, id);
      const t = cloneTarget(list[i] as SkillTarget);
      if (input.skillDir !== undefined) {
        t.skillDir = await this.checkSkillDir(input.skillDir, list, id);
      }
      if (input.instructionFile !== undefined) {
        const next =
          input.instructionFile.trim() === ''
            ? ''
            : await this.checkInstructionFile(input.instructionFile, list, id);
        const same =
          next === ''
            ? !t.instructionFile
            : this.paths.samePath(next, t.instructionFile);
        if (!same) {
          if (t.instructionBlock) {
            throw conflict(
              'Turn the reminder off before changing the instruction file.',
            );
          }
          if (next === '') {
            delete t.instructionFile;
          } else {
            t.instructionFile = next;
          }
          delete t.instructionSha256;
        }
      }
      if (input.label !== undefined) {
        const label = input.label.trim();
        if (!validLabel(label)) {
          throw invalidInput(LABEL_TEXT);
        }
        t.label = label;
      }
      if (input.enabled !== undefined) {
        t.enabled = input.enabled;
      }
      const next = [...list];
      next[i] = t;
      await this.save(next, loaded);
      return this.listTargets();
    });
  }

  /**
   * Takes a folder off the list. Files are left as they are; "Remove skill" is
   * the action that deletes the skill file. Refused while the reminder is on.
   */
  removeTarget(id: string): Promise<SkillsOverview> {
    return this.exclusive(async () => {
      const loaded = await this.begin();
      const list = loaded.targets;
      const i = this.findTarget(list, id);
      if (list[i]?.instructionBlock) {
        throw conflict(
          'Turn the reminder off before removing this folder from the list.',
        );
      }
      await this.save(
        list.filter((_, j) => j !== i),
        loaded,
      );
      return this.listTargets();
    });
  }

  /** Performs one file action for one folder and records it. */
  runAction(id: string, action: SkillAction): Promise<SkillsOverview> {
    return this.exclusive(async () => {
      if (!SKILL_ACTIONS.includes(action)) {
        throw notFound('Unknown action.');
      }
      const loaded = await this.begin();
      const list = loaded.targets;
      const i = this.findTarget(list, id);
      const t = cloneTarget(list[i] as SkillTarget);
      // A turned-off folder can still be cleaned up: Remove skill and turning the
      // reminder off only take Agent Ops' own text away.
      if (!t.enabled && action !== 'remove' && action !== 'instructions-off') {
        throw conflict(TURNED_OFF_TEXT);
      }
      const backup = await this.backupDir();
      const stamp = rfc3339(this.now());
      const skill = await this.readSkillState(t);
      const file = skill.status.skillFile;
      await this.options.hooks?.afterRead?.(file);

      switch (action) {
        case 'install':
        case 'update':
          await this.writeSkill(t, skill, false, backup, stamp);
          break;
        case 'replace':
          await this.writeSkill(t, skill, true, backup, stamp);
          break;
        case 'keep':
          if (skill.status.state !== 'modified') {
            throw conflict(
              'Only a file changed outside Agent Ops can be kept.',
            );
          }
          if (skill.readError !== undefined || skill.content === null) {
            throw conflict('The file could not be read.');
          }
          t.kept = contentHash(skill.content);
          break;
        case 'remove':
          if (skill.status.state === 'modified') {
            throw conflict(MODIFIED_TEXT);
          }
          if (
            skill.status.state === 'installed' ||
            skill.status.state === 'update-available'
          ) {
            await this.refuseWorkspace(t);
            try {
              await this.files.write(
                file,
                skill.content,
                null,
                this.options.detection.homeDir,
                backup,
              );
            } catch (err) {
              throw conflict(`Could not remove ${file}: ${messageOf(err)}`);
            }
            await fs.rmdir(path.dirname(file)).catch(() => undefined); // only when empty
          }
          delete t.version;
          delete t.sha256;
          delete t.installedAt;
          delete t.kept;
          delete t.legacySha256;
          break;
        case 'instructions-on':
        case 'instructions-off':
          await this.toggleInstructions(
            t,
            action === 'instructions-on',
            backup,
          );
          break;
      }
      const next = [...list];
      next[i] = t;
      await this.save(next, loaded);
      return this.listTargets();
    });
  }

  /** What Install or Replace would change: "-" lines on disk, "+" lines Agent Ops would write. */
  async diffTarget(id: string): Promise<TargetDiff> {
    const loaded = await this.load();
    const t = loaded.targets[
      this.findTarget(loaded.targets, id)
    ] as SkillTarget;
    const file = skillFileOf(t.skillDir);
    let current: Buffer | null;
    try {
      current = await this.files.read(file);
    } catch (err) {
      throw conflict(`Could not read ${file}: ${messageOf(err)}`);
    }
    return {
      path: file,
      identical: current !== null && lfText(current) === this.skillLf,
      lines: lineDiff(
        (current ?? Buffer.alloc(0)).toString('utf8'),
        this.skillBytes.toString('utf8'),
      ),
    };
  }

  /**
   * Records the skills found in detected folders. The list is seeded once from
   * the folders that hold a task-plan skill, never from fixed names; later runs
   * only refresh the hashes of folders still listed, so a folder the owner
   * removed is never added back. Nothing is written to the AI tool folders.
   */
  recordDetectedSkills(): Promise<SeedReport> {
    return this.exclusive(async () => {
      const report: SeedReport = { added: [], refreshed: [], problems: [] };
      const loaded = await this.load();
      if (loaded.readOnly !== '') {
        report.problems.push(loaded.readOnly);
        return report;
      }
      const list = loaded.targets.map(cloneTarget);
      const seed = !loaded.seeded;
      let changed = false;
      const stamp = rfc3339(this.now());
      for (const found of await detectTargets(
        this.options.detection,
        [],
        this.paths,
      )) {
        const file = skillFileOf(found.skillDir);
        let content: Buffer | null;
        try {
          content = await this.files.read(file);
          if (await isLinkedFile(path.dirname(file))) {
            throw new Error('the task-plan folder is a link');
          }
        } catch (err) {
          report.problems.push(`${file}: ${messageOf(err)}`);
          continue;
        }
        if (content === null) {
          continue;
        }
        const current = lfText(content) === this.skillLf;
        let t: SkillTarget | undefined;
        for (const x of list) {
          if (await this.paths.samePlace(x.skillDir, found.skillDir)) {
            t = x;
          }
        }
        if (t === undefined && !seed) {
          continue;
        }
        if (t === undefined) {
          t = {
            id: targetIdFor(found.skillDir),
            label: found.label,
            skillDir: found.skillDir,
            instructionBlock: false,
            enabled: true,
            source: 'detected',
            addedAt: stamp,
            extra: {},
          };
          if (found.instructionFile) {
            t.instructionFile = found.instructionFile;
          }
          while (list.some((x) => x.id === t?.id)) {
            t.id = targetIdFor(t.id + found.skillDir);
          }
          list.push(t);
          report.added.push(found.skillDir);
          changed = true;
        }
        if (current && t.sha256 !== this.skillHash) {
          t.version = this.skillVersion;
          t.sha256 = this.skillHash;
          t.installedAt = stamp;
          delete t.kept;
          report.refreshed.push(found.skillDir);
          changed = true;
        }
      }
      // A config.json that exists counts as seeded from now on, so a later run
      // never adds back a folder the owner removed.
      if (seed && loaded.exists) {
        changed = true;
      }
      if (changed) {
        try {
          await this.save(list, loaded);
        } catch (err) {
          report.problems.push(messageOf(err));
        }
      }
      return report;
    });
  }

  // ---------- list storage ----------

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<LoadedList> {
    const snapshot = await this.options.config.load();
    const base = {
      raw: snapshot.integrations,
      exists: snapshot.exists,
      seeded: snapshot.integrationsSeeded,
    };
    if (snapshot.readOnly !== '') {
      return { ...base, targets: [], readOnly: snapshot.readOnly };
    }
    try {
      return {
        ...base,
        targets: parseTargets(snapshot.integrations, this.paths),
        readOnly: '',
      };
    } catch (err) {
      if (err instanceof TargetListError) {
        return {
          ...base,
          targets: [],
          readOnly: `The AI tools list in the settings file could not be read (${err.message}), so it cannot be changed now.`,
        };
      }
      throw err;
    }
  }

  /** The list for a change, or an error when settings cannot be saved now. */
  private async begin(): Promise<LoadedList> {
    const loaded = await this.load();
    if (loaded.readOnly !== '') {
      throw conflict(loaded.readOnly);
    }
    if (this.options.isRestarting?.()) {
      throw new SkillsError(
        'unavailable',
        'Agent Ops is restarting for an update. Try again after it reconnects.',
      );
    }
    return loaded;
  }

  private async save(list: SkillTarget[], loaded: LoadedList): Promise<void> {
    try {
      await this.options.config.save(
        list.length === 0 ? undefined : list.map(serializeTarget),
        loaded.raw,
      );
    } catch (err) {
      if (err instanceof ConfigChangedError) {
        throw conflict(err.message);
      }
      throw new SkillsError(
        'failed',
        `Settings could not be saved: ${messageOf(err)}`,
      );
    }
  }

  private findTarget(list: readonly SkillTarget[], id: string): number {
    const i = TARGET_ID_PATTERN.test(id)
      ? list.findIndex((t) => t.id === id)
      : -1;
    if (i < 0) {
      throw notFound(NOT_LISTED_TEXT);
    }
    return i;
  }

  /** A new backup folder for one action, never one used before. */
  private async backupDir(): Promise<string> {
    const base = path.join(
      this.options.dataDir,
      'backups',
      'integrations',
      backupStamp(this.now()),
    );
    let dir = base;
    for (let n = 2; await isDir(dir); n++) {
      dir = `${base}-${n}`;
    }
    return dir;
  }

  // ---------- state ----------

  /** The folder is missing and so is its parent: there is nowhere to install. */
  private async folderMissing(dir: string): Promise<boolean> {
    return !(await isDir(dir)) && !(await isDir(path.dirname(dir)));
  }

  /** The state, with the exact bytes it was computed from, so a write expects exactly them. */
  private async readSkillState(t: SkillTarget): Promise<SkillRead> {
    const status: TargetStatus = {
      id: t.id,
      label: t.label,
      skillDir: t.skillDir,
      skillFile: skillFileOf(t.skillDir),
      instructionFile: t.instructionFile ?? '',
      enabled: t.enabled,
      source: t.source,
      state: 'modified',
      stateText: '',
      installedVersion: t.version ?? 0,
      kept: false,
      instructions: (await this.readInstructionState(t)).status,
    };
    let content: Buffer | null = null;
    let readError: unknown;
    try {
      content = await this.files.read(status.skillFile);
    } catch (err) {
      readError = err;
    }
    if (readError !== undefined) {
      status.state = 'modified';
    } else if (content === null && (await this.folderMissing(t.skillDir))) {
      status.state = 'missing-folder';
      status.installedVersion = 0;
    } else if (content === null) {
      status.state = 'not-installed';
      status.installedVersion = 0;
    } else if (lfText(content) === this.skillLf) {
      status.state = 'installed';
      status.installedVersion = this.skillVersion;
    } else {
      const sum = contentHash(content);
      const v = skillVersionOf(content);
      if (v > 0) {
        status.installedVersion = v;
      }
      if (
        sum === t.sha256 ||
        this.unmodifiedLegacy(content, t.legacySha256 ?? '')
      ) {
        status.state = 'update-available';
      } else {
        status.state = 'modified';
        status.kept = !!t.kept && t.kept === sum;
      }
    }
    status.stateText = skillStateText(status);
    return { status, content, readError };
  }

  private unmodifiedLegacy(content: Buffer, recorded: string): boolean {
    if (recorded !== '' && contentHash(content) === recorded) {
      return true;
    }
    return this.options.isUnmodifiedLegacySkill?.(content, recorded) ?? false;
  }

  private async readInstructionState(t: SkillTarget): Promise<InstructionRead> {
    const status: InstructionStatus = {
      path: t.instructionFile ?? '',
      state: 'none',
      line: INSTRUCTION_LINE,
    };
    if (!t.instructionFile) {
      return { status, content: null, readError: undefined };
    }
    let content: Buffer | null;
    try {
      content = await this.files.read(t.instructionFile);
    } catch (err) {
      status.state = 'modified';
      return { status, content: null, readError: err };
    }
    if (content === null && !(await isDir(path.dirname(t.instructionFile)))) {
      status.state = 'missing-folder';
      return { status, content, readError: undefined };
    }
    const text = byteText(content ?? Buffer.alloc(0));
    const block = findBlock(text, INSTRUCTION_START, INSTRUCTION_END);
    if (!block.ok) {
      status.state = 'modified';
    } else if (!block.found) {
      status.state = 'off';
    } else {
      const inner = text.slice(block.start, block.end).replaceAll('\r\n', '\n');
      if (inner === instructionBlock()) {
        status.state = 'on';
      } else if (
        t.instructionSha256 &&
        sha256Hex(inner) === t.instructionSha256
      ) {
        status.state = 'outdated';
      } else {
        status.state = 'modified';
      }
    }
    return { status, content, readError: undefined };
  }

  // ---------- writes ----------

  private async refuseWorkspace(t: SkillTarget): Promise<void> {
    const w = await this.paths.skillFolderInWorkspace(
      t.skillDir,
      await this.options.workspaces(),
    );
    if (w) {
      throw conflict(
        `The folder ${path.dirname(skillFileOf(t.skillDir))} is inside the workspace “${w.name}” (through a link). Agent Ops does not write into workspace folders; edit the skill at its source.`,
      );
    }
  }

  private async writeSkill(
    t: SkillTarget,
    skill: SkillRead,
    force: boolean,
    backup: string,
    stamp: string,
  ): Promise<void> {
    const file = skill.status.skillFile;
    if (skill.status.state === 'missing-folder') {
      throw conflict(
        `The folder ${t.skillDir} does not exist. Edit the path or remove it from the list.`,
      );
    }
    if (skill.status.state === 'modified' && !force) {
      throw conflict(MODIFIED_TEXT);
    }
    if (skill.readError !== undefined) {
      throw conflict(`Could not read ${file}: ${messageOf(skill.readError)}`);
    }
    await this.refuseWorkspace(t);
    if (!bytesEqual(skill.content, this.skillBytes)) {
      try {
        await this.files.write(
          file,
          skill.content,
          this.skillBytes,
          this.options.detection.homeDir,
          backup,
        );
      } catch (err) {
        throw conflict(`Could not write ${file}: ${messageOf(err)}`);
      }
    }
    t.version = this.skillVersion;
    t.sha256 = this.skillHash;
    t.installedAt = stamp;
    delete t.kept;
  }

  /** Adds or removes the marked one-line block. Only text between the markers changes. */
  private async toggleInstructions(
    t: SkillTarget,
    on: boolean,
    backup: string,
  ): Promise<void> {
    const read = await this.readInstructionState(t);
    const file = t.instructionFile ?? '';
    await this.options.hooks?.afterRead?.(file);
    switch (read.status.state) {
      case 'none':
        throw conflict('Choose an instruction file for this folder first.');
      case 'missing-folder':
        throw conflict(
          `The folder of ${file} does not exist. Edit the path first.`,
        );
      case 'modified':
        throw conflict(
          `The Agent Ops lines in ${file} were changed by hand. Edit them there.`,
        );
      default:
        break;
    }
    const text = byteText(read.content ?? Buffer.alloc(0));
    const block = findBlock(text, INSTRUCTION_START, INSTRUCTION_END);
    const home = this.options.detection.homeDir;
    if (on) {
      if (read.status.state !== 'on') {
        const newline = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = instructionBlock().replaceAll('\n', newline);
        let next: string;
        if (block.found) {
          next = text.slice(0, block.start) + lines + text.slice(block.end);
        } else {
          let sep = '';
          if (text !== '') {
            sep = (text.endsWith('\n') ? '' : newline) + newline;
          }
          next = text + sep + lines + newline;
        }
        try {
          await this.files.write(
            file,
            read.content,
            textBytes(next),
            home,
            backup,
          );
        } catch (err) {
          throw conflict(`Could not write ${file}: ${messageOf(err)}`);
        }
      }
      t.instructionBlock = true;
      t.instructionSha256 = sha256Hex(instructionBlock());
      return;
    }
    if (block.found) {
      const updated = removeBlock(text, block.start, block.end);
      // A file that held only the block Agent Ops wrote is removed again.
      const next =
        isBlank(updated) && t.instructionBlock ? null : textBytes(updated);
      try {
        await this.files.write(file, read.content, next, home, backup);
      } catch (err) {
        throw conflict(`Could not write ${file}: ${messageOf(err)}`);
      }
    }
    t.instructionBlock = false;
    delete t.instructionSha256;
  }

  // ---------- validation ----------

  private async writable(dir: string): Promise<void> {
    const probe = path.join(
      dir,
      `.agent-ops-check-${process.pid}-${Date.now()}.tmp`,
    );
    const handle = await fs.open(probe, 'wx');
    await handle.close();
    await fs.rm(probe, { force: true });
  }

  /**
   * A skills folder: absolute and local, an existing writable folder or a new one
   * under an existing parent, outside every workspace, not listed already (also
   * through links). self is the folder being edited.
   */
  private async checkSkillDir(
    raw: string,
    list: readonly SkillTarget[],
    self: string,
  ): Promise<string> {
    const dir = cleanInputPath(raw);
    if (dir === null) {
      throw invalidInput(
        'Enter a full folder path on this computer, for example C:\\Users\\me\\tools\\skills.',
      );
    }
    const w = await this.paths.skillFolderInWorkspace(
      dir,
      await this.options.workspaces(),
    );
    if (w) {
      throw invalidInput(
        `This folder is inside the workspace “${w.name}”. Choose the AI tool's own skills folder, outside your workspaces.`,
      );
    }
    let info;
    try {
      info = await fs.stat(dir);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') {
        throw invalidInput(
          `Agent Ops cannot open this folder: ${messageOf(err)}`,
        );
      }
    }
    if (info && !info.isDirectory()) {
      throw invalidInput(
        'This path is a file. Choose the folder that holds the skills.',
      );
    }
    if (info) {
      await this.writable(dir).catch((err: unknown) => {
        throw invalidInput(
          `Agent Ops cannot write to this folder: ${messageOf(err)}`,
        );
      });
    } else {
      const parent = path.dirname(dir);
      if (!(await isDir(parent))) {
        throw invalidInput('Neither this folder nor its parent folder exists.');
      }
      await this.writable(parent).catch((err: unknown) => {
        throw invalidInput(
          `Agent Ops cannot create this folder: ${messageOf(err)}`,
        );
      });
    }
    for (const t of list) {
      if (t.id !== self && (await this.paths.samePlace(t.skillDir, dir))) {
        throw invalidInput(
          `This folder is already in the list as “${t.label}”.`,
        );
      }
    }
    return dir;
  }

  /**
   * An instruction file: absolute and local, Markdown (.md), a writable plain
   * file (not a link) or a new file in an existing folder, outside every
   * workspace, not used by another folder of the list.
   */
  private async checkInstructionFile(
    raw: string,
    list: readonly SkillTarget[],
    self: string,
  ): Promise<string> {
    const file = cleanInputPath(raw);
    if (file === null) {
      throw invalidInput(
        'Enter a full file path on this computer, for example C:\\Users\\me\\tools\\AGENTS.md.',
      );
    }
    if (path.extname(file).toLowerCase() !== '.md') {
      throw invalidInput(
        'Choose a Markdown instruction file (.md), for example AGENTS.md or CLAUDE.md.',
      );
    }
    let info;
    try {
      info = await fs.lstat(file);
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') {
        throw invalidInput(
          `Agent Ops cannot open this file: ${messageOf(err)}`,
        );
      }
    }
    if (info?.isSymbolicLink()) {
      throw invalidInput(
        'This file is a link. Agent Ops does not edit linked files; choose the file it points to.',
      );
    }
    if (info && !info.isFile()) {
      throw invalidInput(
        'This path is a folder. Choose the instruction file itself, for example AGENTS.md.',
      );
    }
    if (info) {
      try {
        const handle = await fs.open(file, 'r+');
        await handle.close();
      } catch (err) {
        throw invalidInput(
          `Agent Ops cannot write to this file: ${messageOf(err)}`,
        );
      }
    } else if (!(await isDir(path.dirname(file)))) {
      throw invalidInput('The folder of this file does not exist.');
    }
    const w = await this.paths.insideWorkspace(
      file,
      await this.options.workspaces(),
    );
    if (w) {
      throw invalidInput(
        `This file is inside the workspace “${w.name}”. Choose the AI tool's own instruction file.`,
      );
    }
    for (const t of list) {
      if (
        t.id !== self &&
        (await this.paths.samePlace(t.instructionFile, file))
      ) {
        throw invalidInput(
          `This instruction file is already used by “${t.label}”.`,
        );
      }
    }
    return file;
  }
}
