// What a new session is told when it starts: the latest handoff for its folder
// that no session loaded yet, and a short brief of the open plans of its
// workspace. Plans are only read here.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listPlans } from '../plans/collect';
import { MAX_PLAN_BYTES, readPlanFile } from '../plans/io';
import { buildPlan } from '../plans/overview';
import { parseMarkdown } from '../plans/parse';
import {
  folderKey,
  handoffRef,
  listSessions,
  readSession,
  MAX_SESSION_FILES,
  type SessionRecord,
  type SessionTodo,
} from './store';

/** A handoff older than this is not loaded into a new session. */
export const HANDOFF_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BRIEF_PLANS = 5;

/**
 * workspaceOf names the workspace of a folder as the skill does: the main
 * checkout folder of its Git repository (also from a worktree), otherwise the
 * folder itself. It reads `.git` without running Git.
 */
export async function workspaceOf(cwd: string): Promise<string> {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const info = await fs.stat(dotGit);
      if (info.isDirectory()) return path.basename(dir);
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, 'utf8'));
      if (m) {
        const gitDir = path.resolve(dir, m[1]!);
        let common = gitDir;
        try {
          const rel = (
            await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')
          ).trim();
          if (rel) common = path.resolve(gitDir, rel);
        } catch {
          /* Not a worktree: a submodule or a separate Git folder. */
        }
        return path.basename(path.dirname(common));
      }
      return path.basename(dir);
    } catch {
      /* No .git here. */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.basename(path.resolve(cwd));
    dir = parent;
  }
}

export interface Handoff {
  record: SessionRecord;
  ref: string;
}

/** latestHandoff returns the newest fresh handoff for the folder that no start loaded yet. */
export async function latestHandoff(
  dir: string,
  cwd: string,
  now: Date,
): Promise<Handoff | null> {
  const key = folderKey(cwd);
  const loaded = new Set<string>();
  let best: SessionRecord | null = null;
  const files = (await listSessions(dir)).slice(0, MAX_SESSION_FILES);
  for (const f of files) {
    for (const r of await readSession(dir, f.id).catch(() => [])) {
      for (const ref of r.loaded ?? []) loaded.add(ref);
      if (
        r.kind !== 'handoff' ||
        folderKey(r.cwd) !== key ||
        now.getTime() - Date.parse(r.at) > HANDOFF_FRESH_MS
      )
        continue;
      // An agent's own note wins over an automatic one written at the same time or earlier.
      if (
        !best ||
        Date.parse(r.at) > Date.parse(best.at) ||
        (best.auto &&
          !r.auto &&
          Date.parse(r.at) >= Date.parse(best.at) - 60_000)
      )
        best = r;
    }
  }
  if (!best || loaded.has(handoffRef(best))) return null;
  return { record: best, ref: handoffRef(best) };
}

/** latestTodos returns the session's most recent todo list, if it recorded one. */
export function latestTodos(records: SessionRecord[]): SessionTodo[] | null {
  for (let i = records.length - 1; i >= 0; i--)
    if (records[i]!.kind === 'todos') return records[i]!.todos ?? [];
  return null;
}

export function todoLines(todos: SessionTodo[]): string[] {
  const mark = { completed: 'done', in_progress: 'doing', pending: 'todo' };
  return todos.map((t) => `- [${mark[t.state]}] ${t.text}`);
}

/** planBrief lists the open plans of a workspace: status, next step and steps in progress. */
export async function planBrief(
  tasksDir: string,
  workspace: string,
): Promise<string[]> {
  const folder = path.join(tasksDir, workspace);
  const plans: { name: string; mtime: number; lines: string[] }[] = [];
  for (const name of await listPlans(folder).catch(() => [])) {
    const file = path.join(folder, name);
    try {
      const info = await fs.stat(file);
      if (!info.isFile() || info.size > MAX_PLAN_BYTES) continue;
      const plan = buildPlan(parseMarkdown(await readPlanFile(file)));
      if (/^done\b/i.test(plan.status)) continue;
      const lines = [`- ${name} (${file}): ${plan.status || 'no status'}`];
      if (plan.next) lines.push(`  Next: ${plan.next}`);
      for (const s of plan.steps
        .filter((s) => s.status === 'doing')
        .slice(0, 3))
        lines.push(`  Doing (line ${s.line}): ${s.text}`);
      plans.push({ name, mtime: info.mtimeMs, lines });
    } catch {
      /* An unreadable plan is left out of the brief. */
    }
  }
  plans.sort((a, b) => b.mtime - a.mtime);
  const shown = plans.slice(0, MAX_BRIEF_PLANS).flatMap((p) => p.lines);
  if (plans.length > MAX_BRIEF_PLANS)
    shown.push(`- and ${plans.length - MAX_BRIEF_PLANS} more open plans`);
  return shown;
}

export interface StartContext {
  text: string;
  loaded: string[];
}

/** startContext builds what a starting session is told; empty text means nothing to tell. */
export async function startContext(options: {
  dir: string;
  cwd: string;
  source: string;
  session: string;
  tasksDir: string;
  now: Date;
}): Promise<StartContext> {
  const parts: string[] = [];
  const loaded: string[] = [];
  if (options.source === 'clear' || options.source === 'compact') {
    const handoff = await latestHandoff(options.dir, options.cwd, options.now);
    if (handoff) {
      const r = handoff.record;
      parts.push(
        `## Session handoff (${r.auto ? 'saved automatically from the todo list' : `written by ${r.agent}`} at ${r.at})`,
        r.text!.trim(),
      );
      loaded.push(handoff.ref);
    }
  }
  if (options.tasksDir) {
    const workspace = await workspaceOf(options.cwd);
    const brief = await planBrief(options.tasksDir, workspace);
    if (brief.length)
      parts.push(
        `## Open plans in workspace ${workspace} (Agent Ops)`,
        ...brief,
        'Read a plan file only when the work touches it.',
      );
  }
  if (!parts.length) return { text: '', loaded };
  return {
    text: ['# Agent Ops', ...parts].join('\n'),
    loaded,
  };
}
