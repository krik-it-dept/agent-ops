// Joins reported runs to the plans the collector read. Runs match a plan by
// its file path, case-insensitively; each plan gets its latest 50 runs.

import path from 'node:path';
import type { AgentRun } from '../../../shared/contracts';
import { pathKey, realKey } from '../../lib/safe-io/paths';
import type { Diagnostic, Plan } from '../plans/overview';
import {
  MAX_RUN_FILE_BYTES,
  MAX_RUN_FILES,
  listRuns,
  readRun,
  type RunRecord,
} from './store';

export const MAX_RUNS_PER_PLAN = 50;
/** A run whose latest event is start or progress counts as working now for this long. */
export const ACTIVE_FOR_MS = 12 * 60 * 60 * 1000;

/** summarize turns a run's records into its latest state, mapped onto the plan as it is now. */
export function summarize(
  records: RunRecord[],
  plan: Pick<Plan, 'steps' | 'revision'> | undefined,
  now: Date,
): AgentRun {
  const first = records[0]!;
  const last = records[records.length - 1]!;
  let step: AgentRun['step'] = null;
  const reported = [...records].reverse().find((r) => r.step)?.step ?? null;
  if (reported) {
    const same = (plan?.steps ?? []).filter(
      (s) => s.text === reported.text && s.milestone === reported.milestone,
    );
    const found =
      same.length === 1
        ? same[0]
        : same.find((s) => s.index === reported.index);
    step = found
      ? { line: found.line, text: found.text, milestone: found.milestone }
      : {
          line: reported.line,
          text: reported.text,
          milestone: reported.milestone,
        };
  }
  const updated = Date.parse(last.at);
  return {
    runId: first.runId,
    agent: first.agent,
    coordinator: first.coordinator,
    role: first.role,
    event: last.event,
    active:
      (last.event === 'start' || last.event === 'progress') &&
      now.getTime() - updated <= ACTIVE_FOR_MS,
    startedAt: first.at,
    updatedAt: last.at,
    step,
    result: [...records].reverse().find((r) => r.result)?.result ?? '',
  };
}

/**
 * attachRuns sets plan.runs on every plan that has reported runs (newest
 * first, at most 50) and adds a diagnostic for run lines that could not be
 * read. A missing runs folder means no runs.
 */
export async function attachRuns(
  out: { plans: Plan[]; diagnostics: Diagnostic[] },
  runsDir: string,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  // Plans and reports may name the same file differently (8.3 short names,
  // junctions, case), so both sides are also keyed by their real folder.
  const realDirs = new Map<string, Promise<string>>();
  const realFileKey = async (file: string): Promise<string> => {
    const dir = path.dirname(file);
    let real = realDirs.get(dir.toLowerCase());
    if (!real) {
      real = realKey(dir);
      realDirs.set(dir.toLowerCase(), real);
    }
    return pathKey(path.join(await real, path.basename(file)));
  };
  const byFile = new Map<string, Plan>();
  for (const plan of out.plans) byFile.set(plan.file.toLowerCase(), plan);
  // Real keys are only built when a report does not match by text.
  let byRealFile: Map<string, Plan> | undefined;
  const matchReal = async (file: string): Promise<Plan | undefined> => {
    if (!byRealFile) {
      byRealFile = new Map();
      for (const plan of out.plans)
        byRealFile.set(await realFileKey(plan.file), plan);
    }
    return byRealFile.get(await realFileKey(file));
  };
  const runs = new Map<Plan, AgentRun[]>();
  const skipped = new Map<Plan, number>();
  let lost = 0;
  let unmatched = 0;
  let files;
  try {
    files = await listRuns(runsDir);
  } catch {
    out.diagnostics.push({
      project: '',
      repo: '',
      plan: '',
      file: runsDir.replace(/\\/g, '/'),
      kind: 'folder-unreadable',
      message: 'The folder of agent reports cannot be read.',
    });
    return;
  }
  for (const run of files.slice(0, MAX_RUN_FILES)) {
    signal?.throwIfAborted();
    if (run.size > MAX_RUN_FILE_BYTES * 2) {
      lost++;
      continue;
    }
    let parsed;
    try {
      parsed = await readRun(runsDir, run.runId);
    } catch {
      lost++;
      continue;
    }
    const { records, skipped: bad } = parsed;
    const first = records[0];
    if (!first) {
      if (bad) lost++;
      continue;
    }
    const plan =
      byFile.get(first.file.toLowerCase()) ?? (await matchReal(first.file));
    if (!plan) {
      unmatched++;
      continue;
    }
    if (bad) skipped.set(plan, (skipped.get(plan) ?? 0) + bad);
    const list = runs.get(plan) ?? [];
    list.push(summarize(records, plan, now));
    runs.set(plan, list);
  }
  for (const [plan, list] of runs)
    plan.runs = list
      .sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          (a.runId < b.runId ? -1 : 1),
      )
      .slice(0, MAX_RUNS_PER_PLAN);
  for (const [plan, count] of skipped)
    out.diagnostics.push({
      project: plan.project,
      repo: plan.repo,
      plan: plan.name,
      file: plan.file,
      kind: 'unreadable',
      message: `${count} agent report ${count === 1 ? 'line' : 'lines'} for this plan could not be read and ${count === 1 ? 'was' : 'were'} skipped.`,
    });
  if (lost)
    out.diagnostics.push({
      project: '',
      repo: '',
      plan: '',
      file: runsDir.replace(/\\/g, '/'),
      kind: 'unreadable',
      message: `${lost} agent report ${lost === 1 ? 'file' : 'files'} could not be read and ${lost === 1 ? 'was' : 'were'} skipped.`,
    });
  if (unmatched)
    out.diagnostics.push({
      project: '',
      repo: '',
      plan: '',
      file: runsDir.replace(/\\/g, '/'),
      kind: 'unreadable',
      message: `${unmatched} agent report ${unmatched === 1 ? 'file names a plan' : 'files name plans'} that Agent Ops cannot currently read.`,
    });
}
