import { readdirSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Mutex,
  appendLines,
  isBusy,
  moveAside,
  readFileRetry,
  readJsonLines,
  readJsonTolerant,
  readTail,
  writeFileAtomic,
  type FsOps,
} from './safe-io';
import {
  has,
  holdExclusively,
  onWindows,
  put,
  read,
  tempDir,
} from './test-helpers';

const busy = () =>
  Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temporary file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'state.json');
    await writeFileAtomic(file, '{"old":true}');
    await writeFileAtomic(file, '{"new":true}');
    expect(read(file)).toBe('{"new":true}');
    expect(readdirSync(path.dirname(file))).toEqual(['state.json']);
  });

  it('retries while the target is held (injected sharing violation)', async () => {
    const file = put(path.join(tempDir(), 'config.json'), 'old');
    let failures = 2;
    const rename: FsOps['rename'] = async (s, t) => {
      if (failures-- > 0) throw busy();
      await fs.rename(s, t);
    };
    await writeFileAtomic(file, 'new', { ops: { rename } });
    expect(read(file)).toBe('new');
    expect(failures).toBe(-1);
  });

  it('gives up on a persistent lock and keeps the old file intact', async () => {
    const file = put(path.join(tempDir(), 'locked.json'), 'old');
    const rename: FsOps['rename'] = async () => {
      throw busy();
    };
    await expect(
      writeFileAtomic(file, 'new', { ops: { rename }, retryForMs: 100 }),
    ).rejects.toSatisfy(isBusy);
    expect(read(file)).toBe('old');
    expect(readdirSync(path.dirname(file))).toEqual(['locked.json']);
  });

  it('a half-written temporary file never reaches the target', async () => {
    const file = put(path.join(tempDir(), 'config.json'), '{"ok":true}');
    const writeAll: FsOps['writeAll'] = async (handle, data) => {
      await handle.write(data.subarray(0, 3));
      throw Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      });
    };
    await expect(
      writeFileAtomic(file, '{"ok":false,"long":true}', { ops: { writeAll } }),
    ).rejects.toThrow('ENOSPC');
    expect(read(file)).toBe('{"ok":true}');
    expect(readdirSync(path.dirname(file))).toEqual(['config.json']);
  });

  it.skipIf(!onWindows)(
    'waits out a real sharing violation from another process',
    async () => {
      const file = put(path.join(tempDir(), 'state.json'), '{"old":true}');
      const { released } = await holdExclusively(file, 600);
      await writeFileAtomic(file, '{"new":true}');
      await released;
      expect(read(file)).toBe('{"new":true}');
      expect(readdirSync(path.dirname(file))).toEqual(['state.json']);
    },
    20000,
  );
});

describe('reads', () => {
  it.skipIf(!onWindows)(
    'readFileRetry waits out a real sharing violation',
    async () => {
      const file = put(path.join(tempDir(), 'config.json'), 'data');
      await holdExclusively(file, 500);
      await expect(fs.readFile(file)).rejects.toSatisfy(isBusy);
      expect((await readFileRetry(file)).toString()).toBe('data');
    },
    20000,
  );

  it('readFileRetry reports a missing file at once', async () => {
    const start = Date.now();
    await expect(
      readFileRetry(path.join(tempDir(), 'none')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('readTail drops the cut line', async () => {
    const dir = tempDir();
    const whole =
      ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'].join('\n') + '\n';
    const file = put(path.join(dir, 'activity.jsonl'), whole);
    expect((await readTail(file, 12))?.toString()).toBe('{"n":4}\n');
    expect(await readTail(path.join(dir, 'none'), 10)).toBeNull();
    expect((await readTail(file, 1 << 20))?.toString()).toBe(whole);
  });
});

describe('readJsonTolerant', () => {
  const now = new Date(Date.UTC(2026, 10, 10, 9, 30, 0));

  it('moves a partial file aside with a warning, never replacing it', async () => {
    const file = put(
      path.join(tempDir(), 'snapshot.json'),
      '{"web/plan":{"repo":"web","sta',
    );
    const r = await readJsonTolerant(file, { now, label: 'The snapshot' });
    expect(r.status).toBe('corrupt');
    if (r.status !== 'corrupt') return;
    expect(r.aside).toBe(`${file}.corrupt-20261110-093000`);
    expect(read(r.aside)).toBe('{"web/plan":{"repo":"web","sta');
    expect(r.warning).toContain('The snapshot was unreadable');
    expect(has(file)).toBe(false);
  });

  it('a second corrupt file on the same second gets its own name', async () => {
    const file = path.join(tempDir(), 'x.json');
    put(file, '{');
    const first = await moveAside(file, now);
    put(file, '[');
    const second = await moveAside(file, now);
    expect(second).not.toBe(first);
    expect(read(first)).toBe('{');
    expect(read(second)).toBe('[');
  });

  it('reports invalid content from validate as corrupt', async () => {
    const file = put(path.join(tempDir(), 'a.json'), '[1,2]');
    const r = await readJsonTolerant(file, {
      now,
      validate: (v) => {
        if (!Array.isArray(v) || v.length !== 3)
          throw new Error('expected three items');
        return v;
      },
    });
    expect(r).toMatchObject({
      status: 'corrupt',
      reason: 'expected three items',
    });
  });

  it('leaves a file it cannot read alone', async () => {
    const dir = tempDir();
    const folder = path.join(dir, 'config.json');
    await fs.mkdir(folder);
    const r = await readJsonTolerant(folder, { now });
    expect(r.status).toBe('unreadable');
    expect(has(folder)).toBe(true);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });

  it('reads a file with a UTF-8 byte order mark', async () => {
    const file = put(path.join(tempDir(), 'b.json'), '﻿{"a":1}');
    expect(await readJsonTolerant(file)).toEqual({
      status: 'ok',
      value: { a: 1 },
    });
    expect(await readJsonTolerant(path.join(tempDir(), 'none.json'))).toEqual({
      status: 'missing',
    });
  });
});

describe('bounded append store', () => {
  it('appends, then compacts to the kept lines once over the bound', async () => {
    const file = path.join(tempDir(), 'log.jsonl');
    const keep = ['{"kept":1}'];
    expect(
      await appendLines(file, ['{"a":1}', '{"a":2}'], {
        maxBytes: 100,
        compact: () => keep,
      }),
    ).toBe(false);
    expect(read(file)).toBe('{"a":1}\n{"a":2}\n');
    expect(
      await appendLines(file, ['x'.repeat(200)], {
        maxBytes: 100,
        compact: () => keep,
      }),
    ).toBe(true);
    expect(read(file)).toBe('{"kept":1}\n');
  });

  it('readJsonLines skips a line cut by a crash and lines that fail the check', async () => {
    const file = put(
      path.join(tempDir(), 'log.jsonl'),
      '{"n":1}\n"text"\n{"n":2}\n{"n":',
    );
    const isN = (v: unknown): v is { n: number } =>
      typeof v === 'object' && v !== null && 'n' in v;
    expect(await readJsonLines(file, 1 << 20, isN)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(await readJsonLines(path.join(tempDir(), 'none'), 10, isN)).toEqual(
      [],
    );
  });
});

describe('Mutex', () => {
  it('runs sections one at a time and survives a failure', async () => {
    const m = new Mutex();
    const order: string[] = [];
    const a = m.run(async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
    });
    const b = m.run(async () => {
      order.push('b');
      throw new Error('boom');
    });
    const c = m.run(async () => order.push('c'));
    expect(m.locked).toBe(true);
    await a;
    await expect(b).rejects.toThrow('boom');
    await c;
    expect(order).toEqual(['a1', 'a2', 'b', 'c']);
    expect(m.locked).toBe(false);
  });
});
