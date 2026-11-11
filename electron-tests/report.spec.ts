import { _electron as electron, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const executable = createRequire(resolve('package.json'))('electron') as string;

/** Runs the built app in report mode with piped output, as an AI tool runs a command. */
function report(env: Record<string, string | undefined>, args: string[]) {
  return new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    ms: number;
  }>((done, reject) => {
    const began = Date.now();
    const child = spawn(executable, [resolve('.'), '--report', ...args], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on(
      'data',
      (data: Buffer) => (stdout += data.toString('utf8')),
    );
    child.stderr.on(
      'data',
      (data: Buffer) => (stderr += data.toString('utf8')),
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The report command did not exit.'));
    }, 15_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, ms: Date.now() - began });
    });
  });
}
const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? '';

test('report command records a run while the app runs, prints to pipes and the window updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-report-e2e-'));
  const data = join(root, 'data');
  const tasks = join(root, 'tasks');
  const plan = join(tasks, 'ws', 'plan.md');
  await mkdir(join(tasks, 'ws'), { recursive: true });
  await mkdir(data);
  const planText =
    'Agent: Claude\nStatus: Implementing\n## M1: Build\n- [doing] Đọc báo cáo của agent <!-- Executors: Codex -->\n';
  await writeFile(plan, planText);
  await writeFile(
    join(data, 'config.json'),
    JSON.stringify({
      version: 1,
      setupComplete: true,
      tasksDir: tasks,
      projects: [],
    }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENT_OPS_DATA_DIR: data,
    AGENT_OPS_UI_FIXTURES: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const app = await electron.launch({
    args: [resolve('.')],
    env: Object.fromEntries(
      Object.entries(env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    await page.locator('.app').waitFor();
    const plans = () =>
      page.evaluate(async () => {
        const result = await window.agentOps.state.get({});
        return result.ok ? result.value.state.plans : [];
      });
    await expect.poll(async () => (await plans()).length).toBe(1);
    expect((await plans())[0]).toMatchObject({ agent: 'Claude' });

    const started = await report(env, [
      '--agent',
      'codex',
      '--plan-file',
      plan,
      '--step-line',
      '4',
      '--event',
      'start',
    ]);
    expect(started.stderr).toBe('');
    expect(started.code).toBe(0);
    const runId = lastLine(started.stdout);
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(started.ms).toBeLessThan(10_000);
    // The running window picks the report up through the watcher, without F5.
    await expect
      .poll(async () => (await plans())[0]?.runs?.[0], { timeout: 10_000 })
      .toMatchObject({
        runId,
        agent: 'Codex',
        coordinator: 'Claude',
        role: 'executor',
        event: 'start',
        active: true,
        step: { line: 4, text: 'Đọc báo cáo của agent', milestone: 'M1' },
      });

    const refused = await report(env, [
      '--agent',
      'Claude',
      '--plan-file',
      plan,
      '--run-id',
      runId,
      '--event',
      'progress',
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stdout.trim()).toBe('');
    expect(refused.stderr.trim()).toBe(
      `Agent Ops report: Run ${runId} belongs to Codex; only that agent can continue it.`,
    );

    const done = await report(env, [
      '--agent',
      'Codex',
      '--plan-file',
      plan,
      '--run-id',
      runId,
      '--event',
      'done',
      '--result',
      'Đã xong: 12 bài kiểm thử qua, commit abc123',
    ]);
    expect([done.code, lastLine(done.stdout), done.stderr]).toEqual([
      0,
      'ok',
      '',
    ]);
    await expect
      .poll(async () => (await plans())[0]?.runs?.[0], { timeout: 10_000 })
      .toMatchObject({
        event: 'done',
        active: false,
        result: 'Đã xong: 12 bài kiểm thử qua, commit abc123',
      });

    // Report mode opened no window and left the first instance and the plan alone.
    expect(app.windows()).toHaveLength(1);
    expect(await readFile(plan, 'utf8')).toBe(planText);
    expect(await readdir(join(data, 'runs'))).toEqual([`${runId}.jsonl`]);
  } finally {
    await app.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
