import {
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { put, tempDir } from '../../lib/safe-io/test-helpers';
import { collectOverview } from '../plans/collect';
import { slash } from '../plans/io';
import { ACTIVE_FOR_MS, MAX_RUNS_PER_PLAN } from './read';
import {
  PRUNE_AFTER_MS,
  appendRecord,
  parseRun,
  pruneRuns,
  runFile,
  type RunRecord,
} from './store';
import { syncReportPointers } from './pointers';
import type { UserEnvironment } from '../tasks';

const NOW = new Date('2026-11-11T12:00:00Z');
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    v: 1,
    runId: id(1),
    at: new Date(NOW.getTime() - 60_000).toISOString(),
    event: 'start',
    agent: 'Codex',
    coordinator: 'Claude',
    role: 'executor',
    file: 'C:/x/plan.md',
    revision: 'a'.repeat(64),
    step: null,
    result: '',
    ...over,
  };
}
const lines = (...records: RunRecord[]) =>
  records.map((r) => JSON.stringify(r) + '\n').join('');

describe('run records', () => {
  it('skips cut, foreign, late and repeated lines and counts them', () => {
    const start = record();
    const text =
      lines(start, record({ event: 'progress', result: 'a' })) +
      '{"v":1,"runId":"cut\n' +
      lines(
        record({ runId: id(2), event: 'progress' }),
        record({ agent: 'Claude', event: 'progress' }),
        record({ file: 'C:/X/PLAN.md', event: 'done', result: 'ok' }),
        record({ event: 'progress' }),
        record({ event: 'start' }),
      );
    const run = parseRun(id(1), text);
    expect(run.records.map((r) => r.event)).toEqual([
      'start',
      'progress',
      'done',
    ]);
    expect(run.skipped).toBe(5);
    expect(parseRun(id(1), lines(record({ event: 'progress' })))).toEqual({
      records: [],
      skipped: 1,
    });
  });
  it('starts an append after a cut line on a new line', async () => {
    const dir = tempDir();
    writeFileSync(runFile(dir, id(1)), lines(record()) + '{"cut');
    await appendRecord(dir, record({ event: 'progress' }));
    const run = parseRun(id(1), readFileSync(runFile(dir, id(1)), 'utf8'));
    expect(run.records).toHaveLength(2);
    expect(run.skipped).toBe(1);
  });
});

describe('reading runs with plans', () => {
  function setup() {
    const root = tempDir();
    const tasks = path.join(root, 'tasks');
    const runs = path.join(root, 'runs');
    const file = put(
      path.join(tasks, 'ws', 'plan.md'),
      'Agent: Claude\n## M1: A\n- [todo] New step\n- [doing] Build it <!-- Executor: Codex -->\n',
    );
    put(path.join(tasks, 'ws', 'other.md'), '- [todo] x\n');
    return { tasks, runs, file: slash(file) };
  }
  const collect = (s: ReturnType<typeof setup>, now = NOW) =>
    collectOverview(
      { tasksDir: s.tasks, runsDir: s.runs },
      { now: () => now, git: async () => '' },
    );
  const write = (dir: string, ...records: RunRecord[]) =>
    put(runFile(dir, records[0]!.runId), lines(...records));

  it('attaches the latest state of each run, newest first, matched by file case-insensitively', async () => {
    const s = setup();
    const at = (minutes: number) =>
      new Date(NOW.getTime() - minutes * 60_000).toISOString();
    write(
      s.runs,
      record({
        runId: id(1),
        file: s.file.toUpperCase(),
        at: at(30),
        step: { line: 2, text: 'Build it', milestone: 'M1', index: 0 },
      }),
      record({
        runId: id(1),
        file: s.file,
        at: at(20),
        event: 'progress',
        result: 'Nửa đường',
      }),
    );
    write(
      s.runs,
      record({
        runId: id(2),
        file: s.file,
        at: at(90),
        agent: 'Claude',
        coordinator: 'Claude',
        role: 'coordinator',
      }),
      record({
        runId: id(2),
        file: s.file,
        at: at(10),
        agent: 'Claude',
        coordinator: 'Claude',
        role: 'coordinator',
        event: 'done',
        result: 'Xong, PR #12',
      }),
      record({
        runId: id(2),
        file: s.file,
        at: at(5),
        agent: 'Claude',
        event: 'progress',
      }),
    );
    write(s.runs, record({ runId: id(3), file: 'C:/elsewhere/plan.md' }));
    const out = await collect(s);
    const plan = out.plans.find((p) => p.name === 'plan')!;
    expect(plan.agent).toBe('Claude');
    expect(plan.steps.map((s) => s.executors)).toEqual([undefined, ['Codex']]);
    expect(plan.runs).toEqual([
      {
        runId: id(2),
        agent: 'Claude',
        coordinator: 'Claude',
        role: 'coordinator',
        event: 'done',
        active: false,
        startedAt: at(90),
        updatedAt: at(10),
        step: null,
        result: 'Xong, PR #12',
      },
      {
        runId: id(1),
        agent: 'Codex',
        coordinator: 'Claude',
        role: 'executor',
        event: 'progress',
        active: true,
        startedAt: at(30),
        updatedAt: at(20),
        // The step moved from line 2 to line 4; the run follows it by text.
        step: { line: 4, text: 'Build it', milestone: 'M1' },
        result: 'Nửa đường',
      },
    ]);
    expect(out.plans.find((p) => p.name === 'other')!.runs).toBeUndefined();
    expect(out.diagnostics.map((d) => [d.plan, d.kind, d.message])).toEqual([
      [
        'plan',
        'unreadable',
        '1 agent report line for this plan could not be read and was skipped.',
      ],
    ]);
  });
  it('counts a run as working now for 12 hours after its last start or progress', async () => {
    const s = setup();
    write(s.runs, record({ file: s.file, at: NOW.toISOString() }));
    const active = async (ms: number) =>
      (await collect(s, new Date(NOW.getTime() + ms))).plans.find(
        (p) => p.name === 'plan',
      )!.runs![0]!.active;
    expect(await active(ACTIVE_FOR_MS)).toBe(true);
    expect(await active(ACTIVE_FOR_MS + 1)).toBe(false);
  });
  it('keeps the latest 50 runs of a plan', async () => {
    const s = setup();
    for (let n = 1; n <= MAX_RUNS_PER_PLAN + 5; n++)
      write(
        s.runs,
        record({
          runId: id(n),
          file: s.file,
          at: new Date(NOW.getTime() - n * 1000).toISOString(),
        }),
      );
    const runs = (await collect(s)).plans.find((p) => p.name === 'plan')!.runs!;
    expect(runs).toHaveLength(MAX_RUNS_PER_PLAN);
    expect(runs[0]!.runId).toBe(id(1));
    expect(runs.at(-1)!.runId).toBe(id(MAX_RUNS_PER_PLAN));
  });
  it('reports unreadable run files once and reads plans without a runs folder', async () => {
    const s = setup();
    put(runFile(s.runs, id(7)), 'not json\n');
    put(path.join(s.runs, 'notes.txt'), 'ignored');
    const out = await collect(s);
    expect(out.diagnostics.map((d) => d.message)).toEqual([
      '1 agent report file could not be read and was skipped.',
    ]);
    const bare = setup();
    const plain = await collect(bare);
    expect(plain.plans.every((p) => p.runs === undefined)).toBe(true);
    expect(plain.diagnostics).toEqual([]);
  });
});

describe('pruning', () => {
  it('removes runs that ended over 90 days ago and old locks, and keeps the rest', async () => {
    const dir = tempDir();
    const old = new Date(NOW.getTime() - PRUNE_AFTER_MS - 1000).toISOString();
    const recent = new Date(NOW.getTime() - 1000).toISOString();
    const write = (...records: RunRecord[]) =>
      put(runFile(dir, records[0]!.runId), lines(...records));
    write(
      record({ runId: id(1), at: old }),
      record({ runId: id(1), at: old, event: 'done', result: 'x' }),
    );
    write(record({ runId: id(2), at: old }));
    write(
      record({ runId: id(3), at: old }),
      record({ runId: id(3), at: recent, event: 'blocked', result: 'x' }),
    );
    const broken = put(runFile(dir, id(4)), 'junk');
    const fresh = put(runFile(dir, id(5)), 'junk');
    const past = new Date(NOW.getTime() - PRUNE_AFTER_MS - 1000);
    utimesSync(broken, past, past);
    const lock = put(path.join(dir, `${id(2)}.lock`), '1');
    utimesSync(lock, past, past);
    const held = put(path.join(dir, `${id(3)}.lock`), '1');
    utimesSync(held, NOW, NOW);
    expect(await pruneRuns(dir, NOW)).toBe(3);
    expect(readdirSync(dir).sort()).toEqual(
      [
        `${id(2)}.jsonl`,
        `${id(3)}.jsonl`,
        `${id(3)}.lock`,
        `${id(5)}.jsonl`,
      ].sort(),
    );
    expect(existsSync(fresh)).toBe(true);
    expect(await pruneRuns(path.join(dir, 'missing'), NOW)).toBe(0);
  });
});

describe('report command pointers', () => {
  function fakeEnv(initial?: string) {
    const calls: string[] = [];
    let value = initial;
    const env: UserEnvironment = {
      get: async (name) => {
        calls.push(`get ${name}`);
        return value;
      },
      set: async (name, v) => {
        calls.push(`set ${name}`);
        value = v;
      },
      delete: async () => {
        calls.push('delete');
      },
      broadcast: () => calls.push('broadcast'),
    };
    return { env, calls, value: () => value };
  }
  it('writes report-command.txt and the variable only when they change', async () => {
    const dir = tempDir();
    const exe =
      'C:\\Users\\Lan\\AppData\\Local\\Programs\\AgentOps\\agent-ops.exe';
    const fake = fakeEnv();
    expect(
      await syncReportPointers(exe, { dataDir: dir, env: fake.env }),
    ).toEqual([]);
    expect(readFileSync(path.join(dir, 'report-command.txt'), 'utf8')).toBe(
      exe + '\n',
    );
    expect(fake.calls).toEqual([
      'get AGENT_OPS_REPORT',
      'set AGENT_OPS_REPORT',
      'broadcast',
    ]);
    const mtime = 1_000_000;
    utimesSync(path.join(dir, 'report-command.txt'), mtime, mtime);
    fake.calls.length = 0;
    await syncReportPointers(exe, { dataDir: dir, env: fake.env });
    expect(fake.calls).toEqual(['get AGENT_OPS_REPORT']);
    expect(
      Math.round(
        (await import('node:fs')).statSync(path.join(dir, 'report-command.txt'))
          .mtimeMs / 1000,
      ),
    ).toBe(mtime);
  });
  it('without a writer leaves the environment alone and reports failures', async () => {
    const dir = tempDir();
    const problems = await syncReportPointers('C:\\a.exe', {
      dataDir: path.join(dir, 'missing', '\0bad'),
      env: {
        get: async () => {
          throw new Error('denied');
        },
        set: async () => {},
        delete: async () => {},
        broadcast: () => {},
      },
    });
    expect(problems).toHaveLength(2);
    expect(problems[1]).toMatch(/^AGENT_OPS_REPORT: denied/);
    expect(await syncReportPointers('C:\\a.exe', { dataDir: dir })).toEqual([]);
  });
});
