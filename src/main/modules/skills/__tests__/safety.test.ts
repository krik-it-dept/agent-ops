// Detection, the seeding of the list, settings preservation and the low-level
// safety rules (markers, backups, links, atomic writes, retries).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ClientFiles } from '../client-files.js';
import { detectionEnvironment, detectTargets } from '../detect.js';
import { FileChangedError, FileLinkedError, SkillsError } from '../errors.js';
import { cleanInputPath, PathTools } from '../paths.js';
import { nodePlatform, retryBusy } from '../platform.js';
import { defaultLabel, targetIdFor } from '../service.js';
import { parseTargets, serializeTarget, skillFileOf } from '../targets.js';
import {
  findBlock,
  INSTRUCTION_END,
  INSTRUCTION_START,
  instructionBlock,
  lineDiff,
  removeBlock,
  skillVersionOf,
} from '../text.js';
import {
  exists,
  expectSkillsError,
  fixture,
  junction,
  makeFixture,
  put,
  read,
  readConfig,
  repoRoot,
  skillText,
} from './helpers.js';

const platform = nodePlatform({ retryForMs: 200 });
const paths = new PathTools(platform);

function backupFiles(dataDir: string): string[] {
  const dir = path.join(dataDir, 'backups', 'integrations');
  if (!exists(dir)) {
    return [];
  }
  return (
    readdirSync(dir, { recursive: true, withFileTypes: true }) as {
      isFile(): boolean;
      parentPath: string;
      name: string;
    }[]
  )
    .filter((d) => d.isFile())
    .map((d) => path.join(d.parentPath, d.name));
}

describe('detection', () => {
  it('skips folders linked to listed ones', async () => {
    const f = makeFixture();
    const env = {
      homeDir: f.home,
      roamingAppData: path.join(f.home, 'AppData', 'Roaming'),
    };
    const claudeSkills = path.join(f.home, '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    const orca = path.join(env.roamingAppData, 'orca', 'claude-profiles');
    const linked = junction(
      path.join(orca, 'linked', 'home', 'skills'),
      claudeSkills,
    );
    mkdirSync(path.join(orca, 'own-profile-id', 'home'), { recursive: true });
    mkdirSync(path.join(f.home, '.gemini'));
    const got = await detectTargets(env, [], paths);
    expect(got.map((s) => `${s.label}=${s.skillDir}`)).toEqual([
      `Claude Code=${claudeSkills}`,
      `Orca Claude profile own-prof=${path.join(orca, 'own-profile-id', 'home', 'skills')}`,
      `Antigravity / Gemini=${path.join(f.home, '.gemini', 'skills')}`,
    ]);
    if (linked) {
      // A listed folder (here through the Orca junction) is no longer suggested.
      const left = await detectTargets(
        env,
        [path.join(orca, 'linked', 'home', 'skills')],
        paths,
      );
      expect(left).toHaveLength(2);
      expect(left[0]!.client).toBe('orca');
    }
  });

  it('uses CLAUDE_CONFIG_DIR and APPDATA only for the real home folder', async () => {
    const f = makeFixture();
    const configDir = path.join(f.root, 'elsewhere', 'claude');
    mkdirSync(configDir, { recursive: true });
    const roaming = path.join(f.root, 'roaming');
    const env = { CLAUDE_CONFIG_DIR: configDir, APPDATA: roaming };
    const isolated = detectionEnvironment(
      f.home,
      env,
      path.join(f.root, 'someone-else'),
      paths,
    );
    expect(isolated).toEqual({
      homeDir: f.home,
      roamingAppData: path.join(f.home, 'AppData', 'Roaming'),
    });
    const real = detectionEnvironment(f.home, env, f.home.toUpperCase(), paths);
    expect(real).toEqual({
      homeDir: f.home,
      roamingAppData: roaming,
      claudeConfigDir: configDir,
    });
    expect(
      detectionEnvironment(
        f.home,
        { CLAUDE_CONFIG_DIR: 'relative\\claude' },
        f.home,
        paths,
      ).claudeConfigDir,
    ).toBeUndefined();
    const got = await detectTargets(real, [], paths);
    expect(got).toEqual([
      {
        client: 'claude',
        label: 'Claude Code (CLAUDE_CONFIG_DIR)',
        skillDir: path.join(configDir, 'skills'),
        instructionFile: path.join(configDir, 'CLAUDE.md'),
      },
    ]);
  });

  it('suggests the shared skills folder without an instruction file when only it exists', async () => {
    const f = makeFixture();
    mkdirSync(path.join(f.home, '.agents'));
    expect(await f.service.suggestTargets()).toEqual([
      {
        client: 'codex',
        label: 'Codex / shared skills',
        skillDir: path.join(f.home, '.agents', 'skills'),
      },
    ]);
  });

  // AI tool folder names live only in the detection provider, so the app never
  // depends on where one computer keeps its AI tools.
  it('names AI tool folders only in the detection provider', () => {
    const dir = path.join(repoRoot, 'src', 'main', 'modules', 'skills');
    const pattern =
      /(^|[\\/~"'`(\s])\.(claude|agents|codex|gemini)\b|claude-profiles/;
    const files = readdirSync(dir).filter(
      (n) => n.endsWith('.ts') && n !== 'detect.ts',
    );
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const name of files) {
      readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          expect(
            pattern.test(line),
            `${name}:${i + 1} names an AI tool folder: ${line.trim()}`,
          ).toBe(false);
        });
    }
  });
});

describe('seeding the list', () => {
  it('seeds once and later only refreshes listed folders', async () => {
    const f = makeFixture({ now: () => new Date('2026-11-10T10:00:00Z') });
    const claude = path.join(f.home, '.claude', 'skills');
    const shared = path.join(f.home, '.agents', 'skills');
    put(skillFileOf(claude), fixture('task-plan-v1.md')); // not the current skill: recorded, not refreshed
    put(skillFileOf(shared), skillText);
    mkdirSync(path.join(f.home, '.gemini')); // no skill there: not seeded
    put(f.configFile, '{"version":1}');
    const first = await f.service.recordDetectedSkills();
    expect(first.added).toEqual([claude, shared]);
    expect(first.refreshed).toEqual([shared]);
    expect(first.problems).toEqual([]);
    let cfg = readConfig(f);
    expect(cfg['integrationsSeeded']).toBe(true);
    let list = cfg['integrations'] as Record<string, unknown>[];
    expect(list.map((t) => t['source'])).toEqual(['detected', 'detected']);
    expect(list[1]).toMatchObject({
      version: 4,
      installedAt: '2026-11-10T10:00:00Z',
    });
    expect(
      read(skillFileOf(claude)),
      'seeding never writes the AI tool folders',
    ).toBe(fixture('task-plan-v1.md'));

    // The owner removes the shared folder; a later run does not add it back but
    // records the now current skill of the listed folder.
    await f.service.removeTarget(list[1]!['id'] as string);
    put(skillFileOf(claude), skillText);
    const second = await f.service.recordDetectedSkills();
    expect(second.added).toEqual([]);
    expect(second.refreshed).toEqual([claude]);
    cfg = readConfig(f);
    list = cfg['integrations'] as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]!['skillDir']).toBe(claude);
    expect(cfg['version']).toBe(1);

    // Nothing new: nothing written.
    const before = read(f.configFile);
    expect(await f.service.recordDetectedSkills()).toEqual({
      added: [],
      refreshed: [],
      problems: [],
    });
    expect(read(f.configFile)).toBe(before);
  });

  it('leaves a linked task-plan folder alone and reports it', async () => {
    const f = makeFixture();
    const source = path.join(f.home, 'repos', 'web', 'skills', 'task-plan');
    put(path.join(source, 'SKILL.md'), skillText);
    if (
      !junction(path.join(f.home, '.agents', 'skills', 'task-plan'), source)
    ) {
      return;
    }
    const r = await f.service.recordDetectedSkills();
    expect(r.added).toEqual([]);
    expect(r.problems.join('\n')).toContain('is a link');
  });

  it('marks the list seeded when the owner changes it first', async () => {
    const f = makeFixture();
    const dir = path.join(f.home, 'a', 'skills');
    mkdirSync(path.dirname(dir), { recursive: true });
    await f.service.addTarget({ skillDir: dir });
    expect(readConfig(f)['integrationsSeeded']).toBe(true);
  });
});

describe('settings preservation', () => {
  it('keeps unknown settings keys and unknown target keys', async () => {
    const f = makeFixture();
    const dir = path.join(f.home, 'tool', 'skills');
    mkdirSync(dir, { recursive: true });
    const id = targetIdFor(dir);
    const stored = {
      version: 1,
      projects: [{ id: 'abc', path: 'D:\\work' }],
      theme: 'dark',
      futureSetting: { nested: [1, 2] },
      integrations: [
        {
          id,
          label: 'Tool',
          skillDir: dir,
          instructionBlock: false,
          enabled: true,
          source: 'custom',
          futureField: 'kept',
          addedAt: '2026-01-01T00:00:00Z',
        },
      ],
    };
    writeFileSync(f.configFile, `\uFEFF${JSON.stringify(stored)}`);
    await f.service.runAction(id, 'install');
    const cfg = readConfig(f);
    expect(cfg['futureSetting']).toEqual({ nested: [1, 2] });
    expect(cfg['projects']).toEqual(stored.projects);
    expect(cfg['theme']).toBe('dark');
    const t = (cfg['integrations'] as Record<string, unknown>[])[0]!;
    expect(t['futureField']).toBe('kept');
    expect(Object.keys(t).slice(0, 7)).toEqual([
      'id',
      'label',
      'skillDir',
      'instructionBlock',
      'enabled',
      'source',
      'addedAt',
    ]);
    expect(t).toMatchObject({ version: 4, addedAt: '2026-01-01T00:00:00Z' });
  });

  it('refuses every change to a list it cannot read, and leaves it as it is', async () => {
    const f = makeFixture();
    const raw = '{"integrations":{"claude":{"path":"C:\\\\x\\\\SKILL.md"}}}';
    put(f.configFile, raw);
    const o = await f.service.listTargets();
    expect(o.targets).toEqual([]);
    expect(o.readOnly).toContain('could not be read');
    await expectSkillsError(
      f.service.addTarget({ skillDir: path.join(f.home, 'x') }),
      'conflict',
      'could not be read',
    );
    put(
      f.configFile,
      '{"integrations":[{"id":"Bad id","label":"x","skillDir":"C:\\\\x","source":"custom"}]}',
    );
    expect((await f.service.listTargets()).readOnly).toContain('invalid id');
    put(f.configFile, '{ not json');
    expect((await f.service.listTargets()).readOnly).toContain(
      'settings file could not be read',
    );
    await expectSkillsError(
      f.service.recordDetectedSkills().then((r) => {
        throw new SkillsError('conflict', r.problems.join(' '));
      }),
      'conflict',
      'could not be read',
    );
    expect(read(f.configFile)).toBe('{ not json');
  });

  it('refuses to save over settings changed meanwhile', async () => {
    const f = makeFixture();
    const dir = path.join(f.home, 'tool', 'skills');
    mkdirSync(dir, { recursive: true });
    const { id } = await f.service.addTarget({ skillDir: dir });
    f.hooks.afterRead = () => {
      const cfg = readConfig(f);
      (cfg['integrations'] as Record<string, unknown>[])[0]!['label'] =
        'Renamed elsewhere';
      writeFileSync(f.configFile, JSON.stringify(cfg));
    };
    await expectSkillsError(
      f.service.runAction(id, 'install'),
      'conflict',
      'changed meanwhile',
    );
    expect(
      (readConfig(f)['integrations'] as Record<string, unknown>[])[0]!['label'],
    ).toBe('Renamed elsewhere');
  });

  it('round-trips a stored entry', () => {
    const entry = {
      id: 'abcd1234',
      label: 'Tool',
      skillDir: 'C:\\tools\\skills',
      instructionFile: 'C:\\tools\\AGENTS.md',
      instructionBlock: true,
      enabled: false,
      source: 'detected',
      addedAt: 'a',
      version: 2,
      sha256: 's',
      installedAt: 'i',
      kept: 'k',
      instructionSha256: 'is',
      legacySha256: 'ls',
      other: { x: 1 },
    };
    const [t] = parseTargets([entry], paths);
    expect(serializeTarget(t!)).toEqual(entry);
    expect(JSON.stringify(serializeTarget(t!))).toBe(JSON.stringify(entry));
  });
});

describe('idempotent actions and backups', () => {
  it('repeats an action without writing again, and backs up before every write', async () => {
    const f = makeFixture();
    const s = f.service;
    const dir = path.join(f.home, 'tool', 'skills');
    const instructions = path.join(f.home, 'tool', 'AGENTS.md');
    put(instructions, '# Owner\n');
    const { id } = await s.addTarget({
      skillDir: dir,
      instructionFile: instructions,
    });
    await s.runAction(id, 'install');
    await s.runAction(id, 'instructions-on');
    const skillAfter = read(skillFileOf(dir));
    const instructionsAfter = read(instructions);
    const backupsAfter = backupFiles(f.data);
    expect(
      backupsAfter,
      'the owner instruction file was backed up',
    ).toHaveLength(1);
    expect(read(backupsAfter[0]!)).toBe('# Owner\n');
    expect(backupsAfter[0]!.replaceAll('\\', '/')).toMatch(
      /backups\/integrations\/\d{8}-\d{6}\.\d{3}\/tool\/AGENTS\.md$/,
    );

    await s.runAction(id, 'install');
    await s.runAction(id, 'instructions-on');
    expect(read(skillFileOf(dir))).toBe(skillAfter);
    expect(read(instructions)).toBe(instructionsAfter);
    expect(
      backupFiles(f.data),
      'a repeat writes nothing, so it backs nothing up',
    ).toEqual(backupsAfter);

    // Each action gets its own backup folder, also within one millisecond.
    const frozen = makeFixture({
      now: () => new Date('2026-11-10T10:00:00.000Z'),
    });
    const d2 = path.join(frozen.home, 'skills');
    mkdirSync(d2);
    const id2 = (await frozen.service.addTarget({ skillDir: d2 })).id;
    await frozen.service.runAction(id2, 'install');
    put(skillFileOf(d2), 'mine 1');
    await frozen.service.runAction(id2, 'replace');
    put(skillFileOf(d2), 'mine 2');
    await frozen.service.runAction(id2, 'replace');
    expect(backupFiles(frozen.data).map(read).sort()).toEqual([
      'mine 1',
      'mine 2',
    ]);
    await frozen.service.runAction(id2, 'remove');
    expect(backupFiles(frozen.data).map(read).sort()).toEqual([
      skillText,
      'mine 1',
      'mine 2',
    ]);
  });

  it('treats a CRLF copy of the skill as installed and an unreadable file as modified', async () => {
    const f = makeFixture();
    const dir = path.join(f.home, 'skills');
    mkdirSync(dir);
    const { id } = await f.service.addTarget({ skillDir: dir });
    put(skillFileOf(dir), skillText.replaceAll('\n', '\r\n'));
    expect((await f.service.listTargets()).targets[0]).toMatchObject({
      state: 'installed',
      installedVersion: 4,
    });
    // A SKILL.md that is itself a link (here a junction) is never edited.
    const elsewhere = path.join(f.home, 'elsewhere');
    mkdirSync(elsewhere);
    const file = skillFileOf(dir);
    (await import('node:fs')).rmSync(file);
    if (!junction(file, elsewhere)) {
      return;
    }
    expect((await f.service.listTargets()).targets[0]).toMatchObject({
      state: 'modified',
    });
    await expectSkillsError(
      f.service.runAction(id, 'replace'),
      'conflict',
      'is a link',
    );
    await expectSkillsError(
      f.service.runAction(id, 'keep'),
      'conflict',
      'could not be read',
    );
    await expectSkillsError(f.service.diffTarget(id), 'conflict', 'is a link');
  });

  it('refreshes an outdated reminder in place and keeps text around it', async () => {
    const f = makeFixture();
    const file = path.join(f.home, 'tool', 'AGENTS.md');
    const oldBlock = `${INSTRUCTION_START}\nAn older reminder.\n${INSTRUCTION_END}`;
    // Bytes that are not valid UTF-8 outside the markers must survive exactly.
    const before = Buffer.concat([
      Buffer.from('# Owner \xe9\n', 'latin1'),
      Buffer.from(`${oldBlock}\nAfter.\n`),
    ]);
    put(file, before);
    const { id } = await f.service.addTarget({
      skillDir: path.join(f.home, 'tool', 'skills'),
      instructionFile: file,
    });
    const cfg = readConfig(f);
    const t = (cfg['integrations'] as Record<string, unknown>[])[0]!;
    t['instructionBlock'] = true;
    t['instructionSha256'] = (await import('node:crypto'))
      .createHash('sha256')
      .update(oldBlock)
      .digest('hex');
    writeFileSync(f.configFile, JSON.stringify(cfg));
    expect((await f.service.listTargets()).targets[0]!.instructions.state).toBe(
      'outdated',
    );
    await f.service.runAction(id, 'instructions-on');
    const after = readFileSync(file);
    expect(
      after.equals(
        Buffer.concat([
          Buffer.from('# Owner \xe9\n', 'latin1'),
          Buffer.from(`${instructionBlock()}\nAfter.\n`),
        ]),
      ),
    ).toBe(true);
    await f.service.runAction(id, 'instructions-off');
    expect(
      readFileSync(file).equals(
        Buffer.concat([
          Buffer.from('# Owner \xe9\n', 'latin1'),
          Buffer.from('After.\n'),
        ]),
      ),
    ).toBe(true);
  });

  it('removes a file that held only the block Agent Ops wrote', async () => {
    const f = makeFixture();
    const file = path.join(f.home, 'tool', 'GEMINI.md');
    mkdirSync(path.dirname(file), { recursive: true });
    const { id } = await f.service.addTarget({
      skillDir: path.join(f.home, 'tool', 'skills'),
      instructionFile: file,
    });
    await f.service.runAction(id, 'instructions-on');
    expect(read(file)).toBe(`${instructionBlock()}\n`);
    await f.service.runAction(id, 'instructions-off');
    expect(exists(file)).toBe(false);
  });
});

describe('markers', () => {
  it('finds exactly one complete block', () => {
    const block = instructionBlock();
    expect(findBlock('no block', INSTRUCTION_START, INSTRUCTION_END)).toEqual({
      start: -1,
      end: -1,
      found: false,
      ok: true,
    });
    expect(
      findBlock(`a\n${block}\nb`, INSTRUCTION_START, INSTRUCTION_END),
    ).toEqual({ start: 2, end: 2 + block.length, found: true, ok: true });
    for (const broken of [
      `${INSTRUCTION_START} only`,
      `${INSTRUCTION_END} only`,
      `${INSTRUCTION_END}\n${INSTRUCTION_START}`,
      `${block}\n${block}`,
    ]) {
      expect(
        findBlock(broken, INSTRUCTION_START, INSTRUCTION_END),
      ).toMatchObject({ found: true, ok: false });
    }
  });

  it('removes only the block and the separator it added', () => {
    const block = instructionBlock();
    const at = (text: string): string => {
      const b = findBlock(text, INSTRUCTION_START, INSTRUCTION_END);
      return removeBlock(text, b.start, b.end);
    };
    expect(at(`# Owner\n\n${block}\n`)).toBe('# Owner\n');
    expect(at(`# Owner\r\n\r\n${block}\r\n`)).toBe('# Owner\r\n');
    expect(at(`top\n${block}\nbottom\n`)).toBe('top\nbottom\n');
    expect(at(`${block}\n`)).toBe('');
    expect(at(`keep  \n\n\n${block}`)).toBe('keep  \n');
  });

  it('reports a half-removed block as edited by hand', async () => {
    const f = makeFixture();
    const file = path.join(f.home, 'tool', 'AGENTS.md');
    put(file, `# Owner\n${INSTRUCTION_START}\n`);
    const { id } = await f.service.addTarget({
      skillDir: path.join(f.home, 'tool', 'skills'),
      instructionFile: file,
    });
    expect((await f.service.listTargets()).targets[0]!.instructions.state).toBe(
      'modified',
    );
    await expectSkillsError(
      f.service.runAction(id, 'instructions-on'),
      'conflict',
      'changed by hand',
    );
    expect(read(file)).toBe(`# Owner\n${INSTRUCTION_START}\n`);
  });
});

describe('helpers', () => {
  it('reads the skill version from the front matter only', () => {
    expect(skillVersionOf(Buffer.from(skillText))).toBe(4);
    expect(
      skillVersionOf(
        Buffer.from('---\r\nname: x\r\nagent-ops-skill: 7\r\n---\r\n'),
      ),
    ).toBe(7);
    expect(
      skillVersionOf(Buffer.from('# no front matter\nagent-ops-skill: 4\n')),
    ).toBe(0);
    expect(
      skillVersionOf(Buffer.from('---\nname: x\n---\nagent-ops-skill: 4\n')),
    ).toBe(0);
  });

  it('diffs lines', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nc\nd\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('x\r\n', 'x\n')).toEqual([{ op: ' ', text: 'x' }]);
  });

  it('cleans pasted paths', () => {
    expect(cleanInputPath('  "C:\\Tools\\skills\\"  ')).toBe(
      'C:\\Tools\\skills',
    );
    expect(cleanInputPath('C:/Tools/skills')).toBe('C:\\Tools\\skills');
    expect(cleanInputPath('C:\\')).toBe('C:\\');
    for (const bad of [
      '',
      'skills',
      'C:skills',
      '\\\\server\\share',
      '\\\\?\\C:\\x',
      '//server/x',
    ]) {
      expect(cleanInputPath(bad), bad).toBeNull();
    }
  });

  it('names folders and makes stable ids', () => {
    expect(defaultLabel('C:\\Users\\me\\.codex\\skills')).toBe('codex');
    expect(defaultLabel('C:\\tools\\my-skills')).toBe('my-skills');
    expect(defaultLabel('C:\\skills')).toBe('C:\\skills');
    expect(targetIdFor('C:\\Tools\\Skills\\')).toBe(
      targetIdFor('c:\\tools\\skills'),
    );
    // Matches projectIDFor of the baseline: sha256 of the lower-case cleaned path.
    expect(targetIdFor('C:\\x')).toBe(
      createHash('sha256').update('c:\\x').digest('hex').slice(0, 8),
    );
  });

  it('retries while a file is held, then gives up', async () => {
    let calls = 0;
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    expect(
      await retryBusy(async () => {
        calls++;
        if (calls < 3) {
          throw busy;
        }
        return 'done';
      }, 1000),
    ).toBe('done');
    expect(calls).toBe(3);
    await expect(retryBusy(async () => Promise.reject(busy), 30)).rejects.toBe(
      busy,
    );
    const other = Object.assign(new Error('gone'), { code: 'ENOENT' });
    calls = 0;
    await expect(
      retryBusy(async () => {
        calls++;
        throw other;
      }, 1000),
    ).rejects.toBe(other);
    expect(calls).toBe(1);
  });

  it('guards client file writes', async () => {
    const f = makeFixture();
    const files = new ClientFiles(platform);
    const file = path.join(f.home, 'x', 'notes.md');
    const backups = path.join(f.data, 'b');
    expect(await files.read(file)).toBeNull();
    expect(
      await files.write(file, null, Buffer.from('one'), f.home, backups),
    ).toBe('');
    await expect(
      files.write(file, null, Buffer.from('two'), f.home, backups),
    ).rejects.toBeInstanceOf(FileChangedError);
    const saved = await files.write(
      file,
      Buffer.from('one'),
      Buffer.from('two'),
      f.home,
      backups,
    );
    expect(saved).toBe(path.join(backups, 'x', 'notes.md'));
    expect(read(saved)).toBe('one');
    expect(read(file)).toBe('two');
    // A file outside the home folder is backed up under its full path without the colon.
    const outside = path.join(f.root, 'out.md');
    put(outside, 'out');
    const outSaved = await files.write(
      outside,
      Buffer.from('out'),
      null,
      f.home,
      backups,
    );
    expect(outSaved).toBe(path.join(backups, outside.replace(':', '')));
    expect(exists(outside)).toBe(false);
    const dirLink = path.join(f.home, 'link.md');
    if (junction(dirLink, f.data)) {
      await expect(files.read(dirLink)).rejects.toBeInstanceOf(FileLinkedError);
    }
  });
});
