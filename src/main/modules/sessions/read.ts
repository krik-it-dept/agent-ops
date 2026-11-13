// Reads session files into the summaries the Sessions page shows.

import path from 'node:path';
import type {
  SessionNote,
  SessionSummary,
  SessionsResponse,
} from '../../../shared/contracts';
import { latestTodos, workspaceOf } from './context';
import {
  listSessions,
  MAX_SESSION_FILES,
  readSession,
  type SessionRecord,
} from './store';

/** A session with no record for this long is shown as quiet, not active. */
export const QUIET_AFTER_MS = 2 * 60 * 60 * 1000;
export const MAX_NOTES_PER_SESSION = 10;

function stateOf(last: SessionRecord, now: Date): SessionSummary['state'] {
  if (last.kind === 'end') return 'ended';
  if (now.getTime() - Date.parse(last.at) > QUIET_AFTER_MS) return 'quiet';
  if (last.kind === 'waiting') return 'waiting';
  if (last.kind === 'idle') return 'idle';
  if (last.kind === 'handoff') return 'note';
  return 'active';
}

function note(r: SessionRecord): SessionNote {
  return {
    at: r.at,
    agent: r.agent,
    text: r.text ?? '',
    auto: r.auto === true,
  };
}

/** readSessions summarizes the newest session files, newest activity first. */
export async function readSessions(
  dir: string,
  now: Date,
): Promise<SessionsResponse> {
  const workspaces = new Map<string, string>();
  const sessions: SessionSummary[] = [];
  for (const f of (await listSessions(dir)).slice(0, MAX_SESSION_FILES)) {
    const records = await readSession(dir, f.id).catch(() => []);
    const first = records[0];
    const last = records[records.length - 1];
    if (!first || !last) continue;
    const cwd = last.cwd || first.cwd;
    let workspace = workspaces.get(cwd.toLowerCase());
    if (workspace === undefined) {
      workspace = await workspaceOf(cwd).catch(() => path.basename(cwd));
      workspaces.set(cwd.toLowerCase(), workspace);
    }
    const waiting = last.kind === 'waiting' ? (last.message ?? '') : '';
    const prompt = [...records].reverse().find((r) => r.kind === 'prompt');
    sessions.push({
      id: f.id,
      agent: last.agent,
      cwd,
      workspace,
      startedAt: first.at,
      lastAt: last.at,
      state: stateOf(last, now),
      waiting,
      lastPrompt: prompt?.message ?? '',
      todos: latestTodos(records) ?? [],
      notes: records
        .filter((r) => r.kind === 'handoff')
        .slice(-MAX_NOTES_PER_SESSION)
        .reverse()
        .map(note),
      compactions: records.filter((r) => r.kind === 'compact').length,
    });
  }
  sessions.sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  return { sessions, readAt: now.toISOString() };
}
