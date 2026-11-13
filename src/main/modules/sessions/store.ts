// Session records: what AI client sessions recorded about themselves, one
// append-only JSON Lines file per session under <dataDir>\sessions\<id>.jsonl.
// Writers are the hook command (Claude Code hooks) and the handoff command
// (any agent). The app only reads the files and prunes old ones. A record is
// presence and notes; it never says whether work is accepted.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalAgent } from '../plans/agents';

export const SESSIONS_DIR_NAME = 'sessions';
export const SESSION_KINDS = [
  'start',
  'prompt',
  'todos',
  'waiting',
  'idle',
  'compact',
  'end',
  'handoff',
] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];
export const TODO_STATES = ['pending', 'in_progress', 'completed'] as const;
export type TodoState = (typeof TODO_STATES)[number];
export interface SessionTodo {
  text: string;
  state: TodoState;
}

export const MAX_HANDOFF_CHARS = 8000;
export const MAX_TODOS = 100;
export const MAX_TODO_CHARS = 500;
export const MAX_MESSAGE_CHARS = 500;
/** A session file stops taking records at this size. */
export const MAX_SESSION_FILE_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 64 * 1024;
/** The reader reads at most this many session files, newest first. */
export const MAX_SESSION_FILES = 300;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
export const RECORD_VERSION = 1;

export interface SessionRecord {
  v: 1;
  at: string;
  session: string;
  kind: SessionKind;
  agent: string;
  /** The working folder the session runs in. */
  cwd: string;
  /** start: startup|resume|clear|compact; compact: manual|auto; end: the client's reason. */
  source?: string;
  /** waiting: what the client asks the owner; prompt: the first words of the prompt. */
  message?: string;
  todos?: SessionTodo[];
  /** handoff: the note for the next session. */
  text?: string;
  /** handoff: written by a hook from the session's todos, not by the agent. */
  auto?: boolean;
  /** start: the handoffs this start loaded, as "<session>@<at>". */
  loaded?: string[];
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const validSessionId = (id: string): boolean => SESSION_ID.test(id);
export function sessionFile(dir: string, id: string): string {
  if (!validSessionId(id)) throw new Error('Invalid session ID.');
  return path.join(dir, `${id}.jsonl`);
}
export const handoffRef = (r: Pick<SessionRecord, 'session' | 'at'>): string =>
  `${r.session}@${r.at}`;

const isString = (v: unknown): v is string => typeof v === 'string';
const plain = (v: string, max: number): boolean =>
  Array.from(v).length <= max && !/\p{Cc}/u.test(v.replace(/[\t\r\n]/g, ''));

/** cleanText trims, drops control characters and cuts text to max characters. */
export function cleanText(v: string, max: number): string {
  const text = v.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\t\n]/gu, ' ');
  const chars = Array.from(text.trim());
  return chars.length > max
    ? chars.slice(0, max - 1).join('') + '…'
    : chars.join('');
}

function isTodo(v: unknown): v is SessionTodo {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    isString(t.text) &&
    plain(t.text, MAX_TODO_CHARS) &&
    TODO_STATES.includes(t.state as TodoState)
  );
}

export function isSessionRecord(v: unknown): v is SessionRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.v === RECORD_VERSION &&
    isString(r.at) &&
    Number.isFinite(Date.parse(r.at)) &&
    isString(r.session) &&
    validSessionId(r.session) &&
    SESSION_KINDS.includes(r.kind as SessionKind) &&
    isString(r.agent) &&
    r.agent !== '' &&
    canonicalAgent(r.agent) === r.agent &&
    isString(r.cwd) &&
    plain(r.cwd, 1000) &&
    (r.source === undefined ||
      (isString(r.source) && /^[a-z_-]{1,40}$/.test(r.source))) &&
    (r.message === undefined ||
      (isString(r.message) && plain(r.message, MAX_MESSAGE_CHARS))) &&
    (r.todos === undefined ||
      (Array.isArray(r.todos) &&
        r.todos.length <= MAX_TODOS &&
        r.todos.every(isTodo))) &&
    (r.text === undefined ||
      (isString(r.text) && plain(r.text, MAX_HANDOFF_CHARS))) &&
    (r.auto === undefined || typeof r.auto === 'boolean') &&
    (r.loaded === undefined ||
      (Array.isArray(r.loaded) &&
        r.loaded.length <= 10 &&
        r.loaded.every((x) => isString(x) && x.length <= 200))) &&
    (r.kind !== 'handoff' || (isString(r.text) && r.text.trim() !== ''))
  );
}

/** stripBom drops a leading byte order mark. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

/** parseSession reads a session file's text; invalid lines and lines of another session are skipped. */
export function parseSession(id: string, text: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const line of stripBom(text).split('\n')) {
    if (line.trim() === '' || Buffer.byteLength(line) > MAX_LINE_BYTES)
      continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isSessionRecord(value) && value.session === id) out.push(value);
  }
  return out;
}

/** Never follow a redirected sessions folder. */
async function requireDirectory(dir: string): Promise<void> {
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      'The sessions folder must be a regular folder, not a link.',
    );
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
      throw new Error('A session file must be a regular file without links.');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** readSession reads one session file; a missing or oversized file has no records. */
export async function readSession(
  dir: string,
  id: string,
): Promise<SessionRecord[]> {
  const file = sessionFile(dir, id);
  try {
    await requireDirectory(dir);
    if (!(await regularFile(file))) return [];
    const info = await fs.stat(file);
    if (info.size > MAX_SESSION_FILE_BYTES * 2) return [];
    return parseSession(id, await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * appendSessionRecord appends one complete line in a single write. Hooks of
 * one session can run at once; a line cut by a crash gets a newline first and
 * stays one skipped line.
 */
export async function appendSessionRecord(
  dir: string,
  record: SessionRecord,
): Promise<void> {
  if (!isSessionRecord(record)) throw new Error('Invalid session record.');
  await fs.mkdir(dir, { recursive: true });
  await requireDirectory(dir);
  const file = sessionFile(dir, record.session);
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line) - 1 > MAX_LINE_BYTES)
    throw new Error('The session record is too large.');
  const handle = await fs.open(file, 'a+');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1)
      throw new Error('A session file must be a regular file without links.');
    let prefix = '';
    if (info.size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    if (info.size + Buffer.byteLength(prefix + line) > MAX_SESSION_FILE_BYTES)
      throw new Error('This session has too many records.');
    await handle.appendFile(prefix + line);
  } finally {
    await handle.close();
  }
}

export interface SessionFile {
  id: string;
  file: string;
  mtimeMs: number;
}
/** listSessions returns session files, newest first. A missing folder has none. */
export async function listSessions(dir: string): Promise<SessionFile[]> {
  let names: string[];
  try {
    await requireDirectory(dir);
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    const m = /^(.+)\.jsonl$/.exec(name);
    if (!m || !validSessionId(m[1]!)) continue;
    const file = path.join(dir, name);
    try {
      const info = await fs.lstat(file);
      if (info.isFile()) out.push({ id: m[1]!, file, mtimeMs: info.mtimeMs });
    } catch {
      /* Removed while listing. */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : 1));
}

/** pruneSessions removes session files not written for 30 days. */
export async function pruneSessions(dir: string, now: Date): Promise<number> {
  let removed = 0;
  const cutoff = now.getTime() - PRUNE_AFTER_MS;
  for (const s of await listSessions(dir)) {
    if (s.mtimeMs >= cutoff) continue;
    await fs.rm(s.file, { force: true });
    removed++;
  }
  return removed;
}

/** sameFolder compares working folders the way Windows does. */
export function folderKey(p: string): string {
  return path
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

export { canonicalAgent };
