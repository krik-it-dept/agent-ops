// The report command: `agent-ops.exe --report --agent <name> --plan-file <plan.md>
// --event start|progress|done|blocked|stopped [--step-line <n>] [--run-id <id>]
// [--coordinator <name>] [--role coordinator|executor] [--result <text>]
// [--revision <sha256>]`. Agents record their own work with it; Agent Ops
// only reads the records. It never edits the plan and never assigns work.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  isAbsolutePath,
  isNetworkOrDevicePath,
  realKey,
} from '../../lib/safe-io/paths';
import { canonicalAgent } from '../plans/agents';
import { projectRepos, tasksWorkspaces } from '../plans/collect';
import { longPath, MAX_PLAN_BYTES, readPlanFile, slash } from '../plans/io';
import { buildPlan } from '../plans/overview';
import { parseMarkdown } from '../plans/parse';
import { configFilePath, readConfig } from '../settings/config-store';
import { NewerConfigError } from '../settings/config';
import type { RunEvent } from '../../../shared/contracts';
import {
  MAX_RESULT_CHARS,
  MAX_RUN_EVENTS,
  MAX_RUN_FILE_BYTES,
  RECORD_VERSION,
  RUN_EVENTS,
  RUNS_DIR_NAME,
  appendRecord,
  isTerminal,
  readRun,
  validRunId,
  withRunLock,
  type RunRecord,
  type RunStep,
} from './store';

export const REPORT_FLAG = '--report';
const OPTIONS = [
  'agent',
  'plan-file',
  'step-line',
  'event',
  'run-id',
  'coordinator',
  'role',
  'result',
  'revision',
] as const;
type Option = (typeof OPTIONS)[number];
export const REPORT_USAGE =
  'Use: --report --agent <name> --plan-file <full path of plan.md> --event start|progress|done|blocked|stopped [--step-line <line>] [--run-id <id>] [--coordinator <name>] [--role coordinator|executor] [--result <text>]';

export class ReportError extends Error {}
function fail(message: string): never {
  throw new ReportError(message);
}

/** parseReportArgs reads `--name value` and `--name=value` pairs; each option at most once. */
export function parseReportArgs(
  args: readonly string[],
): Partial<Record<Option, string>> {
  const out: Partial<Record<Option, string>> = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const m = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(token);
    if (!m) fail(`Unexpected value "${token}". ${REPORT_USAGE}`);
    const name = m![1] as Option;
    if (!OPTIONS.includes(name))
      fail(`Unknown option --${m![1]}. ${REPORT_USAGE}`);
    if (Object.hasOwn(out, name)) fail(`--${name} is given twice.`);
    let value = m![2];
    if (value === undefined) {
      value = args[i + 1];
      if (value === undefined || value.startsWith('--'))
        fail(
          `--${name} needs a value. A value that starts with -- can be written as --${name}=<value>.`,
        );
      i++;
    }
    out[name] = value;
  }
  return out;
}

export interface ReportContext {
  dataDir: string;
  now?: () => Date;
  newRunId?: () => string;
}
export interface ReportOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** runReport runs one report and never throws: errors become a plain message and exit code 1. */
export async function runReport(
  args: readonly string[],
  context: ReportContext,
): Promise<ReportOutcome> {
  try {
    const printed = await report(parseReportArgs(args), context);
    return { code: 0, stdout: printed + '\n', stderr: '' };
  } catch (err) {
    const message =
      err instanceof ReportError
        ? err.message
        : `The report could not be saved (${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'unknown error'}).`;
    const plain = message.replace(/\p{Cc}/gu, ' ').slice(0, 1000);
    return { code: 1, stdout: '', stderr: `Agent Ops report: ${plain}\n` };
  }
}

async function planFolders(dataDir: string): Promise<string[]> {
  let config;
  try {
    config = await readConfig(configFilePath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      fail(
        'Agent Ops is not set up on this computer yet, so there is no Tasks folder to report on.',
      );
    if (err instanceof NewerConfigError)
      fail(
        'The Agent Ops settings come from a newer version. Use that version to report.',
      );
    fail(
      'The Agent Ops settings cannot be read, so the plan location cannot be checked.',
    );
  }
  const dirs: string[] = [];
  if (config!.tasksDir) {
    for (const ws of await tasksWorkspaces(config!.tasksDir).catch(() => []))
      dirs.push(path.join(config!.tasksDir, ws));
  }
  for (const project of config!.projects) {
    if (project.enabled === false) continue;
    for (const repo of await projectRepos(project).catch(() => []))
      dirs.push(path.join(repo.root, '.tasks'));
  }
  return dirs;
}

/** locatePlan returns the plan file as the collector names it, or fails when Agent Ops does not read it. */
async function locatePlan(dataDir: string, file: string): Promise<string> {
  file = await longPath(file);
  const name = path.basename(file);
  if (!/\.md$/i.test(name) || name.toLowerCase() === 'tong-hop.md')
    fail('--plan-file must be a plan, a .md file.');
  const parent = await realKey(path.dirname(file));
  for (const dir of await planFolders(dataDir)) {
    if ((await realKey(dir)) !== parent) continue;
    const entry = (await fs.readdir(dir)).find(
      (n) => n.toLowerCase() === name.toLowerCase(),
    );
    if (!entry) break;
    return slash(await longPath(path.join(dir, entry)));
  }
  return fail(
    'The plan file is not in the Tasks folder or in a workspace plan folder that Agent Ops reads.',
  );
}

async function readPlan(file: string) {
  let info;
  try {
    info = await fs.stat(file);
  } catch {
    return fail('The plan file cannot be read.');
  }
  if (!info.isFile()) fail('--plan-file is not a file.');
  if (info.size > MAX_PLAN_BYTES)
    fail('The plan is over 8 MB, so Agent Ops does not read it.');
  const bytes = await readPlanFile(file).catch(() =>
    fail('The plan file cannot be read.'),
  );
  if (bytes.length > MAX_PLAN_BYTES)
    fail('The plan is over 8 MB, so Agent Ops does not read it.');
  return buildPlan(parseMarkdown(bytes));
}

function sameStep(a: RunStep | null, b: RunStep | null): boolean {
  if (!a || !b) return a === b;
  return a.text === b.text && a.milestone === b.milestone;
}

async function report(
  o: Partial<Record<Option, string>>,
  context: ReportContext,
): Promise<string> {
  const event = o.event as RunEvent | undefined;
  if (!event || !RUN_EVENTS.includes(event))
    fail('--event must be start, progress, done, blocked or stopped.');
  const agent = canonicalAgent(o.agent ?? '');
  if (!agent)
    fail(
      o.agent && agent === undefined
        ? '--agent must be a plain name of at most 40 letters, digits, spaces, dots, dashes or underscores.'
        : 'Name the agent doing the work with --agent, for example --agent Codex.',
    );
  const coordinator =
    o.coordinator === undefined ? undefined : canonicalAgent(o.coordinator);
  if (o.coordinator !== undefined && coordinator === undefined)
    fail('--coordinator must be a plain agent name of at most 40 characters.');
  const role = o.role as 'coordinator' | 'executor' | undefined;
  if (role !== undefined && role !== 'coordinator' && role !== 'executor')
    fail('--role must be coordinator or executor.');
  const result = (o.result ?? '').trim();
  if (/\p{Cc}/u.test((o.result ?? '').replace(/[\t\r\n]/g, '')))
    fail('--result must be plain text without control characters.');
  if (Array.from(result).length > MAX_RESULT_CHARS)
    fail(
      `--result is longer than ${MAX_RESULT_CHARS} characters. Keep the essential evidence.`,
    );
  if (isTerminal(event!) && !result)
    fail(
      `A ${event} report needs --result: what was observed (tests, commit, PR) or what blocks the work.`,
    );
  let stepLine: number | undefined;
  if (o['step-line'] !== undefined) {
    stepLine = Number(o['step-line']);
    if (
      !/^\d+$/.test(o['step-line']) ||
      !Number.isSafeInteger(stepLine) ||
      stepLine < 1
    )
      fail(
        '--step-line must be the line number of a checklist step, for example 42.',
      );
  }
  if (o.revision !== undefined && !/^[a-f0-9]{64}$/i.test(o.revision))
    fail('--revision must be the 64-character plan revision.');
  const raw = o['plan-file'];
  if (!raw) fail('Give the plan with --plan-file and its full path.');
  if (
    !isAbsolutePath(raw!) ||
    isNetworkOrDevicePath(raw!) ||
    /\p{Cc}/u.test(raw!)
  )
    fail('--plan-file must be the full path of a plan on this computer.');
  let runId = o['run-id']?.toLowerCase();
  if (runId !== undefined && !validRunId(runId))
    fail('--run-id must be the run ID printed by the start report.');
  if (event !== 'start' && runId === undefined)
    fail(
      `A ${event} report needs --run-id, the run ID printed by the start report.`,
    );

  const file = await locatePlan(context.dataDir, path.resolve(raw!));
  const plan = await readPlan(file);
  if (o.revision && o.revision.toLowerCase() !== plan.revision)
    fail('The plan changed since it was read. Read it again, then report.');
  let step: RunStep | null = null;
  if (stepLine !== undefined) {
    const found = plan.steps.find((s) => s.line === stepLine);
    if (!found)
      fail(
        `Line ${stepLine} of the plan is not a checklist step. Read the plan again and use the step's line.`,
      );
    step = {
      line: found!.line,
      text: found!.text,
      milestone: found!.milestone,
      index: found!.index,
    };
  }
  const runsDir = path.join(context.dataDir, RUNS_DIR_NAME);
  const now = context.now ?? (() => new Date());
  runId ??= (context.newRunId ?? randomUUID)().toLowerCase();

  return withRunLock(runsDir, runId, async () => {
    const run = await readRun(runsDir, runId);
    const first = run.records[0];
    const last = run.records[run.records.length - 1];
    let record: RunRecord;
    if (event === 'start') {
      if (first || run.bytes > 0)
        fail(
          `Run ${runId} already exists. Continue it with progress, done, blocked or stopped, or start a new run without --run-id.`,
        );
      let who = coordinator;
      let as = role;
      if (as === 'coordinator') {
        if (who && who !== agent)
          fail(
            'A coordinator reports its own work: leave out --coordinator, or use --role executor.',
          );
        who = agent!;
      } else {
        who ??= plan.agent ?? (as === 'executor' ? '' : agent!);
        as ??= who === agent ? 'coordinator' : 'executor';
      }
      record = base(as, who!);
    } else {
      if (!first)
        fail(
          `Run ${runId} is unknown. Start a run with --event start and keep the run ID it prints.`,
        );
      if (first!.agent !== agent)
        fail(
          `Run ${runId} belongs to ${first!.agent}; only that agent can continue it.`,
        );
      if (first!.file.toLowerCase() !== file.toLowerCase())
        fail(`Run ${runId} is for another plan file: ${first!.file}.`);
      if (isTerminal(last!.event))
        fail(
          `Run ${runId} already ended (${last!.event}). Start a new run for new work.`,
        );
      if (coordinator !== undefined && coordinator !== first!.coordinator)
        fail(
          `Run ${runId} is coordinated by ${first!.coordinator || 'no one'}; --coordinator must match.`,
        );
      if (role !== undefined && role !== first!.role)
        fail(`Run ${runId} was started as ${first!.role}; --role must match.`);
      if (step) {
        if (!sameStep(step, first!.step))
          fail(
            `Run ${runId} works on another step. Start a new run for this step.`,
          );
      } else if (first!.step) {
        // Follow the step when lines moved; keep the recorded step when it was reworded.
        const now = plan.steps.filter(
          (s) =>
            s.text === first!.step!.text &&
            s.milestone === first!.step!.milestone,
        );
        const found =
          now.length === 1
            ? now[0]!
            : now.find((s) => s.index === first!.step!.index);
        step = found
          ? {
              line: found.line,
              text: found.text,
              milestone: found.milestone,
              index: found.index,
            }
          : first!.step;
      }
      if (
        run.records.length >= MAX_RUN_EVENTS ||
        run.bytes >= MAX_RUN_FILE_BYTES
      )
        fail(
          `Run ${runId} has too many reports. Finish it, or start a new run.`,
        );
      record = base(first!.role, first!.coordinator);
    }
    // The plan must not change while the report is prepared; it is never written.
    if ((await readPlan(file)).revision !== plan.revision)
      fail(
        'The plan changed while the report was prepared. Read it again, then report.',
      );
    await appendRecord(runsDir, record);
    return event === 'start' ? runId : 'ok';

    function base(as: 'coordinator' | 'executor', who: string): RunRecord {
      const at = Math.max(now().getTime(), last ? Date.parse(last.at) + 1 : 0);
      return {
        v: RECORD_VERSION,
        runId: runId!,
        at: new Date(at).toISOString(),
        event: event!,
        agent: agent!,
        coordinator: who,
        role: as,
        file,
        revision: plan.revision,
        step,
        result,
      };
    }
  });
}
