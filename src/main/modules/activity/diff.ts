// The activity feed derived from what changed between two board snapshots,
// ported from main.go: new, changed (status, steps, decisions, questions,
// milestones), moved (one event, not closed + new), closed, and stale.

export type StepStatus = 'todo' | 'doing' | 'done' | 'partial' | 'blocked';

export interface Step {
  line?: number;
  milestone?: string;
  index?: number;
  status: StepStatus | string;
  text: string;
}

export interface Milestone {
  id: string;
  title: string;
  state: string;
  summary: string;
  steps: Step[];
}

export interface Entry {
  key: string;
  when: string;
  text: string;
  ask: string;
  answer: string;
  open: boolean;
}

/** RunMark is what the feed remembers of a reported run, to tell when it started or ended. */
export interface RunMark {
  runId: string;
  event: string;
  agent: string;
  step: string;
  result: string;
}

/** Plan is the part of a board plan the activity feed reads; other fields pass through the snapshot. */
export interface Plan {
  revision: string;
  owner: string;
  project?: string;
  projectName?: string;
  root?: string;
  repo: string;
  name: string;
  status: string;
  /** RFC 3339 time the plan file was last written. */
  mtime: string;
  decisions: Entry[];
  questions: Entry[];
  milestones: Milestone[];
  steps: Step[];
  source?: string;
  file?: string;
  workspace?: string;
  /** Reported runs; absent in snapshots from before run reporting, which then announce none. */
  runs?: RunMark[];
}

export type EventKind =
  | 'new'
  | 'closed'
  | 'moved'
  | 'status'
  | 'doing'
  | 'done'
  | 'blocked'
  | 'partial'
  | 'decision'
  | 'question'
  | 'answer'
  | 'milestone'
  | 'waiting'
  | 'stale'
  | 'run-started'
  | 'run-finished'
  | 'run-blocked';

export interface ActivityEvent {
  /** RFC 3339 time. */
  ts: string;
  project?: string;
  repo: string;
  plan: string;
  kind: EventKind | string;
  text: string;
  extra?: string;
  actor: string;
}

export type PlanMap = Record<string, Plan>;

/** A plan is stale after this long without a write while in an active stage. */
export const STALE_AFTER_MS = 120 * 60 * 1000;

export function planKey(p: Pick<Plan, 'project' | 'repo' | 'name'>): string {
  return p.project ? `${p.project}/${p.repo}/${p.name}` : `${p.repo}/${p.name}`;
}

export function stage(s: string): string {
  const i = s.indexOf(' - ');
  return i > 0 ? s.slice(0, i) : s;
}

export function actor(p: Plan): string {
  return (p.owner ?? '').trim() !== '' ? p.owner : p.repo;
}

function event(
  p: Plan,
  ts: string,
  kind: string,
  text: string,
  extra = '',
  who = actor(p),
): ActivityEvent {
  const e: ActivityEvent = {
    ts,
    repo: p.repo,
    plan: p.name,
    kind,
    text,
    actor: who,
  };
  if (p.project) e.project = p.project;
  if (extra !== '') e.extra = extra;
  return e;
}

/** entryTime reads a dated entry key YYYYMMDDHHMM in local time; a date-only key ends in 9999. */
export function entryTime(key: string): Date | undefined {
  if (!/^\d{12}$/.test(key)) return undefined;
  const k = key.endsWith('9999') ? key.slice(0, 8) + '0000' : key;
  const [y, mo, d, h, mi] = [
    k.slice(0, 4),
    k.slice(4, 6),
    k.slice(6, 8),
    k.slice(8, 10),
    k.slice(10, 12),
  ].map(Number) as [number, number, number, number, number];
  const t = new Date(y, mo - 1, d, h, mi);
  if (
    t.getFullYear() !== y ||
    t.getMonth() !== mo - 1 ||
    t.getDate() !== d ||
    t.getHours() !== h ||
    t.getMinutes() !== mi
  )
    return undefined;
  return t;
}

export function msDone(m: Milestone): boolean {
  if (m.state) return m.state === 'done';
  if (!m.steps || m.steps.length === 0) return false;
  return m.steps.every((s) => s.status === 'done');
}

/** time orders events; an unparsable time sorts first. */
export function timeOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** seed turns the dated history of plans into events: decisions, questions and done milestones with a summary. */
export function seed(cur: PlanMap): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const p of Object.values(cur)) {
    for (const d of p.decisions ?? []) {
      const t = entryTime(d.key);
      if (t) out.push(event(p, t.toISOString(), 'decision', d.text, d.when));
    }
    for (const q of p.questions ?? []) {
      const t = entryTime(q.key);
      if (t) out.push(event(p, t.toISOString(), 'question', q.ask, q.answer));
    }
    for (const m of p.milestones ?? []) {
      if (msDone(m) && (m.summary ?? '').trim() !== '')
        out.push(
          event(p, p.mtime, 'milestone', `${m.id}: ${m.title}`, m.summary),
        );
    }
  }
  return out
    .map((e, i) => [e, i] as const)
    .sort((a, b) => timeOf(a[0].ts) - timeOf(b[0].ts) || a[1] - b[1])
    .map(([e]) => e);
}

/** stepGroups groups steps by milestone in source order, also for snapshots from before step metadata. */
export function stepGroups(p: Plan): Map<string, Step[]> {
  const groups = new Map<string, Step[]>();
  const push = (id: string, steps: Step[]) =>
    groups.set(id, [...(groups.get(id) ?? []), ...steps]);
  const flat = p.steps ?? [];
  const used = new Array<boolean>(flat.length).fill(false);
  for (const m of p.milestones ?? []) {
    push(m.id, m.steps ?? []);
    for (const step of m.steps ?? []) {
      const i = flat.findIndex(
        (s, j) => !used[j] && s.text === step.text && s.status === step.status,
      );
      if (i >= 0) used[i] = true;
    }
  }
  flat.forEach((s, i) => {
    if (!used[i]) push(s.milestone ?? '', [s]);
  });
  return groups;
}

export function normalized(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}]/gu, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '')
    .join(' ');
}

export function similarity(a: string, b: string): number {
  const aa = normalized(a).split(' ').filter(Boolean);
  const bb = normalized(b).split(' ').filter(Boolean);
  const tokens = new Set(aa);
  const seen = new Set<string>();
  let common = 0;
  for (const t of bb) {
    if (tokens.has(t) && !seen.has(t)) common++;
    seen.add(t);
  }
  if (tokens.size + seen.size === 0) return 0;
  return (2 * common) / (tokens.size + seen.size);
}

/**
 * matchSteps pairs current steps with old ones: exact text first, then
 * similarity, then position. Each old step is consumed once, so duplicate
 * text and insertions cannot double-emit.
 */
export function matchSteps(old: Step[], cur: Step[]): number[] {
  const matches = new Array<number>(cur.length).fill(-1);
  const used = new Array<boolean>(old.length).fill(false);
  cur.forEach((s, i) => {
    const j = old.findIndex(
      (o, k) => !used[k] && normalized(s.text) === normalized(o.text),
    );
    if (j >= 0) {
      matches[i] = j;
      used[j] = true;
    }
  });
  cur.forEach((s, i) => {
    if (matches[i]! >= 0) return;
    let best = -1;
    let score = 0.49;
    old.forEach((o, j) => {
      if (used[j]) return;
      const v = similarity(s.text, o.text);
      if (v > score) {
        best = j;
        score = v;
      }
    });
    if (best >= 0) {
      matches[i] = best;
      used[best] = true;
    }
  });
  cur.forEach((_, i) => {
    if (matches[i]! < 0 && i < old.length && !used[i]) {
      matches[i] = i;
      used[i] = true;
    }
  });
  return matches;
}

/**
 * movedPlans pairs a plan that left old with one that appeared in cur under
 * another key with the same content and file name (a move into the Tasks
 * folder, or between Tasks folders), so a move is one event.
 */
export function movedPlans(
  old: PlanMap,
  cur: PlanMap,
): { movedFrom: Map<string, Plan>; movedAway: Set<string> } {
  const movedFrom = new Map<string, Plan>();
  const movedAway = new Set<string>();
  const gone = Object.keys(old)
    .filter(
      (k) =>
        !(k in cur) &&
        old[k]!.revision !== '' &&
        old[k]!.revision !== undefined,
    )
    .sort();
  const added = Object.keys(cur)
    .filter(
      (k) =>
        !(k in old) &&
        cur[k]!.revision !== '' &&
        cur[k]!.revision !== undefined,
    )
    .sort();
  for (const k of added) {
    const p = cur[k]!;
    for (const g of gone) {
      const o = old[g]!;
      if (
        !movedAway.has(g) &&
        o.revision === p.revision &&
        o.name.toLowerCase() === p.name.toLowerCase()
      ) {
        movedFrom.set(k, o);
        movedAway.add(g);
        break;
      }
    }
  }
  return { movedFrom, movedAway };
}

const ended = (event: string): boolean =>
  event === 'done' || event === 'blocked' || event === 'stopped';

/**
 * runEvents announces runs an agent reported: a run seen for the first time
 * started (or already ended), and a run that was going and now ended finished
 * or is blocked. The text is the step it worked on, the extra its result.
 */
export function runEvents(
  p: Plan,
  old: RunMark[],
  ts: string,
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const before = new Map(old.map((r) => [r.runId, r]));
  for (const r of [...(p.runs ?? [])].reverse()) {
    const was = before.get(r.runId);
    let kind = '';
    if (ended(r.event) && (!was || !ended(was.event)))
      kind = r.event === 'blocked' ? 'run-blocked' : 'run-finished';
    else if (!was && !ended(r.event)) kind = 'run-started';
    if (kind)
      out.push(event(p, ts, kind, r.step || 'Cả plan', r.result, r.agent));
  }
  return out;
}

/** diff returns the events between two snapshots, at time now, ordered by plan name. */
export function diff(
  old: PlanMap,
  cur: PlanMap,
  now: Date = new Date(),
): ActivityEvent[] {
  const ts = now.toISOString();
  const out: ActivityEvent[] = [];
  const add = (p: Plan, kind: string, text: string, extra = '') =>
    out.push(event(p, ts, kind, text, extra));
  const { movedFrom, movedAway } = movedPlans(old, cur);
  for (const [k, p] of Object.entries(cur)) {
    const from = movedFrom.get(k);
    if (from) {
      add(p, 'moved', 'Moved the plan file', from.file ?? '');
      continue;
    }
    const o = old[k];
    if (!o) {
      add(p, 'new', 'Mở plan mới', p.status);
      if (stage(p.status).toLowerCase() === 'waiting for owner')
        add(p, 'waiting', 'Cần bạn xử lý', p.status);
      for (const s of p.steps ?? [])
        if (s.status === 'blocked') add(p, 'blocked', s.text);
      for (const q of p.questions ?? []) if (q.open) add(p, 'question', q.ask);
      out.push(...runEvents(p, [], ts));
      continue;
    }
    if (o.runs) out.push(...runEvents(p, o.runs, ts));
    if (stage(o.status) !== stage(p.status)) {
      add(p, 'status', `${stage(o.status)} → ${stage(p.status)}`, p.status);
      if (p.status.toLowerCase().startsWith('waiting for owner'))
        add(p, 'waiting', 'Cần bạn xử lý', p.status);
    }
    const oldGroups = stepGroups(o);
    for (const [group, steps] of stepGroups(p)) {
      const before = oldGroups.get(group) ?? [];
      const matches = matchSteps(before, steps);
      steps.forEach((s, i) => {
        const was = matches[i]! >= 0 ? before[matches[i]!]!.status : '';
        if (was === s.status) return;
        if (
          s.status === 'done' ||
          s.status === 'blocked' ||
          s.status === 'partial'
        )
          add(p, s.status, s.text);
        else if (s.status === 'doing' && was !== '') add(p, 'doing', s.text);
      });
    }
    const seenDecisions = new Set((o.decisions ?? []).map((d) => d.text));
    for (const d of p.decisions ?? [])
      if (!seenDecisions.has(d.text)) add(p, 'decision', d.text, d.when);
    const oldQuestions = new Map((o.questions ?? []).map((q) => [q.ask, q]));
    for (const q of p.questions ?? []) {
      const was = oldQuestions.get(q.ask);
      if (!was) add(p, 'question', q.ask, q.answer);
      else if (was.open && !q.open) add(p, 'answer', q.ask, q.answer);
    }
    const oldDone = new Map((o.milestones ?? []).map((m) => [m.id, msDone(m)]));
    for (const m of p.milestones ?? [])
      if (msDone(m) && !oldDone.get(m.id))
        add(p, 'milestone', `${m.id}: ${m.title}`, m.summary);
  }
  for (const [k, o] of Object.entries(old)) {
    if (!(k in cur) && !movedAway.has(k))
      out.push(event(o, ts, 'closed', 'Đóng plan'));
  }
  return out
    .map((e, i) => [e, i] as const)
    .sort((a, b) =>
      a[0].plan < b[0].plan ? -1 : a[0].plan > b[0].plan ? 1 : a[1] - b[1],
    )
    .map(([e]) => e);
}

const ACTIVE_STAGES = new Set([
  'planning',
  'implementing',
  'reviewing',
  'fixing review',
  'testing',
]);

export function isStale(p: Plan, now: Date): boolean {
  const mtime = Date.parse(p.mtime);
  return (
    ACTIVE_STAGES.has(stage(p.status).toLowerCase()) &&
    !Number.isNaN(mtime) &&
    mtime > 0 &&
    now.getTime() - mtime >= STALE_AFTER_MS
  );
}

/**
 * staleEvents returns every new stale event and, of those, the ones to
 * announce: plans in quiet are recorded as seen but not announced. seen maps a
 * plan key to the mtime it was announced for; it is updated in place.
 */
export function staleEvents(
  cur: PlanMap,
  seen: Record<string, string>,
  now: Date,
  quiet: Set<string> = new Set(),
): { fresh: ActivityEvent[]; announce: ActivityEvent[] } {
  // Plans of a workspace not read now (disabled or disconnected) keep their
  // entry, so a returning workspace does not announce the same stale work again.
  const read = new Set(Object.values(cur).map((p) => p.project ?? ''));
  for (const k of Object.keys(seen)) {
    if (k in cur) continue;
    const slash = k.indexOf('/');
    const project = k.slice(0, slash);
    if (slash > 0 && k.indexOf('/', slash + 1) > 0 && !read.has(project))
      continue;
    delete seen[k];
  }
  const fresh: ActivityEvent[] = [];
  const announce: ActivityEvent[] = [];
  for (const [k, p] of Object.entries(cur)) {
    if (!isStale(p, now)) continue;
    const was = seen[k];
    if (was !== undefined && timeOf(was) === timeOf(p.mtime)) continue;
    seen[k] = p.mtime;
    const minutes = Math.floor((now.getTime() - Date.parse(p.mtime)) / 60000);
    const e = event(
      p,
      now.toISOString(),
      'stale',
      `Đứng im ${minutes} phút khi đang ${stage(p.status)}`,
      '',
      'Agent Ops',
    );
    fresh.push(e);
    if (!quiet.has(k)) announce.push(e);
  }
  return { fresh, announce };
}

/** eventKey identifies the plan of an event. */
export function eventKey(e: ActivityEvent): string {
  return e.project ? `${e.project}/${e.repo}/${e.plan}` : `${e.repo}/${e.plan}`;
}

/** withoutLogged drops seeded events the log already holds, so a lost snapshot or a returning workspace does not repeat history. */
export function withoutLogged(
  seeded: ActivityEvent[],
  logged: ActivityEvent[],
): ActivityEvent[] {
  if (seeded.length === 0) return seeded;
  const key = (e: ActivityEvent) =>
    `${timeOf(e.ts)}\0${eventKey(e)}\0${e.kind}\0${e.text}`;
  const have = new Set(logged.map(key));
  return seeded.filter((e) => !have.has(key(e)));
}
