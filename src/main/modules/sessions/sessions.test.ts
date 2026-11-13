import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { put, tempDir } from '../../lib/safe-io/test-helpers';
import {
  CLAUDE_HOOK_MARKER,
  HOOK_SPECS,
  syncClaudeHooks,
  withHooks,
} from './claude-settings';
import { startContext, workspaceOf } from './context';
import { runHandoff } from './handoff';
import { autoHandoffText, handleHook, runHook, taskTodos } from './hook';
import { readSessions } from './read';
import { readSession, SESSIONS_DIR_NAME } from './store';

const SESSION = '11111111-2222-3333-4444-555555555555';
const NEXT = '66666666-7777-8888-9999-000000000000';

function setup() {
  const root = tempDir();
  const data = path.join(root, 'data');
  const tasks = path.join(root, 'tasks');
  const repo = path.join(root, 'agent-ops');
  const worktree = path.join(root, 'wt', 'ops-A');
  put(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(path.join(repo, '.git', 'worktrees', 'ops-A', 'commondir'), '../..\n');
  put(
    path.join(worktree, '.git'),
    `gitdir: ${path.join(repo, '.git', 'worktrees', 'ops-A')}\n`,
  );
  put(
    path.join(tasks, 'agent-ops', 'feature.md'),
    [
      'Next: Build the page',
      'Status: Implementing',
      '## M1: Build',
      '- [done] Reader',
      '- [doing] Page',
      '',
    ].join('\n'),
  );
  put(
    path.join(tasks, 'agent-ops', 'old.md'),
    'Status: Done\n## M1: X\n- [done] Y\n',
  );
  put(
    path.join(data, 'config.json'),
    JSON.stringify({ version: 1, tasksDir: tasks, projects: [] }),
  );
  return {
    root,
    data,
    tasks,
    repo,
    worktree,
    dir: path.join(data, SESSIONS_DIR_NAME),
  };
}
let clock = Date.parse('2026-11-13T08:00:00Z');
const now = () => new Date((clock += 1000));
const hook = (data: string, event: Record<string, unknown>) =>
  handleHook({ session_id: SESSION, ...event }, { dataDir: data, now });

describe('workspaceOf', () => {
  it('names the main checkout from a worktree, and the folder outside Git', async () => {
    const s = setup();
    expect(await workspaceOf(path.join(s.worktree))).toBe('agent-ops');
    expect(await workspaceOf(s.repo)).toBe('agent-ops');
    expect(await workspaceOf(s.tasks)).toBe('tasks');
  });
});

describe('hook events', () => {
  it('records presence, todos and waiting, and shows them on the Sessions page', async () => {
    const s = setup();
    const cwd = s.worktree;
    expect(
      await hook(s.data, {
        hook_event_name: 'SessionStart',
        source: 'startup',
        cwd,
      }),
    ).toContain('feature.md');
    await hook(s.data, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Add  the\npage',
      cwd,
    });
    await hook(s.data, {
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'Write reader', status: 'completed', activeForm: 'x' },
          { content: 'Build page', status: 'in_progress', activeForm: 'x' },
        ],
      },
      cwd,
    });
    await hook(s.data, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
      cwd,
    });
    const { sessions } = await readSessions(s.dir, new Date(clock));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: 'Claude',
      workspace: 'agent-ops',
      state: 'waiting',
      waiting: 'Claude needs your permission to use Bash',
      lastPrompt: 'Add the page',
      todos: [
        { text: 'Write reader', state: 'completed' },
        { text: 'Build page', state: 'in_progress' },
      ],
    });
    await hook(s.data, { hook_event_name: 'Stop', cwd });
    expect(
      (await readSessions(s.dir, new Date(clock))).sessions[0]!.state,
    ).toBe('idle');
  });

  it('ignores subagent todos and unknown events', async () => {
    const s = setup();
    await hook(s.data, {
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      agent_id: 'sub',
      tool_input: { todos: [{ content: 'x', status: 'pending' }] },
      cwd: s.worktree,
    });
    await hook(s.data, { hook_event_name: 'Whatever', cwd: s.worktree });
    expect(await readSession(s.dir, SESSION)).toEqual([]);
  });

  it('saves an automatic handoff on clear and loads it once into the next session', async () => {
    const s = setup();
    const cwd = s.worktree;
    await hook(s.data, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Ship the sessions page',
      cwd,
    });
    await hook(s.data, {
      hook_event_name: 'PostToolUse',
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'Write tests', status: 'pending' }] },
      cwd,
    });
    await hook(s.data, { hook_event_name: 'SessionEnd', reason: 'clear', cwd });
    const out = await handleHook(
      {
        session_id: NEXT,
        hook_event_name: 'SessionStart',
        source: 'clear',
        cwd,
      },
      { dataDir: s.data, now },
    );
    const context = JSON.parse(out).hookSpecificOutput
      .additionalContext as string;
    expect(context).toContain('saved automatically');
    expect(context).toContain('- [todo] Write tests');
    expect(context).toContain('Ship the sessions page');
    expect(context).toContain('Next: Build the page');
    expect(context).not.toContain('old.md');
    const again = await handleHook(
      {
        session_id: NEXT,
        hook_event_name: 'SessionStart',
        source: 'clear',
        cwd,
      },
      { dataDir: s.data, now },
    );
    expect(again).not.toContain('Session handoff');
  });

  it("prefers the agent's own handoff and skips the automatic one", async () => {
    const s = setup();
    const cwd = s.worktree;
    expect(
      (
        await runHandoff(
          ['--agent', 'Claude', '--text', 'Done: reader.\nNext: page.'],
          { dataDir: s.data, cwd, now },
        )
      ).stdout,
    ).toBe('ok\n');
    await hook(s.data, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'x',
      cwd,
    });
    await hook(s.data, { hook_event_name: 'PreCompact', trigger: 'auto', cwd });
    const records = await readSession(s.dir, SESSION);
    expect(records.map((r) => r.kind)).toEqual(['prompt', 'compact']);
    const ctx = await startContext({
      dir: s.dir,
      cwd,
      source: 'compact',
      session: SESSION,
      tasksDir: '',
      now: new Date(clock),
    });
    expect(ctx.text).toContain('written by Claude');
    expect(ctx.text).toContain('Next: page.');
    const shown = await runHandoff(['--show'], { dataDir: s.data, cwd, now });
    expect(shown.stdout).toContain('Done: reader.');
  });

  it('does not load a handoff from another folder or on a plain start', async () => {
    const s = setup();
    await runHandoff(['--agent', 'Codex', '--text', 'note'], {
      dataDir: s.data,
      cwd: s.repo,
      now,
    });
    const other = await startContext({
      dir: s.dir,
      cwd: s.worktree,
      source: 'clear',
      session: NEXT,
      tasksDir: '',
      now: new Date(clock),
    });
    expect(other.text).toBe('');
    const startup = await startContext({
      dir: s.dir,
      cwd: s.repo,
      source: 'startup',
      session: NEXT,
      tasksDir: '',
      now: new Date(clock),
    });
    expect(startup.text).toBe('');
  });

  it('never fails the session on bad input', async () => {
    const s = setup();
    expect(await runHook('not json', { dataDir: s.data })).toMatchObject({
      code: 0,
      stdout: '',
    });
    expect(
      await runHook(
        JSON.stringify({
          session_id: '../x',
          cwd: s.repo,
          hook_event_name: 'Stop',
        }),
        {
          dataDir: s.data,
        },
      ),
    ).toMatchObject({ code: 0, stdout: '' });
  });
});

describe('task tools', () => {
  it('rebuilds the list from TaskCreate and TaskUpdate', () => {
    let list = taskTodos(
      [],
      'TaskCreate',
      { subject: 'A' },
      { task: { id: '1', subject: 'A' } },
    )!;
    list = taskTodos(
      list,
      'TaskCreate',
      { subject: 'B' },
      JSON.stringify({ task: { id: '2' } }),
    )!;
    list = taskTodos(
      list,
      'TaskUpdate',
      { taskId: '1', status: 'completed' },
      {},
    )!;
    list = taskTodos(
      list,
      'TaskUpdate',
      { taskId: '2', status: 'deleted' },
      {},
    )!;
    expect(list).toEqual([{ text: 'A', state: 'completed', id: '1' }]);
  });
  it('writes no automatic note when nothing is open', () => {
    expect(autoHandoffText([])).toBe('');
  });
});

describe('handoff command', () => {
  it('checks its arguments', async () => {
    const s = setup();
    const run = (...args: string[]) =>
      runHandoff(args, { dataDir: s.data, cwd: s.repo, now });
    expect((await run('--text', 'x')).code).toBe(1);
    expect((await run('--agent', 'Claude')).code).toBe(1);
    expect(
      (await run('--agent', 'Claude', '--text', 'x', '--cwd', 'relative')).code,
    ).toBe(1);
    expect(
      (await run('--agent', 'Claude', '--text', 'x'.repeat(8001))).code,
    ).toBe(1);
    expect((await run('--bogus')).code).toBe(1);
  });
});

describe('Claude Code settings', () => {
  const exe = 'C:\\Programs\\AgentOps\\agent-ops.exe';
  it("adds its hooks beside the owner's and removes only its own", () => {
    const owner = {
      model: 'opus',
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'orca.exe claude' }] },
        ],
      },
    };
    const added = withHooks(owner, exe);
    const start = (added.hooks as Record<string, unknown[]>).SessionStart!;
    expect(start).toHaveLength(2);
    expect(JSON.stringify(start[1])).toContain(CLAUDE_HOOK_MARKER);
    expect(Object.keys(added.hooks as object)).toHaveLength(HOOK_SPECS.length);
    expect(withHooks(added, exe)).toEqual(added);
    expect(withHooks(added, null)).toEqual(owner);
    expect(withHooks({ model: 'x' }, null)).toEqual({ model: 'x' });
  });

  it('keeps every settings file, backs it up and leaves invalid ones alone', async () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const roaming = path.join(root, 'roaming');
    const data = path.join(root, 'data');
    const user = put(
      path.join(home, '.claude', 'settings.json'),
      '{"theme":"dark"}',
    );
    const profile = put(
      path.join(
        roaming,
        'orca',
        'claude-profiles',
        'p1',
        'home',
        'settings.json',
      ),
      '{"hooks":{}}',
    );
    const broken = put(
      path.join(
        roaming,
        'orca',
        'claude-profiles',
        'p2',
        'home',
        'settings.json',
      ),
      '{ not json',
    );
    const o = { dataDir: data, homeDir: home, roamingAppData: roaming, now };
    const first = await syncClaudeHooks(exe, o);
    expect(first.changed.sort()).toEqual([profile, user].sort());
    expect(first.problems).toHaveLength(1);
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    expect(JSON.parse(readFileSync(user, 'utf8')).theme).toBe('dark');
    expect(
      readdirSync(path.join(data, 'backups', 'claude-settings')),
    ).toHaveLength(2);
    expect((await syncClaudeHooks(exe, o)).changed).toEqual([]);
    writeFileSync(broken, '{}');
    const off = await syncClaudeHooks(null, o);
    expect(off.changed.sort()).toEqual([profile, user].sort());
    expect(JSON.parse(readFileSync(user, 'utf8'))).toEqual({ theme: 'dark' });
    expect(JSON.parse(readFileSync(profile, 'utf8'))).toEqual({});
  });
});
