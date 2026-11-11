import { describe, expect, it } from 'vitest';
import { agentList, canonicalAgent } from './agents';
import { parsePlan } from './overview';
import { diff, planKey, type Plan as ActivityPlan } from '../activity/diff';

describe('agent names', () => {
  it.each([
    ['claude', 'Claude'],
    [' CODEX ', 'Codex'],
    ['gemini', 'Gemini'],
    ['Antigravity', 'Antigravity'],
    ['anti', 'Antigravity'],
    ['ANTI', 'Antigravity'],
    ['cursor', 'Cursor'],
    ['copilot', 'Copilot'],
    ['Orca worker 2', 'Orca worker 2'],
    ['  my   agent ', 'my agent'],
    ['tab	here', 'tab here'],
    ['gpt-6.1_sol', 'gpt-6.1_sol'],
    ['Trợ lý', 'Trợ lý'],
    ['none', ''],
    ['NONE', ''],
    ['', ''],
    ['x'.repeat(40), 'x'.repeat(40)],
  ])('canonicalises %j as %j', (input, expected) =>
    expect(canonicalAgent(input)).toBe(expected),
  );
  it.each([
    'x'.repeat(41),
    'Claude (Opus)',
    'a/b',
    'Codex, Claude',
    '-flag',
    'name<script>',
    'tab\there',
  ])('refuses %j', (input) => {
    // A tab collapses to a space, so only the other characters fail.
    if (input.includes('\t')) expect(canonicalAgent(input)).toBe('tab here');
    else expect(canonicalAgent(input)).toBeUndefined();
  });
  it('reads lists, dropping invalid and repeated names', () => {
    expect(agentList('codex, Claude, CODEX, bad/name, anti')).toEqual([
      'Codex',
      'Claude',
      'Antigravity',
    ]);
    expect(agentList('none')).toEqual([]);
    expect(agentList('')).toEqual([]);
  });
});

describe('plan agent fields', () => {
  const source = [
    'Agent: claude',
    'Executor: Codex',
    'Status: Implementing',
    '## M1: Work',
    '- [doing] Build the reader <!-- Executors: codex, anti -->',
    '- [todo] Write docs ~2h <!-- Executor: Copilot -->',
    '- [todo] No agents <!-- Executors: none -->',
    '- [todo] Plain step',
    '⬜ Emoji step <!-- executor: Gemini -->',
    '',
  ].join('\n');
  it('reads Agent: and the step comment, and removes the comment from the text', () => {
    const p = parsePlan(source);
    expect(p.agent).toBe('Claude');
    expect(
      p.steps.map((s) => [s.text, s.executors, s.line, s.milestone, s.index]),
    ).toEqual([
      ['Build the reader', ['Codex', 'Antigravity'], 5, 'M1', 0],
      ['Write docs', ['Copilot'], 6, 'M1', 1],
      ['No agents', undefined, 7, 'M1', 2],
      ['Plain step', undefined, 8, 'M1', 3],
      ['Emoji step', ['Gemini'], 9, 'M1', 4],
    ]);
    expect(p.milestones[0]!.steps[0]!.executors).toEqual([
      'Codex',
      'Antigravity',
    ]);
  });
  it('leaves agent out when absent, none or invalid, and reads it only in the header', () => {
    expect(parsePlan('- [todo] a\n').agent).toBeUndefined();
    expect(parsePlan('Agent: none\n').agent).toBeUndefined();
    expect(parsePlan('Agent: Claude (Opus)\n').agent).toBeUndefined();
    expect(parsePlan('## M1: x\nAgent: Codex\n').agent).toBeUndefined();
    expect(parsePlan('Agent: Orca worker\nAgent: Codex\n').agent).toBe(
      'Orca worker',
    );
  });
  it('a comment in the middle of a step is plain text', () => {
    const p = parsePlan('- [todo] a <!-- Executors: Codex --> b\n');
    expect(p.steps[0]).toMatchObject({
      text: 'a <!-- Executors: Codex --> b',
    });
    expect(p.steps[0]!.executors).toBeUndefined();
  });
  it('the comment never changes step identity, keys or activity', () => {
    const plain = source
      .replace(/^Agent: .*\n/m, '')
      .replace(/\s*<!--[^>]*-->/g, '');
    const a = parsePlan(plain, { project: 'tasks', repo: 'ws', name: 'p' });
    const b = parsePlan(source, { project: 'tasks', repo: 'ws', name: 'p' });
    const identity = (p: typeof a) =>
      p.steps.map(({ text, status, milestone, index }) => ({
        text,
        status,
        milestone,
        index,
      }));
    expect(identity(b)).toEqual(identity(a));
    expect(b.milestones.map((m) => m.progress)).toEqual(
      a.milestones.map((m) => m.progress),
    );
    // The revision is the file's hash, so any byte change already changes it.
    expect(b.revision).not.toBe(a.revision);
    const asActivity = ({ runs, ...p }: typeof a): ActivityPlan => {
      expect(runs).toBeUndefined();
      return { ...p, decisions: [], questions: [] };
    };
    expect(planKey(asActivity(a))).toBe(planKey(asActivity(b)));
    expect(
      diff(
        { [planKey(asActivity(a))]: asActivity(a) },
        { [planKey(asActivity(b))]: asActivity(b) },
      ),
    ).toEqual([]);
  });
});
