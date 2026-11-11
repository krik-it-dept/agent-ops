// Joins reported runs to the plans the collector read. Runs match a plan by
// its file path, case-insensitively; each plan gets its latest 50 runs.

import { promises as fs } from 'node:fs';
import type { AgentRun } from '../../../shared/contracts';
import type { Diagnostic, Plan } from '../plans/overview';
import {
  MAX_RUN_FILE_BYTES,
  MAX_RUN_FILES,
  listRuns,
  parseRun,
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
        : (same.find((s) => s.index === reported.index) ??
          (plan && last.revision === plan.revision
            ? plan.steps.find((s) => s.line === reported.line)
            : undefined));
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
  const byFile = new Map<string, Plan>();
  for (const plan of out.plans) byFile.set(plan.file.toLowerCase(), plan);
  const runs = new Map<Plan, AgentRun[]>();
  const skipped = new Map<Plan, number>();
  let lost = 0;
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
    let text: string;
    try {
      text = await fs.readFile(run.file, 'utf8');
    } catch {
      lost++;
      continue;
    }
    const { records, skipped: bad } = parseRun(run.runId, text);
    const first = records[0];
    if (!first) {
      if (bad) lost++;
      continue;
    }
    const plan = byFile.get(first.file.toLowerCase());
    if (!plan) continue;
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
}
