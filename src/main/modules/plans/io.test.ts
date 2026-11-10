import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shortPath, withTemp } from './fixtures.test-support';
import { longPath } from './io';

describe.skipIf(process.platform !== 'win32')('longPath', () => {
  it('expands short names like GetLongPathName without resolving a junction', async () =>
    withTemp(async (root) => {
      const long = join(root, 'A very long folder name');
      await mkdir(join(long, 'target', 'inner'), { recursive: true });
      await symlink(join(long, 'target'), join(long, 'link'), 'junction');
      const short = shortPath(long);
      if (short.toLowerCase() === long.toLowerCase()) return; // 8.3 names are disabled on this volume
      const expanded = await longPath(join(short, 'link', 'inner'));
      expect(expanded.toLowerCase()).toBe(
        join(long, 'link', 'inner').toLowerCase(),
      );
    }));

  it('keeps a name that merely contains ~digit and a path that does not exist', async () =>
    withTemp(async (root) => {
      const odd = join(root, 'release~2 notes');
      await mkdir(odd);
      expect(await longPath(odd)).toBe(odd);
      const missing = join(root, 'GONE~1', 'x');
      expect(await longPath(missing)).toBe(missing);
    }));
});
