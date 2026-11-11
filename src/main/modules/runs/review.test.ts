import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import {
  linkSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { put, tempDir } from '../../lib/safe-io/test-helpers';
import { runReport } from './report';
import { summarize } from './read';
import { parsePlan } from '../plans/overview';
import {
  appendRecord,
  MAX_LINE_BYTES,
  MAX_RUN_FILE_BYTES,
  parseRun,
  pruneRuns,
  readRun,
  runFile,
  withRunLock,
  type RunRecord,
} from './store';

const id = '00000000-0000-4000-8000-000000000001';
const at = '2020-01-01T00:00:00.000Z';
const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  v: 1,
  runId: id,
  at,
  event: 'start',
  agent: 'Codex',
  coordinator: 'Claude',
  role: 'executor',
  file: 'C:/tasks/ws/plan.md',
  revision: 'a'.repeat(64),
  step: null,
  result: '',
  ...over,
});
function setup() {
  const root = tempDir();
  const data = path.join(root, 'data');
  const tasks = path.join(root, 'Tasks tiếng Việt OneDrive');
  const plan = put(
    path.join(tasks, 'workspace', 'Long plan filename tiếng Việt.md'),
    '- [doing] Build it\n',
  );
  put(
    path.join(data, 'config.json'),
    JSON.stringify({ version: 1, tasksDir: tasks, projects: [] }),
  );
  const args = ['--agent', 'Codex', '--plan-file', plan, '--event', 'start'];
  return { root, data, plan, args };
}

describe('review: report boundaries', () => {
  it('serializes simultaneous recovery of one abandoned lock', async () => {
    const runs = tempDir();
    const lock = put(path.join(runs, `${id}.lock`), '2147483647');
    const { utimesSync } = await import('node:fs');
    utimesSync(lock, new Date(0), new Date(0));
    let deadChecks = 0;
    let bothDead!: () => void;
    const dead = new Promise<void>((resolve) => {
      bothDead = resolve;
    });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const kill = process.kill;
    const killMock = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) => {
        if (pid !== 2147483647) return kill(pid, signal);
        if (++deadChecks === 2) bothDead();
        throw Object.assign(new Error('dead'), { code: 'ESRCH' });
      });
    const remove = fs.rm;
    let removals = 0;
    const rmMock = vi.spyOn(fs, 'rm').mockImplementation(async (file, opts) => {
      if (file === lock) {
        if (++removals === 1) await dead;
        else if (removals === 2) await firstEntered;
      }
      return remove(file, opts);
    });
    let writers = 0;
    let peak = 0;
    const work = async () => {
      peak = Math.max(peak, ++writers);
      entered();
      await new Promise((resolve) => setTimeout(resolve, 60));
      writers--;
    };
    try {
      await Promise.all([
        withRunLock(runs, id, work),
        withRunLock(runs, id, work),
      ]);
      expect(peak).toBe(1);
    } finally {
      killMock.mockRestore();
      rmMock.mockRestore();
    }
  });
  it('fails promptly when an existing lock cannot be inspected', async () => {
    const runs = tempDir();
    const lock = put(path.join(runs, `${id}.lock`), '1');
    const open = fs.open;
    const mock = vi
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[0] === lock && args[1] === 'r')
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return open(...args);
      });
    try {
      await expect(
        withRunLock(runs, id, async () => 'wrong', 5),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      mock.mockRestore();
    }
  });
  it('serializes competing terminal reports so only one ends the run', async () => {
    const s = setup();
    const start = await runReport(s.args, { dataDir: s.data });
    expect(start.code).toBe(0);
    const runId = start.stdout.trim();
    const args = [
      '--agent',
      'Codex',
      '--plan-file',
      s.plan,
      '--run-id',
      runId,
      '--event',
      'done',
      '--result',
      'tests pass',
    ];
    const outs = await Promise.all([
      runReport(args, { dataDir: s.data }),
      runReport(args, { dataDir: s.data }),
    ]);
    expect(outs.map((o) => o.code).sort()).toEqual([0, 1]);
    expect(
      (await readRun(path.join(s.data, 'runs'), runId)).records.map(
        (r) => r.event,
      ),
    ).toEqual(['start', 'done']);
  });
  it('keeps the recorded step when a continuation has a new revision but the original step was reworded', () => {
    const plan = parsePlan(
      '## M1: Work\n- [todo] Unrelated new step\n- [doing] Reworded work\n',
    );
    const step = { line: 2, text: 'Original work', milestone: 'M1', index: 0 };
    const run = summarize(
      [
        record({ step }),
        record({
          event: 'done',
          result: 'tests pass',
          step,
          revision: plan.revision,
        }),
      ],
      plan,
      new Date(),
    );
    expect(run.step).toEqual({
      line: 2,
      text: 'Original work',
      milestone: 'M1',
    });
    expect(plan.steps[0]!.text).toBe('Unrelated new step');
  });
  it('rejects an unreadable oversized record and preserves the existing file at the byte limit', async () => {
    const s = setup();
    writeFileSync(s.plan, '- [doing] ' + 'x'.repeat(MAX_LINE_BYTES) + '\n');
    const outcome = await runReport([...s.args, '--step-line', '1'], {
      dataDir: s.data,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('too large');
    const runs = tempDir();
    await appendRecord(runs, record());
    const file = runFile(runs, id);
    truncateSync(file, MAX_RUN_FILE_BYTES - 10);
    const before = readFileSync(file);
    await expect(
      appendRecord(runs, record({ event: 'progress', result: 'evidence' })),
    ).rejects.toThrow('too many reports');
    expect(readFileSync(file)).toEqual(before);
  });

  it('bounds an oversized file before reading it', async () => {
    const runs = tempDir();
    const file = put(runFile(runs, id), '');
    truncateSync(file, MAX_RUN_FILE_BYTES * 1000);
    expect(await readRun(runs, id)).toEqual({
      records: [],
      skipped: 1,
      bytes: statSync(file).size,
    });
  });

  it('rejects control characters and keeps error output to one bounded line', async () => {
    const s = setup();
    for (const value of ['bad\u001b[2J', 'bad\0text']) {
      const out = await runReport([...s.args, '--result', value], {
        dataDir: s.data,
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain('control characters');
    }
    const out = await runReport(['bad\nFORGED\u001b' + 'x'.repeat(5000)], {
      dataDir: s.data,
    });
    expect(out.stderr.trim().split('\n')).toHaveLength(1);
    expect(out.stderr.length).toBeLessThan(1100);
    expect(out.stderr).not.toContain('\u001b');
  });

  it('does not let a corrupt terminal line end a run or change its owner metadata', () => {
    for (const over of [
      { event: 'done' as const, result: '' },
      { event: 'progress' as const, coordinator: 'Gemini' },
      { event: 'progress' as const, role: 'coordinator' as const },
      { event: 'progress' as const, revision: 'bad' },
      { event: 'progress' as const, result: '\u001b' },
      { event: 'progress' as const, result: 'x'.repeat(4001) },
      {
        event: 'progress' as const,
        step: { line: 1, text: 'Another step', milestone: '', index: 0 },
      },
    ]) {
      const out = parseRun(
        id,
        [
          record(),
          record(over),
          record({ event: 'done', result: 'tests pass' }),
        ]
          .map((r) => JSON.stringify(r))
          .join('\n'),
      );
      expect(out.skipped).toBe(1);
      expect(out.records.map((r) => r.event)).toEqual(['start', 'done']);
    }
  });

  it('refuses hard-linked report files rather than appending to another location', async () => {
    const runs = tempDir();
    const external = put(
      path.join(tempDir(), 'other.jsonl'),
      JSON.stringify(record()) + '\n',
    );
    linkSync(external, runFile(runs, id));
    await expect(
      appendRecord(runs, record({ event: 'progress' })),
    ).rejects.toThrow('without links');
    expect(readFileSync(external, 'utf8')).toBe(
      JSON.stringify(record()) + '\n',
    );
  });

  it('rejects a redirected runs folder before reporting or pruning outside it', async () => {
    const s = setup();
    const external = tempDir();
    const file = put(
      runFile(external, id),
      [record(), record({ event: 'done', result: 'old' })]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    symlinkSync(
      external,
      path.join(s.data, 'runs'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      pruneRuns(path.join(s.data, 'runs'), new Date()),
    ).rejects.toThrow('not a link');
    expect((await runReport(s.args, { dataDir: s.data })).code).toBe(1);
    expect(readFileSync(file, 'utf8')).toContain('old');
  });

  it('does not steal or prune an old lock held by a living reporter', async () => {
    const runs = tempDir();
    const lock = put(path.join(runs, `${id}.lock`), String(process.pid));
    const { utimesSync } = await import('node:fs');
    utimesSync(lock, new Date(0), new Date(0));
    await expect(
      withRunLock(runs, id, async () => 'stolen', 5),
    ).rejects.toThrow('being written');
    expect(await pruneRuns(runs, new Date())).toBe(0);
    expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts an 8.3 plan filename and keeps the long Unicode path',
    async () => {
      const s = setup();
      const short = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${s.plan.replace(/'/g, "''")}').ShortPath`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      expect(short).not.toBe('');
      const out = await runReport(
        ['--agent', 'Codex', '--plan-file', short, '--event', 'start'],
        { dataDir: s.data },
      );
      expect(out.stderr).toBe('');
      const run = await readRun(path.join(s.data, 'runs'), out.stdout.trim());
      expect(run.records[0]!.file.toLowerCase()).toBe(
        s.plan.replace(/\\/g, '/').toLowerCase(),
      );
    },
    15_000,
  );
});
