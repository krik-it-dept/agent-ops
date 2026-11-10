import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  has,
  mkRepo,
  put,
  read,
  tempDir,
} from '../../lib/safe-io/test-helpers';
import type { Project } from '../settings/config';
import {
  ActivityLog,
  MAX_SEEN_PROJECTS,
  STORE_FILES,
  type ProjectResult,
} from './activity-log';
import { STALE_AFTER_MS, type ActivityEvent, type Plan } from './diff';
import { mapLegacyKeys, upgradeActivityFile } from './legacy-keys';
import { plan } from './test-plans';

const now = new Date(Date.UTC(2026, 10, 10, 9, 0, 0));

function kinds(events: ActivityEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

function lines(dir: string): number {
  const file = path.join(dir, STORE_FILES.activity);
  return has(file) ? read(file).split('\n').filter(Boolean).length : 0;
}

async function newLog(dir = tempDir(), opts: { maxBytes?: number } = {}) {
  const log = new ActivityLog({ dataDir: dir, now: () => now, ...opts });
  await log.load();
  return { dir, log };
}

/** A workspace's plans with history and stale work: a dated decision, a done milestone, three hours idle. */
function history(project: string, names = ['plan']): Plan[] {
  return names.map((name) => {
    const p = plan({
      project,
      repo: project === 'tasks' ? 'web' : 'repo',
      name,
      mtime: new Date(now.getTime() - (3 * STALE_AFTER_MS) / 2).toISOString(),
    });
    p.decisions = [
      {
        key: '202601021000',
        when: '2026-01-02 10:00',
        text: 'Keep it small',
        ask: '',
        answer: '',
        open: false,
      },
    ];
    p.milestones = [
      {
        id: 'M1',
        title: 'Build',
        state: 'done',
        summary: 'Built',
        steps: [{ status: 'done', text: 'Step' }],
      },
    ];
    p.steps = [{ status: 'done', text: 'Step' }];
    return p;
  });
}

const ok = (...ids: string[]): ProjectResult[] =>
  ids.map((id) => ({ id, status: 'ok' }));

describe('ActivityLog stores', () => {
  it('loads half-written stores empty, keeps them aside, and loads the rest', async () => {
    const dir = tempDir();
    const good = JSON.stringify({
      ts: '2026-11-10T09:00:00Z',
      repo: 'r',
      plan: 'p',
      kind: 'done',
      text: 'kept',
      actor: 'x',
    });
    put(
      path.join(dir, STORE_FILES.activity),
      `${good}\n{"ts":"2026-11-10T09:01:00Z","repo":"r","pl`,
    );
    put(
      path.join(dir, STORE_FILES.snapshot),
      '{"web/plan":{"repo":"web","name":"plan","sta',
    );
    put(path.join(dir, STORE_FILES.stale), '{"a/b/c":"2026-');
    put(path.join(dir, STORE_FILES.seenProjects), '{"abc":tr');
    const { log } = await newLog(dir);
    expect(log.events.map((e) => e.text)).toEqual(['kept']);
    expect(log.prev).toBeNull();
    expect(log.staleSeen).toEqual({});
    expect(log.seenProjects).toEqual({});
    expect(log.warnings).toHaveLength(3);
    expect(
      readdirSync(dir).filter((n) => n.includes('.corrupt-')),
    ).toHaveLength(3);
  });

  it('writes the JSON stores atomically and only when they change', async () => {
    const { dir, log } = await newLog();
    log.prev = { 'p/r/plan': plan({ project: 'p', repo: 'r' }) };
    log.seenProjects = { p: true };
    expect(await log.persist([], null)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([
      'seen-projects.json',
      'snapshot.json',
      'stale.json',
    ]);
    expect(
      (
        JSON.parse(read(path.join(dir, STORE_FILES.snapshot))) as Record<
          string,
          Plan
        >
      )['p/r/plan']?.name,
    ).toBe('plan');
    put(path.join(dir, STORE_FILES.snapshot), 'edited elsewhere');
    await log.persist([], null);
    expect(read(path.join(dir, STORE_FILES.snapshot))).toBe('edited elsewhere');
  });

  it('compacts the activity log once it grows too large, and a start reads only its tail', async () => {
    const dir = tempDir();
    const oldLine = JSON.stringify({
      ts: '2020-01-01T00:00:00Z',
      repo: 'old',
      plan: 'p',
      kind: 'done',
      text: 'x'.repeat(200),
      actor: 'a',
    });
    const big = (oldLine + '\n').repeat(60);
    put(path.join(dir, STORE_FILES.activity), big);
    const log = new ActivityLog({
      dataDir: dir,
      now: () => now,
      maxBytes: 4096,
      maxEvents: 10,
    });
    await log.load();
    expect(log.events.length).toBe(10);
    log.events = [
      {
        ts: now.toISOString(),
        repo: 'r',
        plan: 'p',
        kind: 'done',
        text: 'kept',
        actor: 'a',
      },
    ];
    await log.persist(
      [
        {
          ts: now.toISOString(),
          repo: 'r',
          plan: 'p',
          kind: 'done',
          text: 'fresh',
          actor: 'a',
        },
      ],
      null,
    );
    const text = read(path.join(dir, STORE_FILES.activity));
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain('"kept"');
    expect(text).not.toContain('"old"');
  });

  it('prunes stale entries of removed workspaces and bounds the seen list', async () => {
    const { log } = await newLog();
    log.staleSeen = { 'keep/r/p': 'x', 'gone/r/p': 'x', 'legacy/p': 'x' };
    log.seenProjects = { keep: true };
    for (let i = 0; i < MAX_SEEN_PROJECTS + 20; i++)
      log.seenProjects[`old${i}`] = true;
    log.pruneStores(['keep']);
    expect(Object.keys(log.staleSeen).sort()).toEqual(['keep/r/p', 'legacy/p']);
    expect(Object.keys(log.seenProjects).length).toBeLessThanOrEqual(
      MAX_SEEN_PROJECTS,
    );
    expect(log.seenProjects.keep).toBe(true);
  });

  it('a lost snapshot seeds history again without writing logged events twice', async () => {
    const { dir, log } = await newLog();
    await log.apply({ plans: history('aaaa1111'), projects: ok('aaaa1111') }, [
      'aaaa1111',
    ]);
    const logged = lines(dir);
    expect(logged).toBeGreaterThan(0);
    const again = new ActivityLog({ dataDir: dir, now: () => now });
    await again.load();
    again.prev = null;
    const out = await again.apply(
      { plans: history('aaaa1111'), projects: ok('aaaa1111') },
      ['aaaa1111'],
    );
    expect(out.quiet).toEqual([]);
    expect(out.fresh).toEqual([]);
    expect(lines(dir)).toBe(logged);
  });
});

describe('refresh seeding rules', () => {
  it('a first run seeds history quietly and logs stale plans without announcing them', async () => {
    const { log } = await newLog();
    const out = await log.apply(
      {
        plans: history('alpha001', ['one', 'two', 'three']),
        projects: ok('alpha001'),
      },
      ['alpha001'],
    );
    expect(out.fresh).toEqual([]);
    expect(kinds(out.quiet)).toEqual({ decision: 3, milestone: 3 });
    expect(out.staleAnnounce).toEqual([]);
    expect(kinds(log.events).stale).toBe(3);
  });

  it('adding a workspace does not flood: history seeded once, stale plans logged but not announced', async () => {
    const { log } = await newLog();
    await log.apply(
      {
        plans: history('alpha001', ['one', 'two', 'three']),
        projects: ok('alpha001'),
      },
      ['alpha001'],
    );
    const out = await log.apply(
      {
        plans: [
          ...history('alpha001', ['one', 'two', 'three']),
          ...history('beta0001', ['one', 'two', 'three']),
        ],
        projects: ok('alpha001', 'beta0001'),
      },
      ['alpha001', 'beta0001'],
    );
    expect(out.fresh).toEqual([]);
    expect(kinds(out.quiet)).toEqual({ decision: 3, milestone: 3 });
    expect(out.staleAnnounce).toEqual([]);
    expect(kinds(log.events).stale).toBe(6);
    expect(Object.keys(log.staleSeen)).toHaveLength(6);
  });

  it('disabling and enabling a workspace never reseeds history or repeats stale notices, also after a restart', async () => {
    const { dir, log } = await newLog();
    const both = () => ({
      plans: [...history('alpha001'), ...history('beta0001')],
      projects: ok('alpha001', 'beta0001'),
    });
    const alphaOnly = () => ({
      plans: history('alpha001'),
      projects: ok('alpha001'),
    });
    await log.apply({ plans: history('alpha001'), projects: ok('alpha001') }, [
      'alpha001',
      'beta0001',
    ]);
    await log.apply(both(), ['alpha001', 'beta0001']);
    expect(kinds(log.events)).toMatchObject({ decision: 2, stale: 2 });
    const count = log.events.length;
    const logged = lines(dir);
    for (let i = 0; i < 2; i++) {
      for (const input of [alphaOnly(), both()]) {
        const out = await log.apply(input, ['alpha001', 'beta0001']);
        expect(out.fresh).toEqual([]);
        expect(out.staleAnnounce).toEqual([]);
      }
    }
    expect(log.events.length).toBe(count);
    expect(lines(dir)).toBe(logged);
    // Restart: the returning workspace is still known.
    const restarted = new ActivityLog({ dataDir: dir, now: () => now });
    await restarted.load();
    await restarted.apply(alphaOnly(), ['alpha001', 'beta0001']);
    const out = await restarted.apply(both(), ['alpha001', 'beta0001']);
    expect(out.quiet).toEqual([]);
    expect(out.staleAnnounce).toEqual([]);
    expect(lines(dir)).toBe(logged);
  });

  it('a plan that goes stale while its workspace is read announces once', async () => {
    let clock = new Date(now.getTime());
    const log = new ActivityLog({ dataDir: tempDir(), now: () => clock });
    await log.load();
    const fresh = plan({
      project: 'alpha001',
      repo: 'repo',
      name: 'busy',
      mtime: now.toISOString(),
    });
    await log.apply({ plans: [fresh], projects: ok('alpha001') }, ['alpha001']);
    expect(await log.checkStale(['alpha001'])).toEqual([]);
    clock = new Date(now.getTime() + STALE_AFTER_MS + 60_000);
    const announced = await log.checkStale(['alpha001']);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.text).toContain('Đứng im');
    expect(await log.checkStale(['alpha001'])).toEqual([]);
  });

  it('changes are announced; a workspace that stops being readable drops quietly', async () => {
    const { log } = await newLog();
    const p = plan(
      { project: 'alpha001', repo: 'repo', mtime: now.toISOString() },
      { status: 'doing', text: 'Build' },
    );
    await log.apply({ plans: [p], projects: ok('alpha001') }, ['alpha001']);
    const done = plan(
      { project: 'alpha001', repo: 'repo', mtime: now.toISOString() },
      { status: 'done', text: 'Build' },
    );
    const out = await log.apply({ plans: [done], projects: ok('alpha001') }, [
      'alpha001',
    ]);
    expect(kinds(out.fresh)).toEqual({ done: 1, milestone: 1 });
    const gone = await log.apply(
      { plans: [], projects: [{ id: 'alpha001', status: 'missing' }] },
      ['alpha001'],
    );
    expect(gone.fresh).toEqual([]);
    const back = await log.apply({ plans: [done], projects: ok('alpha001') }, [
      'alpha001',
    ]);
    expect(back.fresh).toEqual([]);
    expect(back.quiet).toEqual([]);
  });

  it('a move between plan sources is one moved event', async () => {
    const { log } = await newLog();
    const legacy = plan({
      project: 'aa11aa11',
      repo: 'web',
      name: 'release',
      revision: 'r1',
      file: 'D:/repos/web/.tasks/release.md',
      mtime: now.toISOString(),
    });
    await log.apply({ plans: [legacy], projects: ok('aa11aa11', 'tasks') }, [
      'aa11aa11',
    ]);
    const moved = {
      ...legacy,
      project: 'tasks',
      file: 'C:/tasks/web/release.md',
    };
    const out = await log.apply(
      { plans: [moved], projects: ok('aa11aa11', 'tasks') },
      ['aa11aa11'],
    );
    expect(out.fresh).toHaveLength(1);
    expect(out.fresh[0]).toMatchObject({
      kind: 'moved',
      project: 'tasks',
      repo: 'web',
      plan: 'release',
      extra: 'D:/repos/web/.tasks/release.md',
    });
  });
});

describe('history from before workspaces', () => {
  it('upgrades activity lines once, keeps the original, and maps the snapshot', async () => {
    const dir = tempDir();
    const repos = path.join(dir, 'repos');
    mkRepo(path.join(repos, 'sample'), 'plan');
    const projects: Project[] = [
      {
        id: 'main',
        path: repos,
        name: 'repos',
        kind: 'folder',
        enabled: true,
        addedAt: now.toISOString(),
      },
    ];
    const data = path.join(dir, 'data');
    const line = JSON.stringify({
      ts: now.toISOString(),
      repo: 'sample',
      plan: 'plan',
      kind: 'decision',
      text: 'Keep history',
      actor: 'Lan',
    });
    const original = `not json\n${line}\n`;
    put(path.join(data, STORE_FILES.activity), original);
    put(
      path.join(data, STORE_FILES.snapshot),
      JSON.stringify({ 'sample/plan': plan() }),
    );
    put(
      path.join(data, STORE_FILES.stale),
      JSON.stringify({ 'sample/plan': now.toISOString() }),
    );
    expect(await upgradeActivityFile(data, projects)).toBe(true);
    const text = read(path.join(data, STORE_FILES.activity));
    expect(text.startsWith('not json\n')).toBe(true);
    expect(text).toContain('"project":"main"');
    expect(
      readFileSync(
        path.join(data, `${STORE_FILES.activity}.pre-projects`),
        'utf8',
      ),
    ).toBe(original);
    expect(await upgradeActivityFile(data, projects)).toBe(false);

    const log = new ActivityLog({ dataDir: data, now: () => now });
    await log.load();
    await mapLegacyKeys(log, projects);
    expect(Object.keys(log.prev ?? {})).toEqual(['main/sample/plan']);
    expect(Object.keys(log.staleSeen)).toEqual(['main/sample/plan']);
    expect(log.events[0]?.project).toBe('main');

    // The first refresh after the upgrade is quiet.
    const out = await log.apply(
      {
        plans: [
          plan({
            project: 'main',
            mtime: log.prev!['main/sample/plan']!.mtime,
          }),
        ],
        projects: ok('main'),
      },
      ['main'],
    );
    expect(kinds(out.fresh)).toEqual({});

    // A second workspace with a same-named folder no longer detaches the history.
    const other = path.join(dir, 'other');
    mkRepo(path.join(other, 'sample'));
    const both = [
      ...projects,
      { ...projects[0]!, id: 'other', path: other, name: 'other' },
    ];
    const reloaded = new ActivityLog({ dataDir: data, now: () => now });
    await reloaded.load();
    await mapLegacyKeys(reloaded, both);
    expect(
      reloaded.events.find((e) => e.text === 'Keep history')?.project,
    ).toBe('main');
  });
});
