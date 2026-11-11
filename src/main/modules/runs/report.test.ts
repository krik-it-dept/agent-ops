import {
  readFileSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { put, tempDir } from '../../lib/safe-io/test-helpers';
import { slash } from '../plans/io';
import { parseReportArgs, runReport } from './report';
import { readRun, runFile } from './store';

const PLAN = [
  'Agent: Claude',
  'Status: Implementing',
  '## M1: Build',
  '- [doing] Write the reader',
  '- [todo] Write the docs',
  'Not a step',
  '',
].join('\n');

interface Setup {
  data: string;
  tasks: string;
  plan: string;
  legacy: string;
  disabled: string;
}
function setup(plan = PLAN): Setup {
  const root = tempDir();
  const data = path.join(root, 'data');
  const tasks = path.join(root, 'tasks');
  const work = path.join(root, 'work');
  const off = path.join(root, 'off');
  const file = put(path.join(tasks, 'ws', 'plan.md'), plan);
  put(path.join(work, '.git'), 'gitdir: x');
  const legacy = put(path.join(work, '.tasks', 'old.md'), plan);
  put(path.join(off, '.git'), 'gitdir: x');
  const disabled = put(path.join(off, '.tasks', 'old.md'), plan);
  put(
    path.join(data, 'config.json'),
    JSON.stringify({
      version: 1,
      tasksDir: tasks,
      projects: [
        { id: 'work', name: 'Work', path: work, kind: 'repo', enabled: true },
        { id: 'off', name: 'Off', path: off, kind: 'repo', enabled: false },
      ],
    }),
  );
  return { data, tasks, plan: file, legacy, disabled };
}
let clock = Date.parse('2026-11-11T03:00:00Z');
const report = (s: Setup, ...args: string[]) =>
  runReport(args, {
    dataDir: s.data,
    now: () => new Date((clock += 1000)),
  });
async function start(s: Setup, ...args: string[]): Promise<string> {
  const out = await report(
    s,
    '--agent',
    'Codex',
    '--plan-file',
    s.plan,
    '--event',
    'start',
    ...args,
  );
  expect(out.stderr).toBe('');
  expect(out.code).toBe(0);
  return out.stdout.trim();
}
const runsDir = (s: Setup) => path.join(s.data, 'runs');
const records = async (s: Setup, id: string) =>
  (await readRun(runsDir(s), id)).records;

describe('report arguments', () => {
  it('reads pairs and = values, and refuses unknown, repeated or missing options', () => {
    expect(
      parseReportArgs([
        '--agent',
        'Codex',
        '--result=--5 tests',
        '--event=done',
      ]),
    ).toEqual({ agent: 'Codex', result: '--5 tests', event: 'done' });
    expect(() => parseReportArgs(['--agnt', 'x'])).toThrow(/Unknown option/);
    expect(() => parseReportArgs(['--agent', 'a', '--agent', 'b'])).toThrow(
      /twice/,
    );
    expect(() => parseReportArgs(['--result', '--event', 'x'])).toThrow(
      /needs a value/,
    );
    expect(() => parseReportArgs(['stray'])).toThrow(/Unexpected value/);
  });
});

describe('report command', () => {
  it('starts, progresses and finishes a run without touching the plan', async () => {
    const s = setup();
    const before = readFileSync(s.plan);
    const id = await start(s, '--step-line', '4');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    const progress = await report(
      s,
      '--agent',
      'codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id.toUpperCase(),
      '--event',
      'progress',
      '--result',
      'Đã viết xong phần đọc',
    );
    expect(progress).toEqual({ code: 0, stdout: 'ok\n', stderr: '' });
    const done = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id,
      '--event',
      'done',
      '--result',
      '  12 tests pass, commit abc123  ',
    );
    expect(done.code).toBe(0);
    const recs = await records(s, id);
    expect(recs.map((r) => [r.event, r.agent, r.coordinator, r.role])).toEqual([
      ['start', 'Codex', 'Claude', 'executor'],
      ['progress', 'Codex', 'Claude', 'executor'],
      ['done', 'Codex', 'Claude', 'executor'],
    ]);
    expect(recs[2]!.result).toBe('12 tests pass, commit abc123');
    expect(recs[0]!.step).toEqual({
      line: 4,
      text: 'Write the reader',
      milestone: 'M1',
      index: 0,
    });
    expect(recs[2]!.step).toEqual(recs[0]!.step);
    // Records keep the long real path, also when the temp folder is an 8.3 name.
    expect(recs[0]!.file).toBe(slash(realpathSync.native(s.plan)));
    expect(recs[0]!.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(s.plan)).toEqual(before);
    expect(readdirSync(path.dirname(s.plan))).toEqual(['plan.md']);
    expect(readdirSync(runsDir(s))).toEqual([`${id}.jsonl`]);
  });
  it('chooses coordinator and role from the options and the plan Agent line', async () => {
    const s = setup();
    const role = async (...args: string[]) => {
      const out = await report(
        s,
        '--plan-file',
        s.plan,
        '--event',
        'start',
        ...args,
      );
      expect(out.stderr).toBe('');
      const [r] = await records(s, out.stdout.trim());
      return [r!.agent, r!.coordinator, r!.role];
    };
    expect(await role('--agent', 'Claude')).toEqual([
      'Claude',
      'Claude',
      'coordinator',
    ]);
    expect(await role('--agent', 'Codex')).toEqual([
      'Codex',
      'Claude',
      'executor',
    ]);
    expect(await role('--agent', 'anti', '--coordinator', 'codex')).toEqual([
      'Antigravity',
      'Codex',
      'executor',
    ]);
    expect(await role('--agent', 'Codex', '--role', 'coordinator')).toEqual([
      'Codex',
      'Codex',
      'coordinator',
    ]);
    const bare = setup(PLAN.replace('Agent: Claude\n', ''));
    const out = await report(
      bare,
      '--agent',
      'Orca worker 1',
      '--plan-file',
      bare.plan,
      '--event',
      'start',
    );
    const [r] = await records(bare, out.stdout.trim());
    expect([r!.agent, r!.coordinator, r!.role, r!.step]).toEqual([
      'Orca worker 1',
      'Orca worker 1',
      'coordinator',
      null,
    ]);
    const executor = await report(
      bare,
      '--agent',
      'Codex',
      '--role',
      'executor',
      '--plan-file',
      bare.plan,
      '--event',
      'start',
    );
    const [e] = await records(bare, executor.stdout.trim());
    expect([e!.coordinator, e!.role]).toEqual(['', 'executor']);
  });
  it('accepts a configured workspace plan folder and a path in another case', async () => {
    const s = setup();
    const out = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.legacy,
      '--event',
      'start',
    );
    expect(out.code).toBe(0);
    const upper = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan.toUpperCase(),
      '--event',
      'start',
    );
    expect(upper.stderr).toBe('');
    const [r] = await records(s, upper.stdout.trim());
    expect(r!.file).toBe(slash(realpathSync.native(s.plan)));
  });
  it.each<[string, (s: Setup) => string[], RegExp]>([
    [
      'an unknown event',
      (s) => ['--agent', 'Codex', '--plan-file', s.plan, '--event', 'finish'],
      /--event must be/,
    ],
    [
      'no agent',
      (s) => ['--plan-file', s.plan, '--event', 'start'],
      /Name the agent/,
    ],
    [
      'agent none',
      (s) => ['--agent', 'none', '--plan-file', s.plan, '--event', 'start'],
      /Name the agent/,
    ],
    [
      'an invalid agent',
      (s) => [
        '--agent',
        'Codex (GPT)',
        '--plan-file',
        s.plan,
        '--event',
        'start',
      ],
      /plain name/,
    ],
    [
      'an invalid coordinator',
      (s) => [
        '--agent',
        'Codex',
        '--coordinator',
        'a/b',
        '--plan-file',
        s.plan,
        '--event',
        'start',
      ],
      /--coordinator must/,
    ],
    [
      'an invalid role',
      (s) => [
        '--agent',
        'Codex',
        '--role',
        'owner',
        '--plan-file',
        s.plan,
        '--event',
        'start',
      ],
      /--role must/,
    ],
    [
      'a relative plan path',
      () => [
        '--agent',
        'Codex',
        '--plan-file',
        'ws/plan.md',
        '--event',
        'start',
      ],
      /full path/,
    ],
    [
      'a plan outside the plan folders',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        put(path.join(s.data, '..', 'elsewhere', 'plan.md'), PLAN),
        '--event',
        'start',
      ],
      /not in the Tasks folder/,
    ],
    [
      'a plan of a disabled workspace',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.disabled,
        '--event',
        'start',
      ],
      /not in the Tasks folder/,
    ],
    [
      'a missing plan',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        path.join(s.tasks, 'ws', 'nope.md'),
        '--event',
        'start',
      ],
      /not in the Tasks folder/,
    ],
    [
      'a file that is not a plan',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        put(path.join(s.tasks, 'ws', 'notes.txt'), 'x'),
        '--event',
        'start',
      ],
      /\.md file/,
    ],
    [
      'a line that is not a step',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'start',
        '--step-line',
        '6',
      ],
      /not a checklist step/,
    ],
    [
      'a bad step line',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'start',
        '--step-line',
        '4.5',
      ],
      /--step-line must/,
    ],
    [
      'a stale revision',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'start',
        '--revision',
        'a'.repeat(64),
      ],
      /plan changed/,
    ],
    [
      'done without a result',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'done',
        '--run-id',
        '00000000-0000-4000-8000-000000000000',
        '--result',
        '  ',
      ],
      /needs --result/,
    ],
    [
      'a result over 4000 characters',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'start',
        '--result',
        'é'.repeat(4001),
      ],
      /longer than 4000/,
    ],
    [
      'progress without a run ID',
      (s) => ['--agent', 'Codex', '--plan-file', s.plan, '--event', 'progress'],
      /needs --run-id/,
    ],
    [
      'a malformed run ID',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'progress',
        '--run-id',
        '../x',
      ],
      /--run-id must/,
    ],
    [
      'an unknown run',
      (s) => [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--event',
        'progress',
        '--run-id',
        '00000000-0000-4000-8000-000000000000',
      ],
      /is unknown/,
    ],
  ])(
    'refuses %s with a plain message and exit code 1',
    async (_name, args, message) => {
      const s = setup();
      const out = await report(s, ...args(s));
      expect(out.code).toBe(1);
      expect(out.stdout).toBe('');
      expect(out.stderr).toMatch(/^Agent Ops report: /);
      expect(out.stderr).toMatch(message);
      expect(out.stderr.trim().split('\n')).toHaveLength(1);
    },
  );
  it('accepts exactly 4000 characters', async () => {
    const s = setup();
    await start(s, '--result', 'é'.repeat(4000));
  });
  it('lets only the same agent continue, with the same coordinator, role, plan and step', async () => {
    const s = setup();
    const id = await start(s, '--step-line', '4');
    const next = (...args: string[]) =>
      report(
        s,
        '--plan-file',
        s.plan,
        '--run-id',
        id,
        '--event',
        'progress',
        ...args,
      );
    expect((await next('--agent', 'Claude')).stderr).toMatch(
      /belongs to Codex/,
    );
    expect(
      (await next('--agent', 'Codex', '--coordinator', 'Gemini')).stderr,
    ).toMatch(/coordinated by Claude/);
    expect(
      (await next('--agent', 'Codex', '--coordinator', 'claude')).code,
    ).toBe(0);
    expect(
      (await next('--agent', 'Codex', '--role', 'coordinator')).stderr,
    ).toMatch(/--role must match/);
    expect((await next('--agent', 'Codex', '--step-line', '5')).stderr).toMatch(
      /another step/,
    );
    expect((await next('--agent', 'Codex', '--step-line', '4')).code).toBe(0);
    const other = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.legacy,
      '--run-id',
      id,
      '--event',
      'progress',
    );
    expect(other.stderr).toMatch(/another plan file/);
    const again = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id,
      '--event',
      'start',
    );
    expect(again.stderr).toMatch(/already exists/);
  });
  it('accepts no event after done, blocked or stopped', async () => {
    for (const end of ['done', 'blocked', 'stopped']) {
      const s = setup();
      const id = await start(s);
      const finish = await report(
        s,
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--run-id',
        id,
        '--event',
        end,
        '--result',
        'Lý do',
      );
      expect(finish.code).toBe(0);
      for (const event of ['progress', 'done']) {
        const late = await report(
          s,
          '--agent',
          'Codex',
          '--plan-file',
          s.plan,
          '--run-id',
          id,
          '--event',
          event,
          '--result',
          'x',
        );
        expect(late.stderr).toMatch(new RegExp(`already ended \\(${end}\\)`));
      }
    }
  });
  it('follows the step when the plan moves its lines', async () => {
    const s = setup();
    const id = await start(s, '--step-line', '5');
    writeFileSync(
      s.plan,
      PLAN.replace('## M1: Build\n', '## M1: Build\n- [todo] New first step\n'),
    );
    const out = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id,
      '--event',
      'progress',
    );
    expect(out.code).toBe(0);
    const recs = await records(s, id);
    expect(recs.map((r) => r.step?.line)).toEqual([5, 6]);
    expect(recs[1]!.step?.text).toBe('Write the docs');
    expect(recs[1]!.revision).not.toBe(recs[0]!.revision);
  });
  it('serialises reports for one run and takes over a lock left by a crash', async () => {
    const s = setup();
    const id = await start(s);
    const outs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        report(
          s,
          '--agent',
          'Codex',
          '--plan-file',
          s.plan,
          '--run-id',
          id,
          '--event',
          'progress',
          '--result',
          `step ${i}`,
        ),
      ),
    );
    expect(outs.map((o) => o.code)).toEqual([0, 0, 0, 0, 0, 0]);
    const recs = await records(s, id);
    expect(recs).toHaveLength(7);
    expect(new Set(recs.map((r) => r.result)).size).toBe(7);
    for (let i = 1; i < recs.length; i++)
      expect(Date.parse(recs[i]!.at)).toBeGreaterThan(
        Date.parse(recs[i - 1]!.at),
      );
    const lock = path.join(runsDir(s), `${id}.lock`);
    writeFileSync(lock, '1');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const after = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id,
      '--event',
      'progress',
    );
    expect(after.code).toBe(0);
    expect(readdirSync(runsDir(s))).toEqual([`${id}.jsonl`]);
  });
  it('refuses while another report holds a fresh lock', async () => {
    const s = setup();
    const id = await start(s);
    writeFileSync(path.join(runsDir(s), `${id}.lock`), '1');
    const out = await runReport(
      [
        '--agent',
        'Codex',
        '--plan-file',
        s.plan,
        '--run-id',
        id,
        '--event',
        'progress',
      ],
      { dataDir: s.data },
    );
    expect(out.stderr).toMatch(/being written/);
  }, 10_000);
  it('stops a run that grew too large', async () => {
    const s = setup();
    const id = await start(s);
    const file = runFile(runsDir(s), id);
    const line = readFileSync(file, 'utf8').replace('"start"', '"progress"');
    writeFileSync(file, readFileSync(file, 'utf8') + line.repeat(499));
    const out = await report(
      s,
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      id,
      '--event',
      'progress',
    );
    expect(out.stderr).toMatch(/too many reports/);
  });
  it('explains missing, unreadable and newer settings', async () => {
    const s = setup();
    const args = [
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--event',
      'start',
    ];
    writeFileSync(path.join(s.data, 'config.json'), '{bad');
    expect((await runReport(args, { dataDir: s.data })).stderr).toMatch(
      /cannot be read/,
    );
    writeFileSync(
      path.join(s.data, 'config.json'),
      '{"version":99,"projects":[]}',
    );
    expect((await runReport(args, { dataDir: s.data })).stderr).toMatch(
      /newer version/,
    );
    const empty = tempDir();
    expect((await runReport(args, { dataDir: empty })).stderr).toMatch(
      /not set up/,
    );
    expect(readdirSync(empty)).toEqual([]);
  });
});
