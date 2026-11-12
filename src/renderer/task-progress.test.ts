import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Step } from '../shared/contracts';
import {
  SegmentedProgress,
  TaskOverview,
  taskSummary,
} from './components/TaskProgress';

const steps = (counts: Partial<Record<Step['status'], number>>) =>
  Object.entries(counts).flatMap(([status, count]) =>
    Array.from({ length: count }, (_, index) => ({
      status: status as Step['status'],
      text: 'Task',
      line: index + 1,
      milestone: '',
      index,
    })),
  );

describe('checklist status summaries', () => {
  it('counts every checklist task once, preserving waiting and legacy partial', () => {
    const summary = taskSummary(
      steps({
        done: 60,
        doing: 8,
        todo: 9,
        blocked: 3,
        waiting: 2,
        partial: 1,
      }),
    );
    expect(summary).toEqual({
      total: 83,
      done: 60,
      doneOrDoing: 68,
      counts: {
        done: 60,
        doing: 8,
        todo: 9,
        blocked: 3,
        waiting: 2,
        partial: 1,
      },
    });
    expect(Object.values(summary.counts).reduce((a, b) => a + b, 0)).toBe(
      summary.total,
    );
  });
  it('summarizes done plus in progress while keeping each status segment accurate', () => {
    const summary = taskSummary(
      steps({ done: 60, doing: 8, todo: 9, blocked: 3 }),
    );
    const html = renderToStaticMarkup(
      createElement(SegmentedProgress, {
        summary,
        label: 'Task progress',
        detail: true,
      }),
    );
    for (const label of [
      'Done — 60 tasks · 75%',
      'In progress — 8 tasks · 10%',
      'To do — 9 tasks · 11%',
      'Blocked — 3 tasks · 4%',
    ])
      expect(html).toContain(label);
    expect(html).toContain('68 / 80 · 85%');
    expect(html).toContain(
      'aria-label="Done + In progress: 68 of 80 tasks · 85%"',
    );
    expect(summary.done).toBe(60);
    expect(html).not.toContain('Waiting —');
  });
  it('keeps zero states usable and exposes selected filters to assistive technology', () => {
    const html = renderToStaticMarkup(
      createElement(TaskOverview, {
        steps: [],
        selected: 'blocked',
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain('aria-label="Blocked: 0 tasks" aria-pressed="true"');
    expect(html).toContain('0 / 0 · 0%');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
