import { describe, expect, it } from 'vitest';
import { isRendererURL } from './ipc';
describe('trusted document matching', () => {
  it('permits hash routes only on the exact trusted origin and document', () => {
    const expected = 'app://agent-ops/index.html';
    expect(
      isRendererURL(expected + '#/plan/tasks%2Fteam%2Fone', expected),
    ).toBe(true);
    for (const actual of [
      'app://other/index.html',
      'app://agent-ops/other.html',
      expected + '?query=1',
      'https://example.com',
      'not a URL',
    ])
      expect(isRendererURL(actual, expected)).toBe(false);
  });
});
