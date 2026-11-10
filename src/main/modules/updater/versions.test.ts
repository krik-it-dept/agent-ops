import { describe, expect, it } from 'vitest';

import { classifyUpdateError } from './errors';
import {
  isNewer,
  isStableVersion,
  notesToText,
  tagOf,
  updatesAllowed,
} from './versions';

describe('version rules', () => {
  it('takes only stable versions part in updates', () => {
    expect(isStableVersion('1.2.3')).toBe(true);
    expect(isStableVersion('v1.2.3')).toBe(true);
    for (const v of [
      '0.0.0',
      '1.2',
      '01.2.3',
      '1.2.3-dev.4',
      '1.2.3-beta',
      '1.2.3+abc',
      'v',
    ]) {
      expect(isStableVersion(v), v).toBe(false);
    }
    expect(updatesAllowed({ packaged: true, version: '1.2.3' })).toBe(true);
    expect(updatesAllowed({ packaged: false, version: '1.2.3' })).toBe(false);
    expect(updatesAllowed({ packaged: true, version: '1.2.3-dev.1' })).toBe(
      false,
    );
  });

  it('compares numerically and normalises to the tag form', () => {
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('v2.0.0', '1.99.99')).toBe(true);
    expect(isNewer('1.2.3', 'v1.2.3')).toBe(false);
    expect(isNewer('1.2.4-beta', '1.2.3')).toBe(false);
    expect(tagOf('1.2.3')).toBe('v1.2.3');
    expect(tagOf('v1.2.3')).toBe('v1.2.3');
  });

  it('turns release notes into bounded plain text', () => {
    expect(
      notesToText(
        '<h2>New</h2><p>A &lt;b&gt; &#39;x&#39; &#x41;</p><script>alert(1)</script>',
      ),
    ).toBe("New\nA <b> 'x' A");
    expect(notesToText('plain\r\n\r\n\r\n\r\ntext')).toBe('plain\n\ntext');
    expect(notesToText('x'.repeat(20_000))).toHaveLength(16_001);
  });

  it('classifies unknown errors as a general failure without details', () => {
    expect(classifyUpdateError('weird')).toEqual({
      kind: 'failed',
      message: expect.stringContaining('keeps running'),
    });
    expect(
      classifyUpdateError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))
        .kind,
    ).toBe('offline');
    expect(
      classifyUpdateError(
        Object.assign(new Error('Not Found'), { statusCode: 404 }),
      ).kind,
    ).toBe('no-release');
  });
});
