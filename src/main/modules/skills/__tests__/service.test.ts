// Port of integrations_test.go: the list, the actions and their safety rules.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { skillFileOf } from '../targets.js';
import {
  contentHash,
  INSTRUCTION_END,
  INSTRUCTION_LINE,
  INSTRUCTION_START,
} from '../text.js';
import type { SkillsOverview, TargetStatus } from '../types.js';
import {
  exists,
  expectSkillsError,
  fixture,
  junction,
  makeFixture,
  put,
  read,
  readConfig,
  skillText,
} from './helpers.js';

function byId(o: SkillsOverview, id: string): TargetStatus {
  const t = o.targets.find((x) => x.id === id);
  if (!t) {
    throw new Error(`target ${id} not listed`);
  }
  return t;
}

function storedTargets(
  f: ReturnType<typeof makeFixture>,
): Record<string, unknown>[] {
  return (readConfig(f)['integrations'] ?? []) as Record<string, unknown>[];
}

/** Every file below dir, relative, with forward slashes. */
function filesBelow(dir: string): string[] {
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
    .map((d) =>
      path.relative(dir, path.join(d.parentPath, d.name)).replaceAll('\\', '/'),
    );
}

describe('Skills list and actions', () => {
  it('only suggests, and manages the skill per folder', async () => {
    const f = makeFixture();
    const s = f.service;
    let state = await s.listTargets();
    expect(state.targets).toEqual([]);
    expect(await s.suggestTargets()).toEqual([]);
    expect(state.skillVersion).toBe(3);

    mkdirSync(path.join(f.home, '.claude'));
    mkdirSync(path.join(f.home, '.codex'));
    const suggestions = await s.suggestTargets();
    expect(suggestions).toHaveLength(2);
    const claude = suggestions[0]!;
    expect(claude).toEqual({
      client: 'claude',
      label: 'Claude Code',
      skillDir: path.join(f.home, '.claude', 'skills'),
      instructionFile: path.join(f.home, '.claude', 'CLAUDE.md'),
    });
    expect(suggestions[1]).toMatchObject({
      skillDir: path.join(f.home, '.agents', 'skills'),
      instructionFile: path.join(f.home, '.codex', 'AGENTS.md'),
    });
    expect(exists(f.configFile), 'detection wrote config').toBe(false);

    const { id } = await s.addTarget({
      skillDir: claude.skillDir,
      instructionFile: claude.instructionFile!,
    });
    state = await s.listTargets();
    let t = byId(state, id);
    expect(t).toMatchObject({
      source: 'detected',
      label: 'Claude Code',
      enabled: true,
      state: 'not-installed',
      stateText: 'Not installed',
    });
    expect(t.instructions.state).toBe('off');
    expect(await s.suggestTargets()).toHaveLength(1);

    await s.runAction(id, 'install');
    const skill = path.join(
      f.home,
      '.claude',
      'skills',
      'task-plan',
      'SKILL.md',
    );
    expect(read(skill)).toBe(skillText);
    t = byId(await s.listTargets(), id);
    expect(t).toMatchObject({
      state: 'installed',
      installedVersion: 3,
      stateText: 'Installed v3',
    });
    const stored = storedTargets(f);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      sha256: contentHash(Buffer.from(skillText)),
      version: 3,
    });
    expect(stored[0]!['installedAt']).toMatch(
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
    );

    // A file Agent Ops wrote for an older skill version shows Update available.
    const older = fixture('task-plan-v1.md');
    put(skill, older);
    const cfg = readConfig(f);
    (cfg['integrations'] as Record<string, unknown>[])[0]!['sha256'] =
      contentHash(Buffer.from(older));
    (cfg['integrations'] as Record<string, unknown>[])[0]!['version'] = 1;
    writeFileSync(f.configFile, JSON.stringify(cfg));
    t = byId(await s.listTargets(), id);
    expect(t).toMatchObject({
      state: 'update-available',
      installedVersion: 1,
      stateText: 'Update available (v1 installed)',
    });
    await s.runAction(id, 'update');
    expect(read(skill)).toBe(skillText);

    // An owner edit is Modified locally: install, update and remove refuse; keep records it.
    const edited = `${skillText}\n## Owner\n`;
    put(skill, edited);
    t = byId(await s.listTargets(), id);
    expect(t).toMatchObject({
      state: 'modified',
      kept: false,
      stateText: 'Modified locally',
    });
    for (const action of ['install', 'update', 'remove'] as const) {
      await expectSkillsError(s.runAction(id, action), 'conflict', 'View diff');
      expect(read(skill), `${action} overwrote an owner edit`).toBe(edited);
    }
    const diff = await s.diffTarget(id);
    expect(diff.identical).toBe(false);
    expect(diff.path).toBe(skill);
    expect(diff.lines).toContainEqual({ op: '-', text: '## Owner' });
    await s.runAction(id, 'keep');
    expect(byId(await s.listTargets(), id)).toMatchObject({
      kept: true,
      stateText: 'Modified locally (kept)',
    });
    await s.runAction(id, 'replace');
    expect(read(skill)).toBe(skillText);
    const backups = path.join(f.data, 'backups', 'integrations');
    const saved = filesBelow(backups).filter((p) =>
      p.endsWith('.claude/skills/task-plan/SKILL.md'),
    );
    expect(
      saved.some((p) => read(path.join(backups, p)) === edited),
      'replace kept no backup of the owner file',
    ).toBe(true);
    expect((await s.diffTarget(id)).identical).toBe(true);

    await s.runAction(id, 'remove');
    expect(exists(skill)).toBe(false);
    expect(
      exists(path.dirname(skill)),
      'the empty task-plan folder stays',
    ).toBe(false);
    expect(
      byId(await s.listTargets(), id),
      'Remove skill keeps the folder listed',
    ).toMatchObject({ state: 'not-installed' });

    await expectSkillsError(s.runAction('nobody', 'install'), 'not-found');
    await expectSkillsError(
      s.runAction(id, 'format-disk' as 'install'),
      'not-found',
      'Unknown action',
    );
    await expectSkillsError(s.runAction('../x', 'install'), 'not-found');
    await expectSkillsError(s.diffTarget('nobody'), 'not-found');
  });

  it('adds the instruction block only on request and never touches the owner text', async () => {
    const f = makeFixture();
    const s = f.service;
    const file = path.join(f.home, 'tool', 'AGENTS.md');
    const owner = '# Owner notes\r\n\r\nKeep this text exactly as it is.\r\n';
    put(file, owner);
    const { id } = await s.addTarget({
      skillDir: path.join(f.home, 'tool', 'skills'),
      instructionFile: file,
    });
    let t = byId(await s.listTargets(), id);
    expect(t).toMatchObject({ source: 'custom', label: 'tool' });
    expect(t.instructions.state).toBe('off');

    await s.runAction(id, 'instructions-on');
    const got = read(file);
    expect(got.startsWith(owner)).toBe(true);
    expect(got).toContain(INSTRUCTION_LINE);
    expect(got.split('\n').length - 1, 'line endings follow the file').toBe(
      got.split('\r\n').length - 1,
    );
    expect(byId(await s.listTargets(), id).instructions.state).toBe('on');
    expect(storedTargets(f)[0]!['instructionBlock']).toBe(true);

    await s.runAction(id, 'instructions-on');
    expect(read(file), 'a second enable changed the file').toBe(got);

    // The instruction file cannot move while the reminder is in it.
    await expectSkillsError(
      s.updateTarget(id, {
        instructionFile: path.join(f.home, 'tool', 'OTHER.md'),
      }),
      'conflict',
      'reminder off',
    );

    await s.runAction(id, 'instructions-off');
    expect(read(file)).toBe(owner);

    // An edited block is left for the owner.
    put(
      file,
      `${owner}\r\n${INSTRUCTION_START}\r\nmy own words\r\n${INSTRUCTION_END}\r\n`,
    );
    expect(byId(await s.listTargets(), id).instructions.state).toBe('modified');
    await expectSkillsError(
      s.runAction(id, 'instructions-off'),
      'conflict',
      'changed by hand',
    );
    expect(read(file)).toContain('my own words');

    // Without an instruction file there is nothing to toggle.
    await s.updateTarget(id, { instructionFile: '' });
    t = byId(await s.listTargets(), id);
    expect(t.instructions.state).toBe('none');
    expect(t.instructionFile).toBe('');
    await expectSkillsError(
      s.runAction(id, 'instructions-on'),
      'conflict',
      'Choose an instruction file',
    );
  });

  it('validates paths, links, workspaces and duplicates when adding', async () => {
    const f = makeFixture();
    const s = f.service;
    const project = path.join(f.home, 'repos', 'web');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    f.workspaces.push({ name: 'web', path: project });
    const existing = path.join(f.home, 'client', 'skills');
    mkdirSync(existing, { recursive: true });
    put(path.join(f.home, 'client', 'notes.txt'), 'x');
    mkdirSync(path.join(f.home, 'client', 'rules.md'));
    const { id } = await s.addTarget({
      skillDir: `"${existing.toUpperCase()}"`,
      label: '  My client  ',
    });
    expect(byId(await s.listTargets(), id)).toMatchObject({
      label: 'My client',
      source: 'custom',
      state: 'not-installed',
    });

    const newDir = path.join(f.home, 'client', 'new');
    const cases: [string, Parameters<typeof s.addTarget>[0], string][] = [
      ['relative', { skillDir: 'client\\skills' }, 'full folder path'],
      [
        'no parent',
        { skillDir: path.join(f.home, 'nope', 'skills') },
        'Neither this folder',
      ],
      [
        'a file',
        { skillDir: path.join(f.home, 'client', 'notes.txt') },
        'is a file',
      ],
      [
        'duplicate',
        { skillDir: `${existing}\\` },
        'already in the list as “My client”',
      ],
      [
        'inside a workspace',
        { skillDir: path.join(project, '.claude', 'skills') },
        'inside the workspace “web”',
      ],
      ['empty', {}, 'Choose a skills folder'],
      ['bad label', { skillDir: newDir, label: 'x'.repeat(81) }, '1 to 80'],
      ['control label', { skillDir: newDir, label: 'a\u0007b' }, '1 to 80'],
      [
        'instruction dir',
        {
          skillDir: newDir,
          instructionFile: path.join(f.home, 'client', 'rules.md'),
        },
        'is a folder',
      ],
      [
        'instruction gone',
        {
          skillDir: newDir,
          instructionFile: path.join(f.home, 'gone', 'AGENTS.md'),
        },
        'does not exist',
      ],
      [
        'instruction in workspace',
        { skillDir: newDir, instructionFile: path.join(project, 'AGENTS.md') },
        'inside the workspace',
      ],
    ];
    for (const [name, body, want] of cases) {
      const err = await expectSkillsError(s.addTarget(body), 'invalid-input');
      expect(err.message, name).toContain(want);
    }
    await expectSkillsError(
      s.addTarget({ skillDir: existing, unknown: 1 } as never),
      'invalid-input',
      'Unknown field',
    );
    await expectSkillsError(
      s.addTarget({ skillDir: 5 } as never),
      'invalid-input',
      'must be text',
    );

    // A junction to a listed folder is the same place.
    const link = path.join(f.home, 'linked-skills');
    if (junction(link, existing)) {
      await expectSkillsError(
        s.addTarget({ skillDir: link }),
        'invalid-input',
        'already in the list',
      );
      await s.addTarget({ skillDir: path.join(link, 'sub') }); // a new folder below a junction is a different folder
      expect(storedTargets(f)).toHaveLength(2);
    }
  });

  it('edits, turns off and removes folders', async () => {
    const f = makeFixture();
    const s = f.service;
    const first = path.join(f.home, 'a', 'skills');
    mkdirSync(path.dirname(first), { recursive: true });
    const { id } = await s.addTarget({ skillDir: first });
    await s.runAction(id, 'install');

    // Turned off: no file action, state still shown.
    await s.updateTarget(id, { enabled: false });
    expect(byId(await s.listTargets(), id)).toMatchObject({
      enabled: false,
      state: 'installed',
    });
    await expectSkillsError(
      s.runAction(id, 'replace'),
      'conflict',
      'turned off',
    );
    expect(exists(skillFileOf(first))).toBe(true);
    await s.updateTarget(id, { enabled: true });

    // Edit path: hashes are content hashes, so a moved copy is still recognised.
    const moved = path.join(f.home, 'b', 'skills');
    const partial = skillText.slice(0, 40);
    put(skillFileOf(moved), partial);
    const cfg = readConfig(f);
    (cfg['integrations'] as Record<string, unknown>[])[0]!['sha256'] =
      contentHash(Buffer.from(partial));
    writeFileSync(f.configFile, JSON.stringify(cfg));
    await s.updateTarget(id, { skillDir: moved, label: 'Moved' });
    expect(byId(await s.listTargets(), id)).toMatchObject({
      skillDir: moved,
      label: 'Moved',
      state: 'update-available',
    });
    await expectSkillsError(
      s.updateTarget(id, { label: '' }),
      'invalid-input',
      '1 to 80',
    );

    // Missing folder: neither the folder nor its parent exists any more.
    rmSync(path.join(f.home, 'b'), { recursive: true });
    expect(byId(await s.listTargets(), id)).toMatchObject({
      state: 'missing-folder',
      stateText: 'Missing folder',
    });
    await expectSkillsError(
      s.runAction(id, 'install'),
      'conflict',
      'does not exist',
    );

    // Remove from the list leaves files alone.
    const second = (await s.addTarget({ skillDir: `${first}2` })).id;
    await s.runAction(second, 'install');
    await s.removeTarget(second);
    expect(exists(skillFileOf(`${first}2`))).toBe(true);
    expect((await s.listTargets()).targets.map((t) => t.id)).toEqual([id]);
    await expectSkillsError(
      s.removeTarget(second),
      'not-found',
      'no longer in the list',
    );

    // While the app restarts for an update, changes are refused.
    f.restarting.value = true;
    await expectSkillsError(
      s.addTarget({ skillDir: `${first}3` }),
      'unavailable',
      'restarting',
    );
  });

  it('writes against the exact bytes it checked', async () => {
    const f = makeFixture();
    const s = f.service;
    const dir = path.join(f.home, 'tool', 'skills');
    const instructions = path.join(f.home, 'tool', 'AGENTS.md');
    put(instructions, '# Owner\n');
    const { id } = await s.addTarget({
      skillDir: dir,
      instructionFile: instructions,
    });
    f.hooks.afterRead = (file) => {
      if (file === skillFileOf(dir)) {
        put(file, 'owner skill written meanwhile');
      }
      if (file === instructions) {
        put(file, '# Owner\nedited meanwhile\n');
      }
    };
    await expectSkillsError(
      s.runAction(id, 'install'),
      'conflict',
      'changed while Agent Ops was editing',
    );
    expect(read(skillFileOf(dir))).toBe('owner skill written meanwhile');
    await expectSkillsError(
      s.runAction(id, 'instructions-on'),
      'conflict',
      'changed while Agent Ops was editing',
    );
    expect(read(instructions)).toBe('# Owner\nedited meanwhile\n');
    expect(storedTargets(f)[0]).not.toHaveProperty('sha256');
  });

  it('re-checks the file right before the final rename or delete', async () => {
    const f = makeFixture();
    const s = f.service;
    const dir = path.join(f.home, 'tool', 'skills');
    mkdirSync(dir, { recursive: true });
    const { id } = await s.addTarget({ skillDir: dir });
    const file = skillFileOf(dir);
    f.hooks.beforeReplace = (target) => {
      if (target === file) {
        put(target, 'written by the AI tool at the last moment');
      }
    };
    await expectSkillsError(
      s.runAction(id, 'install'),
      'conflict',
      'nothing was written',
    );
    expect(read(file)).toBe('written by the AI tool at the last moment');
    expect(
      readdirSync(path.dirname(file)),
      'no temporary file is left',
    ).toEqual(['SKILL.md']);

    // The same guard before a delete.
    delete f.hooks.beforeReplace;
    put(file, skillText);
    f.hooks.beforeReplace = (target) => {
      if (target === file) {
        put(target, `${skillText}late edit`);
      }
    };
    await expectSkillsError(
      s.runAction(id, 'remove'),
      'conflict',
      'nothing was written',
    );
    expect(read(file)).toBe(`${skillText}late edit`);
  });

  it('lets a turned-off folder be cleaned up before removal', async () => {
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
    await s.updateTarget(id, { enabled: false });
    await expectSkillsError(s.removeTarget(id), 'conflict', 'reminder off');
    await expectSkillsError(
      s.runAction(id, 'instructions-on'),
      'conflict',
      'turned off',
    );
    await s.runAction(id, 'instructions-off');
    await s.runAction(id, 'remove');
    expect(read(instructions)).toBe('# Owner\n');
    expect(exists(skillFileOf(dir))).toBe(false);
    await s.removeTarget(id);
    expect(readConfig(f)).not.toHaveProperty('integrations');
    expect(readConfig(f)['integrationsSeeded']).toBe(true);
  });

  it('never writes through a task-plan folder linked into a workspace', async () => {
    const f = makeFixture();
    const s = f.service;
    const project = path.join(f.home, 'repos', 'web');
    const repoSkill = path.join(project, 'skills', 'task-plan');
    put(path.join(repoSkill, 'SKILL.md'), skillText);
    f.workspaces.push({ name: 'web', path: project });
    const linked = path.join(f.home, 'client', 'skills');
    if (!junction(path.join(linked, 'task-plan'), repoSkill)) {
      return;
    }
    await expectSkillsError(
      s.addTarget({ skillDir: linked }),
      'invalid-input',
      'inside the workspace “web”',
    );
    const plain = path.join(f.home, 'other', 'skills');
    mkdirSync(plain, { recursive: true });
    const { id } = await s.addTarget({ skillDir: plain });
    junction(path.join(plain, 'task-plan'), repoSkill); // the junction can appear later
    for (const action of ['replace', 'remove'] as const) {
      await expectSkillsError(
        s.runAction(id, action),
        'conflict',
        'edit the skill at its source',
      );
    }
    expect(read(path.join(repoSkill, 'SKILL.md'))).toBe(skillText);
  });

  it('applies the instruction file and path rules', async () => {
    const f = makeFixture();
    const s = f.service;
    const shared = path.join(f.home, 'tool', 'AGENTS.md');
    put(shared, '# Owner\n');
    put(path.join(f.home, 'tool', 'settings.json'), '{}');
    const first = (
      await s.addTarget({
        skillDir: path.join(f.home, 'tool', 'a'),
        instructionFile: shared,
      })
    ).id;
    const second = (
      await s.addTarget({ skillDir: path.join(f.home, 'tool', 'b') })
    ).id;
    const c = path.join(f.home, 'tool', 'c');
    const cases: [string, Parameters<typeof s.addTarget>[0], string][] = [
      [
        'json file',
        {
          skillDir: c,
          instructionFile: path.join(f.home, 'tool', 'settings.json'),
        },
        'Markdown',
      ],
      [
        'script',
        { skillDir: c, instructionFile: path.join(f.home, 'tool', 'run.ps1') },
        'Markdown',
      ],
      [
        'shared file',
        { skillDir: c, instructionFile: shared.toUpperCase() },
        'already used by',
      ],
      ['device', { skillDir: '\\\\.\\pipe\\x' }, 'on this computer'],
      ['long device', { skillDir: `\\\\?\\${c}` }, 'on this computer'],
      [
        'network',
        { skillDir: '\\\\server\\share\\skills' },
        'on this computer',
      ],
      [
        'network forward',
        { skillDir: '//server/share/skills' },
        'on this computer',
      ],
      ['drive relative', { skillDir: 'C:skills' }, 'on this computer'],
      ['root relative', { skillDir: '\\skills' }, 'on this computer'],
      ['NUL', { skillDir: `${c}\0x` }, 'on this computer'],
    ];
    for (const [name, body, want] of cases) {
      const err = await expectSkillsError(s.addTarget(body), 'invalid-input');
      expect(err.message, name).toContain(want);
    }
    await expectSkillsError(
      s.updateTarget(second, { instructionFile: shared }),
      'invalid-input',
      'already used by',
    );
    await s.updateTarget(first, { instructionFile: shared, label: 'Same' }); // its own file is fine
  });

  it('refuses an instruction file that is a link', async () => {
    const f = makeFixture();
    const target = path.join(f.home, 'real', 'AGENTS.md');
    put(target, '# Owner\n');
    const link = path.join(f.home, 'tool', 'AGENTS.md');
    mkdirSync(path.dirname(link), { recursive: true });
    try {
      (await import('node:fs')).symlinkSync(target, link, 'file');
    } catch {
      return; // file symbolic links need Developer Mode or admin rights on Windows
    }
    await expectSkillsError(
      f.service.addTarget({
        skillDir: path.join(f.home, 'tool', 'skills'),
        instructionFile: link,
      }),
      'invalid-input',
      'is a link',
    );
  });
});
