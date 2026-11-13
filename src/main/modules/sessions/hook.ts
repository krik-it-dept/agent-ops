// The hook command: Claude Code runs `agent-ops.exe --hook agent-ops-hooks-v1`
// for the events Agent Ops installs, with the event as JSON on stdin. It
// records the session's presence, todos and handoffs, and on SessionStart
// prints what the new session should know. It always exits 0 and prints
// nothing but that context, so a problem never disturbs the session.

import path from 'node:path';
import { configFilePath, readConfig } from '../settings/config-store';
import { latestTodos, startContext, todoLines } from './context';
import type { CommandOutcome } from './handoff';
import {
  appendSessionRecord,
  cleanText,
  folderKey,
  listSessions,
  readSession,
  MAX_HANDOFF_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_TODO_CHARS,
  MAX_TODOS,
  RECORD_VERSION,
  SESSIONS_DIR_NAME,
  validSessionId,
  type SessionRecord,
  type SessionTodo,
  type TodoState,
} from './store';

export const HOOK_FLAG = '--hook';
/** Claude Code caps hook context at 10,000 characters. */
export const MAX_CONTEXT_CHARS = 9500;
/** An agent's own handoff this recent makes the automatic one unnecessary. */
export const OWN_HANDOFF_FRESH_MS = 30 * 60 * 1000;
const WAITING_TYPES = [
  'permission_prompt',
  'idle_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
];
const AGENT = 'Claude';

export interface HookContext {
  dataDir: string;
  now?: () => Date;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** todosOf reads a TodoWrite list. */
export function todosOf(input: unknown): SessionTodo[] | null {
  const list = obj(input)?.todos;
  if (!Array.isArray(list)) return null;
  const out: SessionTodo[] = [];
  for (const item of list.slice(0, MAX_TODOS)) {
    const t = obj(item);
    const text = cleanText(str(t?.content), MAX_TODO_CHARS);
    const state = str(t?.status) as TodoState;
    if (text && ['pending', 'in_progress', 'completed'].includes(state))
      out.push({ text, state });
  }
  return out;
}

interface StoredTodo extends SessionTodo {
  id?: string;
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** taskTodos applies a TaskCreate or TaskUpdate to the session's last list. */
export function taskTodos(
  previous: StoredTodo[],
  tool: string,
  input: unknown,
  response: unknown,
): StoredTodo[] | null {
  const i = obj(input);
  if (!i) return null;
  const list = previous.map((t) => ({ ...t }));
  if (tool === 'TaskCreate') {
    const r = obj(parseMaybeJson(response));
    const task = obj(r?.task) ?? r;
    const id = str(task?.id) || str(task?.taskId);
    const text = cleanText(
      str(i.subject) || str(task?.subject),
      MAX_TODO_CHARS,
    );
    if (!text) return null;
    if (list.length >= MAX_TODOS) return list;
    list.push({ text, state: 'pending', ...(id ? { id } : {}) });
    return list;
  }
  if (tool === 'TaskUpdate') {
    const id = str(i.taskId) || str(i.id) || str(i.task_id);
    const at = list.findIndex((t) => id && t.id === id);
    const status = str(i.status);
    if (status === 'deleted') {
      if (at >= 0) list.splice(at, 1);
      return list;
    }
    const subject = cleanText(str(i.subject), MAX_TODO_CHARS);
    const state = ['pending', 'in_progress', 'completed'].includes(status)
      ? (status as TodoState)
      : undefined;
    if (at >= 0) {
      if (subject) list[at]!.text = subject;
      if (state) list[at]!.state = state;
    } else if (subject && list.length < MAX_TODOS) {
      list.push({
        text: subject,
        state: state ?? 'pending',
        ...(id ? { id } : {}),
      });
    } else return null;
    return list;
  }
  return null;
}

/**
 * autoHandoffText builds a note from the session's todos and latest prompts,
 * for when the session ends or compacts without the agent writing one.
 */
export function autoHandoffText(records: SessionRecord[]): string {
  const parts: string[] = [];
  const todos = latestTodos(records);
  if (todos && todos.some((t) => t.state !== 'completed'))
    parts.push('Todo list when the session ended:', ...todoLines(todos));
  const prompts = records
    .filter((r) => r.kind === 'prompt' && r.message)
    .slice(-3)
    .map((r) => `- ${r.message}`);
  if (prompts.length) parts.push('Latest requests from the owner:', ...prompts);
  return cleanText(parts.join('\n'), MAX_HANDOFF_CHARS);
}

async function ownHandoffSince(
  dir: string,
  cwd: string,
  since: number,
): Promise<boolean> {
  const key = folderKey(cwd);
  for (const f of (await listSessions(dir)).slice(0, 50)) {
    if (f.mtimeMs < since) break;
    for (const r of await readSession(dir, f.id).catch(() => []))
      if (
        r.kind === 'handoff' &&
        !r.auto &&
        folderKey(r.cwd) === key &&
        Date.parse(r.at) >= since
      )
        return true;
  }
  return false;
}

async function tasksDirOf(dataDir: string): Promise<string> {
  try {
    return (await readConfig(configFilePath(dataDir))).tasksDir || '';
  } catch {
    return '';
  }
}

/** handleHook records one hook event and returns what to print. */
export async function handleHook(
  input: unknown,
  context: HookContext,
): Promise<string> {
  const e = obj(input);
  if (!e) return '';
  const session = str(e.session_id);
  const cwd = str(e.cwd);
  if (!validSessionId(session) || !path.isAbsolute(cwd)) return '';
  const dir = path.join(context.dataDir, SESSIONS_DIR_NAME);
  const now = (context.now ?? (() => new Date()))();
  const base = {
    v: RECORD_VERSION,
    at: now.toISOString(),
    session,
    agent: AGENT,
    cwd: path.resolve(cwd),
  } as const;
  const event = str(e.hook_event_name);
  const subagent = str(e.agent_id) !== '';
  const write = (r: Omit<SessionRecord, keyof typeof base>) =>
    appendSessionRecord(dir, { ...base, ...r } as SessionRecord);
  const source = (v: unknown) => {
    const s = str(v).toLowerCase();
    return /^[a-z_-]{1,40}$/.test(s) ? { source: s } : {};
  };

  switch (event) {
    case 'SessionStart': {
      const src = str(e.source) || 'startup';
      const built = await startContext({
        dir,
        cwd: base.cwd,
        source: src,
        session,
        tasksDir: await tasksDirOf(context.dataDir),
        now,
      });
      await write({
        kind: 'start',
        ...source(src),
        ...(built.loaded.length ? { loaded: built.loaded } : {}),
      });
      if (!built.text) return '';
      const text = Array.from(built.text);
      const additionalContext =
        text.length > MAX_CONTEXT_CHARS
          ? text.slice(0, MAX_CONTEXT_CHARS - 1).join('') + '…'
          : built.text;
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext,
        },
      });
    }
    case 'UserPromptSubmit': {
      const message = cleanText(str(e.prompt).replace(/\s+/g, ' '), 200);
      await write({ kind: 'prompt', ...(message ? { message } : {}) });
      return '';
    }
    case 'PostToolUse': {
      if (subagent) return '';
      const tool = str(e.tool_name);
      let todos: StoredTodo[] | null = null;
      if (tool === 'TodoWrite') todos = todosOf(e.tool_input);
      else if (tool === 'TaskCreate' || tool === 'TaskUpdate') {
        const records = await readSession(dir, session);
        todos = taskTodos(
          (latestTodos(records) ?? []) as StoredTodo[],
          tool,
          e.tool_input,
          e.tool_response,
        );
      }
      if (todos) await write({ kind: 'todos', todos });
      return '';
    }
    case 'Notification': {
      if (!WAITING_TYPES.includes(str(e.notification_type))) return '';
      const message = cleanText(str(e.message), MAX_MESSAGE_CHARS);
      await write({ kind: 'waiting', ...(message ? { message } : {}) });
      return '';
    }
    case 'Stop':
      if (!subagent) await write({ kind: 'idle' });
      return '';
    case 'PreCompact':
    case 'SessionEnd': {
      const reason = event === 'PreCompact' ? str(e.trigger) : str(e.reason);
      if (event === 'PreCompact' || reason === 'clear') {
        const records = await readSession(dir, session);
        const text = autoHandoffText(records);
        if (
          text &&
          !(await ownHandoffSince(
            dir,
            base.cwd,
            now.getTime() - OWN_HANDOFF_FRESH_MS,
          ))
        )
          await write({ kind: 'handoff', text, auto: true });
      }
      await write({
        kind: event === 'PreCompact' ? 'compact' : 'end',
        ...source(reason),
      });
      return '';
    }
    default:
      return '';
  }
}

/** runHook reads the event from stdin text and never fails the session. */
export async function runHook(
  stdin: string,
  context: HookContext,
): Promise<CommandOutcome> {
  try {
    const printed = await handleHook(JSON.parse(stdin), context);
    return { code: 0, stdout: printed ? printed + '\n' : '', stderr: '' };
  } catch (err) {
    return {
      code: 0,
      stdout: '',
      stderr: `Agent Ops hook: ${String((err as Error)?.message ?? err)
        .replace(/\p{Cc}/gu, ' ')
        .slice(0, 300)}\n`,
    };
  }
}
