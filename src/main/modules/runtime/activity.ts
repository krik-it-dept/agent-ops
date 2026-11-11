import {
  ActivityLog,
  isStale,
  mapLegacyKeys,
  upgradeActivityFile,
  type Plan as ActivityPlan,
  type ActivityEvent,
} from '../activity';
import type { Overview, Plan } from '../plans';
import type { ActivityPort } from '../ledger';
import type { CoreServices } from './core';
import type { Activity } from '../../../shared/contracts';

const kinds = new Set([
  'new',
  'closed',
  'moved',
  'status',
  'done',
  'doing',
  'blocked',
  'partial',
  'decision',
  'question',
  'answer',
  'milestone',
  'waiting',
  'stale',
  'run-started',
  'run-finished',
  'run-blocked',
]);
const knownActivity = (event: ActivityEvent): event is Activity =>
  kinds.has(event.kind);

function snapshotPlan(p: Plan): ActivityPlan {
  return {
    revision: p.revision,
    owner: p.owner,
    project: p.project,
    projectName: p.projectName,
    root: p.root,
    repo: p.repo,
    name: p.name,
    status: p.status,
    mtime: p.mtime,
    decisions: p.decisions.map((d) => ({
      ...d,
      ask: '',
      answer: '',
      open: false,
    })),
    questions: p.questions.map((q) => ({ ...q, text: '' })),
    milestones: p.milestones.map(({ id, title, state, summary, steps }) => ({
      id,
      title,
      state,
      summary,
      steps,
    })),
    steps: p.steps,
    source: p.source,
    file: p.file,
    workspace: p.workspace,
    runs: (p.runs ?? []).map((r) => ({
      runId: r.runId,
      event: r.event,
      agent: r.agent,
      step: r.step?.text ?? '',
      result: r.result,
    })),
  };
}
export function activityAdapter(
  dataDir: string,
  core: CoreServices,
  notify?: (events: ActivityEvent[]) => void,
): ActivityPort {
  const log = new ActivityLog({ dataDir });
  const known = () => [
    ...core.store.get().projects.map((p) => p.id),
    ...(core.store.get().tasksDir ? ['tasks'] : []),
  ];
  return {
    load: async () => {
      if (!core.store.readOnly)
        await upgradeActivityFile(dataDir, core.store.get().projects);
      await log.load();
      if (!core.store.readOnly)
        await mapLegacyKeys(log, core.store.get().projects);
    },
    apply: async (overview: Overview) => {
      const events = await log.apply(
        {
          projects: overview.projects,
          plans: overview.plans.map(snapshotPlan),
        },
        known(),
      );
      notify?.([...events.fresh, ...events.staleAnnounce]);
    },
    tick: async () => {
      const before = log.events.length;
      const events = await log.checkStale(known());
      notify?.(events);
      return before !== log.events.length || events.length > 0;
    },
    snapshot: () => ({
      activity: log.events
        .filter(knownActivity)
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)),
      stale: Object.fromEntries(
        Object.entries(log.prev ?? {}).map(([key, p]) => [
          key,
          isStale(p, new Date()),
        ]),
      ),
      warnings: log.warnings,
    }),
  };
}
