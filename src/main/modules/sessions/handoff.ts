// The handoff command: `agent-ops.exe --handoff --agent <name> --text <note>
// [--cwd <folder>] [--session <id>]`. Any agent writes a note for the session
// that comes after a clear, a compact or a new start in the same folder.
// `agent-ops.exe --handoff --show [--cwd <folder>]` prints the newest note for
// the folder, for clients without hooks. Agent Ops only reads the notes.

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isAbsolutePath, isNetworkOrDevicePath } from '../../lib/safe-io/paths';
import { latestHandoff } from './context';
import {
  appendSessionRecord,
  canonicalAgent,
  cleanText,
  MAX_HANDOFF_CHARS,
  RECORD_VERSION,
  SESSIONS_DIR_NAME,
  validSessionId,
} from './store';

export const HANDOFF_FLAG = '--handoff';
export const HANDOFF_USAGE =
  'Use: --handoff --agent <name> --text "<what is done, what is next, decisions, files and commands to remember>" [--cwd <folder>], or --handoff --show [--cwd <folder>]';

const OPTIONS = ['agent', 'text', 'cwd', 'session', 'show'] as const;
type Option = (typeof OPTIONS)[number];

export interface CommandContext {
  dataDir: string;
  cwd: string;
  now?: () => Date;
}
export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

class HandoffError extends Error {}
function fail(message: string): never {
  throw new HandoffError(message);
}

function parse(args: readonly string[]): Partial<Record<Option, string>> {
  const out: Partial<Record<Option, string>> = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(args[i]!);
    if (!m) fail(`Unexpected value "${args[i]}". ${HANDOFF_USAGE}`);
    const name = m![1] as Option;
    if (!OPTIONS.includes(name))
      fail(`Unknown option --${m![1]}. ${HANDOFF_USAGE}`);
    if (Object.hasOwn(out, name)) fail(`--${name} is given twice.`);
    if (name === 'show') {
      out.show = '1';
      continue;
    }
    let value = m![2];
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined || value.startsWith('--'))
        fail(
          `--${name} needs a value, written as --${name}=<value> when it starts with --.`,
        );
      i++;
    }
    out[name] = value;
  }
  return out;
}

function folder(raw: string | undefined, fallback: string): string {
  const cwd = raw ?? fallback;
  if (!isAbsolutePath(cwd) || isNetworkOrDevicePath(cwd) || /\p{Cc}/u.test(cwd))
    fail('--cwd must be the full path of a folder on this computer.');
  return path.resolve(cwd);
}

/** runHandoff writes or shows one handoff and never throws. */
export async function runHandoff(
  args: readonly string[],
  context: CommandContext,
): Promise<CommandOutcome> {
  try {
    const o = parse(args);
    const dir = path.join(context.dataDir, SESSIONS_DIR_NAME);
    const now = (context.now ?? (() => new Date()))();
    const cwd = folder(o.cwd, context.cwd);
    if (o.show) {
      if (o.text !== undefined || o.agent !== undefined)
        fail('--show only reads; leave out --agent and --text.');
      const found = await latestHandoff(dir, cwd, now);
      const r = found?.record;
      return {
        code: 0,
        stdout: r
          ? `Handoff by ${r.agent} at ${r.at}:\n${r.text}\n`
          : 'No handoff for this folder.\n',
        stderr: '',
      };
    }
    const agent = canonicalAgent(o.agent ?? '');
    if (!agent)
      fail(
        'Name the agent writing the note with --agent, for example --agent Claude.',
      );
    const text = cleanText(o.text ?? '', MAX_HANDOFF_CHARS + 1);
    if (!text) fail('Write the note with --text.');
    if (Array.from(text).length > MAX_HANDOFF_CHARS)
      fail(
        `--text is longer than ${MAX_HANDOFF_CHARS} characters. Keep what the next session needs.`,
      );
    const session = o.session ?? `handoff-${randomUUID()}`;
    if (!validSessionId(session))
      fail('--session must be letters, digits, - or _, at most 80 characters.');
    await appendSessionRecord(dir, {
      v: RECORD_VERSION,
      at: now.toISOString(),
      session,
      kind: 'handoff',
      agent,
      cwd,
      text,
    });
    return { code: 0, stdout: 'ok\n', stderr: '' };
  } catch (err) {
    const message =
      err instanceof HandoffError
        ? err.message
        : `The handoff could not be saved (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'unknown error'}).`;
    return {
      code: 1,
      stdout: '',
      stderr: `Agent Ops handoff: ${message.replace(/\p{Cc}/gu, ' ').slice(0, 1000)}\n`,
    };
  }
}
