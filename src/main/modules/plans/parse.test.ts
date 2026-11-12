import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { parseMarkdown, stripEstimates } from './parse';
import { parsePlan, stamped } from './overview';

describe('Go parser baseline', () => {
  it('reads explicit waiting tasks independently of the recorded plan state', () => {
    const plan = parsePlan(
      'Status: Waiting for CI\n## M1: Verify [waiting]\n- [done] Build\n- [waiting] Await input\n- [partial] Legacy work\n',
    );
    expect(plan.status).toBe('Waiting for CI');
    expect(plan.steps.map((s) => s.status)).toEqual([
      'done',
      'waiting',
      'partial',
    ]);
    expect(plan.milestones[0]!.state).toBe('waiting');
    expect(plan.milestones[0]!.progress).toEqual({ done: 1, total: 3 });
  });
  it('reads headers only before sections and outside fences', () => {
    const p = parsePlan(
      '# Plan\n\nGoal: real goal\n\n```\nStatus: Done\nSpec: fake.md\n```\n\n## M1: Work\nNext: not a header\n- [doing] step\n',
    );
    expect([p.status, p.spec, p.next, p.goal]).toEqual([
      'In progress',
      '',
      '',
      'real goal',
    ]);
  });
  it('closes fences only on a bare matching fence', () => {
    const p = parsePlan(
      '- [todo] before\n```\n- [done] inside\n```js\n- [done] still inside\n```\n- [todo] after\n',
    );
    expect(p.steps.map((s) => `${s.status}:${s.text}`)).toEqual([
      'todo:before',
      'todo:after',
    ]);
  });
  it('reports an unclosed fence and ignores the remaining text', () => {
    const p = parseMarkdown('- [todo] before\n\n~~~\n- [done] hidden\n');
    expect(p.unclosedFence).toBe(3);
    expect(p.steps.map((s) => s.text)).toEqual(['before']);
  });
  it('replaces invalid UTF-8, collapsing adjacent invalid bytes like Go', () => {
    const source = Buffer.concat([
      Buffer.from('Status: Testing\n- [todo] bad '),
      Buffer.from([255, 254]),
      Buffer.from(' byte\n'),
    ]);
    const p = parseMarkdown(source);
    expect(p.invalidUTF8).toBe(true);
    expect(p.label).toBe('Testing');
    expect(p.steps[0]?.text).toBe('bad � byte');
    expect(p.revision).toBe(createHash('sha256').update(source).digest('hex'));
  });
  it('keeps duplicate steps apart by their CRLF line and milestone position', () => {
    const p = parsePlan(
      'Status: Testing\r\n\r\n## M1: A\r\n- [done] Same\r\n- [todo] Same\r\n## M2: B\r\n- [doing] Same\r\n',
    );
    expect(p.steps.map((s) => [s.line, s.milestone, s.index])).toEqual([
      [4, 'M1', 0],
      [5, 'M1', 1],
      [7, 'M2', 0],
    ]);
    expect(p.milestones.map((m) => m.progress)).toEqual([
      { done: 1, total: 2 },
      { done: 0, total: 1 },
    ]);
  });
  it.each([
    ['Port ~2h', 'Port'],
    ['Port ~ 1,5 ngày now', 'Port now'],
    ['Two ~2ph and ~3PHÚT', 'Two and'],
    ['Not ~5mét an estimate', 'Not ~5mét an estimate'],
    ['Half ~1.5', 'Half ~1.5'],
    ['Tight~30min', 'Tight'],
    ['Mixed ~2m.', 'Mixed.'],
    ['Vietnamese ~1 giờ rồi', 'Vietnamese rồi'],
    ['Unit then letter ~2hours', 'Unit then letter ~2hours'],
  ])('strips estimates: %s', (input, expected) =>
    expect(stripEstimates(input).trim()).toBe(expected),
  );
  it('preserves BOM bytes in the revision while reading Vietnamese headers', () => {
    const text =
      '\uFEFFTiếp theo: làm tiếp\r\nTrạng thái: Đang làm\r\nOwner: người viết\r\n';
    const p = parsePlan(text);
    expect([p.next, p.status, p.owner]).toEqual([
      'làm tiếp',
      'Đang làm',
      'người viết',
    ]);
    expect(p.revision).toBe(createHash('sha256').update(text).digest('hex'));
  });
  it('uses first English header even when empty, tolerates retired headers', () => {
    const p = parsePlan(
      'Next:\nNext: second\nTiếp theo: fallback\nAgent: A\nExecutor: B\nStatus: Testing\n',
    );
    expect(p.next).toBe('');
    expect(p.owner).toBe('');
    expect(p.status).toBe('Testing');
  });
  it('continues decisions and handles multiple answers and open word boundaries', () => {
    const p = parsePlan(
      '## Decisions\n- 2026-11-09: Decide\n unindented too\n\n## Questions\n- 2026-11-10 9:05: Ask? | Answer: one | Answer: two\n- Open? | Answer: Open-source\n- Empty?\n- Opening? | Answer: opening\n',
    );
    expect(p.decisions).toEqual([
      { key: '202611099999', when: '09/11', text: 'Decide unindented too' },
    ]);
    expect(p.questions.map((q) => [q.answer, q.open])).toEqual([
      ['one two', false],
      ['', true],
      ['', true],
      ['opening', false],
    ]);
    expect(p.questions[0]?.when).toBe('10/11 09:05');
  });
  it('handles levels, states, loose steps, emoji and retired executor suffixes', () => {
    const p = parsePlan(
      '- [todo] loose\n#### m2a – Việt [DONE]\nSummary: summary\n✅ Xong ~2h\n⚠️ Dở <!-- Executors: A, B -->\n- [x] ignored\n# Reset\n🔄 Outside\n',
    );
    expect(p.milestones[0]).toMatchObject({
      id: 'M2A',
      title: 'Việt',
      state: 'done',
      summary: 'summary',
      progress: { done: 1, total: 2 },
    });
    expect(p.steps.map((s) => [s.text, s.milestone, s.index])).toEqual([
      ['loose', '', 0],
      ['Xong', 'M2A', 0],
      ['Dở', 'M2A', 1],
      ['Outside', '', 3],
    ]);
  });
  it.each([
    ['', 'Not started', 'idle', -1],
    ['- [todo] a', 'Not started', 'idle', -1],
    ['- [done] a', 'Done', 'ok', 6],
    ['- [doing] a', 'In progress', 'doing', -1],
    ['- [partial] a', 'Partly done', 'pending', -1],
    ['- [doing] a\n- [blocked] b', 'Blocked', 'bad', -1],
  ])('derives missing status from %s', (text, status, tone, step) => {
    expect(parsePlan(text)).toMatchObject({ status, tone, step });
  });
  it.each([
    ['Planning', 'doing', 0],
    ['Implementing', 'doing', 1],
    ['Reviewing', 'review', 2],
    ['Fixing review', 'review', 2],
    ['Testing', 'test', 3],
    ['Waiting for CI', 'test', 4],
    ['Dry run', 'test', 5],
    ['Waiting for owner', 'pending', -1],
    ['Shipping', 'doing', 5],
    ['Blocked', 'bad', -1],
    ['Done', 'ok', 6],
    ['chặn', 'bad', -1],
    ['lỗi', 'bad', -1],
    ['failed', 'bad', -1],
    ['xong', 'ok', -1],
    ['merged', 'ok', -1],
    ['needs review', 'review', -1],
    ['chờ owner duyệt', 'pending', -1],
    ['test build', 'test', -1],
    ['CI ready', 'test', -1],
    ['custom', 'doing', -1],
  ])('maps stage/tone %s', (label, tone, step) => {
    expect(
      parsePlan(`Status: ${label} details\n- [blocked] overridden`),
    ).toMatchObject({ status: `${label} details`, tone, step });
  });
  it('keeps lines that contain a lone CR or a Unicode line separator, like Go', () => {
    // Go's regexp "." matches every character except a newline; JavaScript's needs the s flag.
    const p = parsePlan(
      '## M1: Title more\n- [done] a b\n## M2: x\ry\n- [todo] c\rd\n## Decisions\n- one two\n## Questions\n- ask\rmore? | Answer: yes\n',
    );
    expect(p.milestones.map((m) => [m.id, m.title])).toEqual([
      ['M1', 'Title more'],
      ['M2', 'x\ry'],
    ]);
    expect(p.steps.map((s) => [s.text, s.milestone])).toEqual([
      ['a b', 'M1'],
      ['c\rd', 'M2'],
    ]);
    expect(p.decisions.map((d) => d.text)).toEqual(['one two']);
    expect(p.questions.map((q) => q.ask)).toEqual(['ask\rmore?']);
  });
  it('keeps non-stamped decision text', () =>
    expect(stamped('undated')).toEqual({ key: '', when: '', text: 'undated' }));
});
