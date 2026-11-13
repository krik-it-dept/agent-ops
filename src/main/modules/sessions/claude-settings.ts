// Agent Ops' hooks in Claude Code settings (owner decision 2026-11-13: the
// installed app keeps them in place without a click, and Settings can turn
// them off). Only handlers carrying CLAUDE_HOOK_MARKER are ours; every other
// key, hook and handler stays as it was. A file is backed up before each
// change, written atomically, and left alone when it is not valid JSON or
// changed while it was prepared.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorText } from '../../lib/safe-io/paths';
import { timestamp, writeFileAtomic } from '../../lib/safe-io/safe-io';
import { stripBom } from './store';

export const CLAUDE_HOOK_MARKER = 'agent-ops-hooks-v1';
export const BACKUP_DIR = path.join('backups', 'claude-settings');
export const KEEP_BACKUPS = 30;

interface HookSpec {
  event: string;
  matcher?: string;
  async?: boolean;
  timeout?: number;
}
/** The events Agent Ops listens to, and how Claude Code should run each. */
export const HOOK_SPECS: readonly HookSpec[] = [
  { event: 'SessionStart', timeout: 15 },
  { event: 'UserPromptSubmit', async: true },
  {
    event: 'PostToolUse',
    matcher: 'TodoWrite|TaskCreate|TaskUpdate',
    async: true,
  },
  {
    event: 'Notification',
    matcher:
      'permission_prompt|idle_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input',
    async: true,
  },
  { event: 'Stop', async: true },
  { event: 'PreCompact', timeout: 15 },
  { event: 'SessionEnd', timeout: 10 },
];

export interface ClaudeHookOptions {
  dataDir: string;
  /** The user's profile folder (%USERPROFILE%). */
  homeDir: string;
  /** %APPDATA%, where Orca keeps its Claude profiles. */
  roamingAppData: string;
  now?: () => Date;
}

/** settingsFiles lists the Claude Code settings files to keep: the user's and each Orca profile's. */
export async function settingsFiles(
  o: Pick<ClaudeHookOptions, 'homeDir' | 'roamingAppData'>,
): Promise<string[]> {
  const files: string[] = [];
  const home = path.join(o.homeDir, '.claude');
  try {
    if ((await fs.stat(home)).isDirectory())
      files.push(path.join(home, 'settings.json'));
  } catch {
    /* Claude Code is not set up for this user. */
  }
  const profiles = path.join(o.roamingAppData, 'orca', 'claude-profiles');
  try {
    for (const name of (await fs.readdir(profiles)).sort()) {
      const file = path.join(profiles, name, 'home', 'settings.json');
      try {
        if ((await fs.stat(file)).isFile()) files.push(file);
      } catch {
        /* A profile without settings is left alone. */
      }
    }
  } catch {
    /* Orca is not installed. */
  }
  return files;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function ours(handler: unknown): boolean {
  if (!isObject(handler)) return false;
  const args = Array.isArray(handler.args) ? handler.args : [];
  return (
    args.includes(CLAUDE_HOOK_MARKER) ||
    (typeof handler.command === 'string' &&
      handler.command.includes(CLAUDE_HOOK_MARKER))
  );
}

/**
 * withHooks returns the settings with Agent Ops' handlers removed and, when
 * executable is given, added again. Groups left empty by the removal go; an
 * event left without groups goes.
 */
export function withHooks(settings: Json, executable: string | null): Json {
  const out: Json = { ...settings };
  const hooks: Json = isObject(settings.hooks) ? { ...settings.hooks } : {};
  let removed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => {
        if (!isObject(g) || !Array.isArray(g.hooks)) return g;
        const handlers = g.hooks.filter((h) => !ours(h));
        if (handlers.length === g.hooks.length) return g;
        removed = true;
        return handlers.length ? { ...g, hooks: handlers } : null;
      })
      .filter((g) => g !== null);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!executable && !removed) return settings;
  if (executable) {
    for (const spec of HOOK_SPECS) {
      const handler: Json = {
        type: 'command',
        command: executable,
        args: ['--hook', CLAUDE_HOOK_MARKER],
        ...(spec.async ? { async: true } : {}),
        ...(spec.timeout ? { timeout: spec.timeout } : {}),
      };
      const group: Json = {
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [handler],
      };
      const groups = Array.isArray(hooks[spec.event])
        ? (hooks[spec.event] as unknown[])
        : [];
      hooks[spec.event] = [...groups, group];
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

async function backup(
  o: ClaudeHookOptions,
  file: string,
  bytes: Buffer,
): Promise<void> {
  const dir = path.join(o.dataDir, BACKUP_DIR);
  const label = path
    .basename(path.dirname(path.dirname(file)))
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 60);
  const now = (o.now ?? (() => new Date()))();
  await writeFileAtomic(
    path.join(dir, `${timestamp(now)}-${label}-settings.json`),
    bytes,
  );
  const names = (await fs.readdir(dir))
    .filter((n) => n.endsWith('.json'))
    .sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS)))
    await fs.rm(path.join(dir, old), { force: true });
}

async function syncFile(
  o: ClaudeHookOptions,
  file: string,
  executable: string | null,
): Promise<'changed' | 'unchanged'> {
  let before: Buffer | null = null;
  try {
    before = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!before && !executable) return 'unchanged';
  let settings: Json = {};
  if (before) {
    const text = stripBom(before.toString('utf8'));
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed))
        throw new Error('The settings file does not hold a JSON object.');
      settings = parsed;
    }
  }
  const next = withHooks(settings, executable);
  if (JSON.stringify(next) === JSON.stringify(settings)) return 'unchanged';
  if (before) await backup(o, file, before);
  const now = await fs.readFile(file).catch(() => null);
  if (
    (now === null) !== (before === null) ||
    (now && before && !now.equals(before))
  )
    throw new Error(
      'The settings file changed while Agent Ops prepared it; it will try again at the next start.',
    );
  await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  return 'changed';
}

/**
 * syncClaudeHooks puts Agent Ops' hooks into every Claude Code settings file
 * (executable given) or takes them out (null). It returns one plain problem
 * per file that could not be handled; the other files still run.
 */
export async function syncClaudeHooks(
  executable: string | null,
  o: ClaudeHookOptions,
): Promise<{ changed: string[]; problems: string[] }> {
  const changed: string[] = [];
  const problems: string[] = [];
  for (const file of await settingsFiles(o)) {
    try {
      if ((await syncFile(o, file, executable)) === 'changed')
        changed.push(file);
    } catch (err) {
      problems.push(`${file}: ${errorText(err)}`);
    }
  }
  return { changed, problems };
}

export const removeClaudeHooks = (o: ClaudeHookOptions) =>
  syncClaudeHooks(null, o);
