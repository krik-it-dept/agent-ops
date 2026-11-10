import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { onWindows } from '../../lib/safe-io/test-helpers';
import {
  projectDisplayName,
  projectIdFor,
  projectPathForId,
  repoNameOf,
} from './identity';

describe.skipIf(!onWindows)('workspace identity', () => {
  it('is the first 8 hex digits of SHA-256 over the lower-cased cleaned path', () => {
    const expected = createHash('sha256')
      .update('d:\\projects\\repos')
      .digest('hex')
      .slice(0, 8);
    expect(projectIdFor('D:\\Projects\\Repos')).toBe(expected);
  });

  it('ignores case and a trailing separator, keeps a drive root', () => {
    const id = projectIdFor('D:\\Projects\\Repos');
    for (const same of [
      'd:\\projects\\repos\\',
      'D:\\Projects\\Repos\\\\',
      'D:/Projects/Repos',
      'D:\\Projects\\.\\Repos',
    ]) {
      expect(projectIdFor(same), same).toBe(id);
    }
    expect(projectPathForId('D:\\')).toBe('D:\\');
    expect(projectIdFor('D:\\')).toBe(
      createHash('sha256').update('d:\\').digest('hex').slice(0, 8),
    );
  });

  it('names repositories and workspaces like the baseline', () => {
    expect(repoNameOf('D:\\work\\web\\')).toBe('web');
    expect(repoNameOf('D:\\')).toBe('D');
    expect(repoNameOf('\\\\server\\share')).toBe('share');
    expect(projectDisplayName('D:\\work\\Dự án')).toBe('Dự án');
    expect(projectDisplayName('D:\\')).toBe('D:\\');
  });
});
