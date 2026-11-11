import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { shortPath, tempDir } from '../../lib/safe-io/test-helpers';
import { PlanWatcher } from './watch';

it('watches a Tasks folder given by its 8.3 short name without aborting the process', async () => {
  const long = join(tempDir(), 'A long Tasks folder name');
  mkdirSync(join(long, 'workspace'), { recursive: true });
  const short = shortPath(long);
  let changed = 0;
  const watcher = new PlanWatcher({
    changed: () => changed++,
    intervalMs: 60_000,
    debounceMs: 10,
  });
  try {
    await watcher.configure({ tasksDir: short });
    // libuv used to assert (exit 0xC0000409) on the first event under the long name.
    writeFileSync(join(long, 'workspace', 'plan.md'), 'Status: Planning\n');
    await expect.poll(() => changed, { timeout: 5000 }).toBeGreaterThan(0);
  } finally {
    await watcher.stop();
  }
});

it('reads again when an agent report is appended to the runs folder', async () => {
  const root = tempDir();
  const runs = join(root, 'runs');
  mkdirSync(join(root, 'tasks', 'workspace'), { recursive: true });
  mkdirSync(runs);
  let changed = 0;
  const watcher = new PlanWatcher({
    changed: () => changed++,
    intervalMs: 60_000,
    debounceMs: 10,
  });
  try {
    await watcher.configure({ tasksDir: join(root, 'tasks'), runsDir: runs });
    const file = join(runs, '00000000-0000-4000-8000-000000000001.jsonl');
    writeFileSync(file, '{}\n');
    await expect.poll(() => changed, { timeout: 5000 }).toBeGreaterThan(0);
    const before = changed;
    // A lock file alone is not a change.
    writeFileSync(join(runs, 'x.lock'), '1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changed).toBe(before);
    appendFileSync(file, '{}\n');
    await expect.poll(() => changed, { timeout: 5000 }).toBeGreaterThan(before);
  } finally {
    await watcher.stop();
  }
});
