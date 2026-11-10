import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { collectOverview } from './collect';
import { withTemp, write } from './fixtures.test-support';

const git = promisify(execFile);

async function repoWithOrigin(dir: string, origin: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git('git', ['-C', dir, 'init', '-q'], { windowsHide: true });
  await git('git', ['-C', dir, 'remote', 'add', 'origin', origin], {
    windowsHide: true,
  });
}

describe('default Git runner', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('reads the configured repository even when the app inherited GIT_DIR', async () =>
    withTemp(async (root) => {
      const mine = join(root, 'mine');
      const other = join(root, 'other');
      await repoWithOrigin(mine, 'https://github.com/owner/mine.git');
      await repoWithOrigin(other, 'https://github.com/owner/other.git');
      await write(mine, '.tasks/a.md', '- [done] a');
      // As when Agent Ops is started from a Git hook or a shell that set these.
      process.env.GIT_DIR = join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      const out = await collectOverview({
        projects: [{ id: 'p', path: mine, kind: 'repo' }],
      });
      expect(out.repos[0]?.gh).toBe('https://github.com/owner/mine');
    }));
});
