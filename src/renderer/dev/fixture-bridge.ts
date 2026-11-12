import {
  createBridge,
  type Invoker,
  type Subscriber,
} from '../../shared/contracts/bridge';
import type {
  AgentOpsBridge,
  EventMap,
  Plan,
  Settings,
  SkillsResponse,
  StateResponse,
  TargetStatus,
  UpdateState,
  SettingsPatch,
  PlanMove,
  TargetInput,
  AppError,
  RequestMap,
  ResponseMap,
  Result,
} from '../../shared/contracts';
import { PLAN_STATES } from '../../shared/contracts';

export type FixtureMode =
  | 'demo'
  | 'setup'
  | 'empty'
  | 'hidden'
  | 'error'
  | 'loading'
  | 'update'
  /** The demo with more than one List page of tasks. */
  | 'large';
const now = '2026-11-10T09:30:00.000Z';
export function samplePlan(
  name = 'Cải thiện tìm kiếm',
  repo = 'Ledger',
  project = 'studio',
): Plan {
  const steps: Plan['steps'] = [
    {
      status: 'done',
      text: 'Giữ tiếng Việt trong kết quả',
      line: 10,
      milestone: 'M1',
      index: 0,
    },
    {
      status: 'done',
      text: 'Đối chiếu nội dung hiện có',
      line: 11,
      milestone: 'M1',
      index: 1,
    },
    {
      status: 'doing',
      text: 'Kiểm tra tìm kiếm',
      line: 18,
      milestone: 'M2',
      index: 0,
    },
    {
      status: 'todo',
      text: 'Xác minh kết quả #12',
      line: 19,
      milestone: 'M2',
      index: 1,
    },
    {
      status: 'blocked',
      text: 'Chờ dữ liệu mẫu từ chủ sở hữu',
      line: 24,
      milestone: '',
      index: 4,
    },
  ];
  return {
    project,
    projectName: project === 'studio' ? 'Studio' : 'Personal',
    repo,
    root: 'C:/Sample/Workspace/' + repo,
    gh: 'https://github.com/example/sample',
    name,
    owner: 'Minh',
    goal: 'Tìm đúng việc cần làm, giữ nguyên bằng chứng đã ghi.',
    spec: name + '.md',
    next: 'Kiểm tra kết quả bằng dữ liệu thực tế',
    status: 'Implementing',
    tone: 'doing',
    step: 1,
    mtime: now,
    revision: 'a'.repeat(64),
    decisions: [
      {
        key: '202611100900',
        when: '10/11 09:00',
        text: 'Giữ tiếng Việt và thứ tự nguồn',
      },
    ],
    questions: [
      {
        key: '202611100915',
        when: '10/11 09:15',
        ask: 'Chốt bộ dữ liệu mẫu?',
        answer: '',
        open: true,
      },
    ],
    milestones: [
      {
        id: 'M1',
        title: 'Prepare the source',
        state: 'done',
        summary: 'Nội dung hiện có đã được đối chiếu.',
        progress: { done: 2, total: 2 },
        steps: steps.slice(0, 2),
      },
      {
        id: 'M2',
        title: 'Release and verify',
        state: 'doing',
        summary: 'Giữ thay đổi nhỏ, kiểm tra từng bước.',
        progress: { done: 0, total: 2 },
        steps: steps.slice(2, 4),
      },
    ],
    steps,
    source: 'tasks',
    workspace: repo,
    file: `C:/Sample/Tasks/${repo}/${name}.md`,
  };
}
export function fixtureData(mode: FixtureMode = 'demo'): {
  snapshot: StateResponse;
  settings: Settings;
  skills: SkillsResponse;
  update: UpdateState;
} {
  const plans = [
    samplePlan(),
    {
      ...samplePlan('Chờ duyệt nội dung'),
      status: 'Waiting for owner - Please confirm the release wording',
      tone: 'pending' as const,
    },
    {
      ...samplePlan('Khắc phục đồng bộ', 'Services'),
      status: 'Blocked - The sample service is unavailable',
      tone: 'bad' as const,
    },
    {
      ...samplePlan('Hoàn tất bản mẫu'),
      status: 'Done',
      tone: 'ok' as const,
      questions: [],
    },
    {
      ...samplePlan('Kế hoạch cũ', 'Ledger', 'personal'),
      source: 'legacy' as const,
    },
  ];
  for (let i = 1; i <= 12; i++)
    plans.push({
      ...samplePlan(
        `Plan ${i}`,
        `Workspace ${i}`,
        i % 2 ? 'studio' : 'personal',
      ),
      status: i % 3 ? 'Testing' : 'Planning',
      tone: i % 3 ? 'review' : 'idle',
      questions: [],
      steps:
        mode === 'large'
          ? Array.from({ length: 20 }, (_, n) => {
              const base = samplePlan().steps;
              return {
                ...base[n % base.length]!,
                text: `${base[n % base.length]!.text} ${n + 1}`,
                line: 100 + n,
                index: n,
              };
            })
          : samplePlan().steps.slice(0, 4),
    });
  const agents = [
    'Claude',
    'Codex',
    'Gemini',
    'Antigravity',
    'Cursor',
    'Copilot',
  ];
  for (const [index, plan] of plans.entries()) {
    if (index === 4 || index === 8) continue;
    if (index === 3) {
      plan.steps = plan.steps.map((step) => ({ ...step, status: 'done' }));
      plan.next = 'Bản mẫu đã hoàn tất và được kiểm tra';
    }
    plan.agent = index === 1 ? '' : agents[index % agents.length]!;
    const executor = agents[(index + 1) % agents.length]!;
    plan.steps = plan.steps.map((step, i) => ({
      ...step,
      ...(i === 3 ? {} : { executors: [i === 0 ? 'Claude' : executor] }),
    }));
    plan.milestones = plan.milestones.map((m) => ({
      ...m,
      ...(index === 3 ? { state: 'done' as const } : {}),
      progress: {
        done: plan.steps.filter(
          (s) => s.milestone === m.id && s.status === 'done',
        ).length,
        total: plan.steps.filter((s) => s.milestone === m.id).length,
      },
      steps: plan.steps.filter((step) => step.milestone === m.id),
    }));
    plan.runs = plan.steps
      .filter((step) => step.status !== 'todo')
      .map((step, i) => ({
        runId: `sample-${index}-${i}`,
        agent: step.executors?.[0] || executor,
        coordinator: plan.agent || 'Claude',
        role: 'executor',
        event:
          step.status === 'blocked'
            ? 'blocked'
            : step.status === 'done'
              ? 'done'
              : 'progress',
        active: step.status === 'doing' && index !== 3,
        startedAt: '2026-11-10T08:00:00.000Z',
        updatedAt: i === 0 ? '2026-11-10T08:30:00.000Z' : now,
        step: { line: step.line, text: step.text, milestone: step.milestone },
        result:
          step.status === 'blocked'
            ? 'Chờ chủ sở hữu cung cấp dữ liệu mẫu'
            : step.status === 'done'
              ? 'Đã kiểm tra tiếng Việt và đối chiếu kết quả'
              : 'Đang kiểm tra tìm kiếm trên dữ liệu mẫu',
      }));
  }
  const empty = ['empty', 'hidden', 'setup'].includes(mode);
  const settings: Settings = {
    setupRequired: mode === 'setup',
    setupComplete: mode !== 'setup',
    notifications: true,
    theme: 'system',
    textSize: 'default',
    shortcuts: true,
    autoArchiveDone: false,
    planArchive: null,
    startWithWindows: false,
    startupManaged: true,
    dataDir: 'C:\\Sample\\AgentOps',
    configFile: 'C:\\Sample\\AgentOps\\config.json',
    tasksDir: empty ? '' : 'C:\\Sample\\Tasks',
    tasksDirSuggested: 'C:\\Sample\\Tasks',
    legacyPlanCount: empty ? 0 : 1,
    previousTasksDir: 'C:\\Sample\\PreviousTasks',
    previousPlanCount: empty ? 0 : 2,
    projectsOverridden: '',
    warning: '',
    readOnly: '',
    version: 'v0.5.0',
    projects:
      empty && mode !== 'hidden'
        ? []
        : ['Studio', 'Personal'].map((name, i) => ({
            id: name.toLowerCase(),
            path: `C:\\Sample\\${name}`,
            name,
            kind: 'folder',
            enabled: mode !== 'hidden',
            addedAt: now,
            exists: true,
            repos: [
              {
                name: i ? 'Ledger' : 'Services',
                path: `C:\\Sample\\${name}\\Work`,
                hasTasks: true,
                planCount: 3,
              },
            ],
          })),
  };
  const snapshot: StateResponse = {
    generation: 1,
    appVersion: settings.version,
    state: {
      generatedAt: now,
      projects: [],
      repos: [],
      plans: empty ? [] : plans,
      diagnostics: empty
        ? []
        : [
            {
              project: 'personal',
              repo: 'Ledger',
              plan: 'Kế hoạch cũ',
              file: 'C:/Sample/Workspace/old.md',
              kind: 'unclosed-fence',
              message:
                'A code fence does not close. Later lines could not be read.',
            },
          ],
    },
    activity: empty
      ? []
      : [
          {
            ts: now,
            project: 'studio',
            repo: 'Ledger',
            plan: plans[0]!.name,
            kind: 'done',
            text: 'Giữ tiếng Việt trong kết quả',
            actor: 'Minh',
          },
        ],
    now,
    error: mode === 'error' ? 'The sample folder could not be read.' : '',
    stale: { 'studio/Services/Khắc phục đồng bộ': true },
    setupRequired: settings.setupRequired,
    projects: settings.projects.map((p) => ({
      ...p,
      status: p.enabled ? 'ok' : 'disabled',
      repos: p.repos.length,
      plans: 3,
    })),
    warnings: empty
      ? []
      : ['One older plan has a warning. Its readable steps are still shown.'],
    crash: null,
    planArchive: null,
  };
  const target = (
    id: string,
    label: string,
    state: TargetStatus['state'],
  ): TargetStatus => ({
    id,
    label,
    state,
    enabled: true,
    source: 'custom',
    skillDir: `C:\\Sample\\AI tools\\${id}\\skills`,
    skillFile: `C:\\Sample\\AI tools\\${id}\\skills\\task-plan\\SKILL.md`,
    installedVersion: state === 'not-installed' ? 0 : 1,
    kept: false,
    instructions: {
      path: `C:\\Sample\\AI tools\\${id}\\AGENTS.md`,
      state: 'off',
      line: '',
    },
  });
  return {
    snapshot,
    settings,
    skills: {
      skillVersion: 2,
      targets: [
        target('claude', 'Claude Code', 'installed'),
        target('codex', 'Codex', 'modified'),
        target('gemini', 'Gemini', 'update-available'),
      ],
      suggestions: [
        {
          client: 'orca',
          label: 'Orca',
          skillDir: 'C:\\Sample\\Orca\\skills',
          instructionFile: 'C:\\Sample\\Orca\\AGENTS.md',
        },
      ],
      migration: {
        version: 1,
        at: now,
        done: false,
        backup: 'C:\\Sample\\AgentOps\\backups\\migration',
        nextRetryAt: '2026-11-11T09:30:00Z',
        kept: ['Your edited instruction file was kept.'],
        checklist: [
          {
            file: 'C:\\Sample\\AI tools\\notes.md',
            line: 7,
            text: 'Review your earlier instructions here.',
          },
        ],
        errors: ['An instruction file is currently locked.'],
      },
      readOnly: '',
    },
    update: {
      current: 'v0.5.0',
      commit: '',
      processId: 1,
      latest: 'v0.5.1',
      notes:
        'Small improvements. Your plans and settings are kept.\n<release notes are plain text>',
      available: true,
      skipped: false,
      phase:
        mode === 'update'
          ? 'downloading'
          : mode === 'error'
            ? 'error'
            : 'available',
      error: mode === 'error' ? 'The sample update could not be verified.' : '',
      message: '',
      checkedAt: now,
    },
  };
}

export function createFixtureBridge(
  mode: FixtureMode = 'demo',
  initial: Partial<
    Pick<Settings, 'theme' | 'textSize' | 'shortcuts' | 'autoArchiveDone'>
  > = {},
): AgentOpsBridge {
  const data = fixtureData(mode);
  Object.assign(data.settings, initial);
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const picks = new Map<string, (value: unknown) => void>();
  let nextId = 0;
  let updateBusy = false;
  /** Mark as Done undo tokens: token -> plan key, previous status and revision. */
  const undos = new Map<
    string,
    { key: string; status: string; tone: Plan['tone']; revision: string }
  >();
  const emit = <C extends keyof EventMap>(channel: C, value: EventMap[C]) => {
    listeners
      .get(channel)
      ?.forEach((listener) => listener(structuredClone(value)));
  };
  const publish = () => {
    data.snapshot.generation++;
    data.snapshot.planArchive = data.settings.planArchive;
    data.snapshot.setupRequired = data.settings.setupRequired;
    emit('state:changed', { generation: data.snapshot.generation });
    emit('settings:changed', data.settings);
  };
  const fail = (code: AppError['code'], message: string): never => {
    throw { code, message, retryable: true };
  };
  const skill = (id: string) =>
    data.skills.targets.find((t) => t.id === id) ??
    fail('NOT_FOUND', 'This Skills folder is no longer in the list.');
  function progressUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    const phases: UpdateState['phase'][] = [
      'verifying',
      'installing',
      'restarting',
      'updated',
    ];
    phases.forEach((phase, i) =>
      setTimeout(
        () => {
          data.update.phase = phase;
          if (phase === 'updated') {
            data.update.current = data.update.latest;
            data.update.available = false;
            updateBusy = false;
          }
          emit('updates:changed', data.update);
        },
        (i + 1) * 800,
      ),
    );
  }
  const subscribe: Subscriber = (channel, listener) => {
    const set = listeners.get(channel) ?? new Set();
    listeners.set(channel, set);
    const callback = listener as (value: unknown) => void;
    set.add(callback);
    if (mode === 'update' && channel === 'updates:changed') progressUpdate();
    return () => {
      set.delete(callback);
    };
  };
  const invoke: Invoker = async <C extends keyof RequestMap>(
    channel: C,
    request: RequestMap[C],
  ): Promise<Result<ResponseMap[C]>> => {
    const input = request as Record<string, unknown>;
    try {
      let value: unknown;
      switch (channel) {
        case 'app:get-info':
          value = {
            version: data.settings.version,
            dataDir: data.settings.dataDir,
            platform: 'win32',
          };
          break;
        case 'state:get':
          if (mode === 'loading') return new Promise(() => undefined);
          value = data.snapshot;
          break;
        case 'state:refresh':
          if (mode === 'error')
            fail('REFRESH_FAILED', 'The sample folder could not be read.');
          if (data.snapshot.state.plans[1]) {
            data.snapshot.state.plans[1] = {
              ...data.snapshot.state.plans[1],
              next: 'Fresh source summary',
              revision: (data.snapshot.generation % 2 ? 'b' : 'c').repeat(64),
            };
          }
          data.snapshot.state.generatedAt = new Date().toISOString();
          publish();
          value = { refreshedAt: data.snapshot.state.generatedAt };
          break;
        case 'settings:get':
          value = data.settings;
          break;
        case 'settings:set': {
          const patch = request as SettingsPatch;
          if (/[\\/]projects[\\/]?$/i.test(patch.tasksDir ?? ''))
            fail(
              'CONTAINS_WORKSPACE',
              'This folder contains the workspace “Studio”, so its files would be read as plans. Use a new folder inside it instead.',
            );
          if (
            patch.tasksDir?.toLowerCase().includes('inside') &&
            !patch.allowInsideWorkspace
          )
            fail(
              'INSIDE_WORKSPACE',
              'This folder is inside a workspace. Plans there could be shared with your work.',
            );
          if (
            patch.tasksDir !== undefined &&
            !/^[a-z]:[\\/].+/i.test(patch.tasksDir)
          )
            fail('INVALID_REQUEST', 'Enter a full Tasks folder path.');
          const {
            allowInsideWorkspace: _allow,
            moveExisting: _move,
            ...prefs
          } = patch;
          void _allow;
          void _move;
          if (patch.tasksDir && patch.tasksDir !== data.settings.tasksDir) {
            data.settings.previousTasksDir = data.settings.tasksDir;
            data.settings.previousPlanCount = 2;
          }
          Object.assign(data.settings, prefs);
          data.settings.setupRequired = !data.settings.setupComplete;
          publish();
          value = data.settings;
          break;
        }
        case 'workspaces:add': {
          const path = String(input.path).trim();
          if (!/^[a-z]:[\\/].+/i.test(path))
            fail('INVALID_REQUEST', 'Enter a full workspace folder path.');
          if (
            data.settings.projects.some(
              (p) => p.path.toLowerCase() === path.toLowerCase(),
            )
          )
            fail('CONFLICT', 'This workspace is already added.');
          const project = {
            id: `sample-${++nextId}`,
            name: path.split(/[\\/]/).pop() || 'Workspace',
            path,
            kind: 'folder' as const,
            enabled: true,
            addedAt: now,
            exists: true,
            repos: [],
          };
          data.settings.projects.push(project);
          publish();
          value = {
            project,
            kind: project.kind,
            name: project.name,
            repos: [],
            settings: data.settings,
          };
          break;
        }
        case 'workspaces:edit':
          Object.assign(
            data.settings.projects.find((p) => p.id === input.id) ??
              fail('NOT_FOUND', 'Workspace not found.'),
            input,
          );
          publish();
          value = data.settings;
          break;
        case 'workspaces:remove':
          data.settings.projects = data.settings.projects.filter(
            (p) => p.id !== input.id,
          );
          publish();
          value = data.settings;
          break;
        case 'plans:archive':
          data.settings.planArchive = {
            ...data.settings.planArchive,
            [String(input.key)]: input.archived === true,
          };
          publish();
          value = data.settings;
          break;
        case 'plans:recycle': {
          const plan =
            data.snapshot.state.plans.find(
              (p) => `${p.project}/${p.repo}/${p.name}` === input.key,
            ) ?? fail('NOT_FOUND', 'The plan is no longer available.');
          if (input.revision !== plan.revision)
            fail(
              'REVISION_CHANGED',
              'This plan changed. Refresh it before moving it to the Recycle Bin.',
            );
          if (input.confirm !== true)
            fail(
              'INVALID_REQUEST',
              'Confirm moving this plan to the Recycle Bin.',
            );
          data.snapshot.state.plans = data.snapshot.state.plans.filter(
            (p) => p !== plan,
          );
          publish();
          value = { recycled: true };
          break;
        }
        case 'plans:mark-done':
        case 'plans:set-status': {
          const status =
            channel === 'plans:set-status' ? String(input.status) : 'Done';
          if (!PLAN_STATES.includes(status as (typeof PLAN_STATES)[number]))
            fail('INVALID_REQUEST', 'Choose a supported Plan state.');
          const key = String(input.key);
          const plan =
            data.snapshot.state.plans.find(
              (p) => `${p.project}/${p.repo}/${p.name}` === key,
            ) ?? fail('NOT_FOUND', 'The plan is no longer available.');
          if (input.revision !== plan.revision)
            fail(
              'REVISION_CHANGED',
              'This plan changed. Look again before marking it Done.',
            );
          // The sample keeps one plan whose file is locked, to show a refusal.
          if (plan.name === 'Khắc phục đồng bộ')
            fail(
              'CONFLICT',
              'This plan could not be changed. The file may be locked or unavailable.',
            );
          if (
            plan.status.split(' - ')[0]!.trim().toLowerCase() ===
            status.toLowerCase()
          ) {
            value = {
              plan: { key, status: plan.status, revision: plan.revision },
              changed: false,
              undo: null,
            };
            break;
          }
          const token = (++nextId).toString(16).padStart(32, '0');
          undos.set(token, {
            key,
            status: plan.status,
            tone: plan.tone,
            revision: plan.revision,
          });
          plan.status = status;
          plan.tone =
            status === 'Done'
              ? 'ok'
              : status === 'Blocked'
                ? 'bad'
                : status.startsWith('Waiting')
                  ? 'pending'
                  : 'doing';
          plan.revision = token.padStart(64, 'd');
          data.snapshot.activity.unshift({
            ts: new Date().toISOString(),
            project: plan.project,
            repo: plan.repo,
            plan: plan.name,
            kind: 'status',
            text:
              status === 'Done'
                ? 'Marked Done in Agent Ops'
                : 'Plan state changed in Agent Ops',
            extra: `${undos.get(token)!.status.split(' - ')[0]} → ${status}`,
            actor: 'Agent Ops',
          });
          publish();
          value = {
            plan: { key, status: plan.status, revision: plan.revision },
            changed: true,
            undo: {
              token,
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
          };
          break;
        }
        case 'plans:undo-mark-done': {
          const entry = undos.get(String(input.token));
          if (!entry || entry.key !== input.key)
            fail(
              'CONFLICT',
              'Undo is no longer available. It works for 2 minutes after marking a plan Done.',
            );
          const plan =
            data.snapshot.state.plans.find(
              (p) => `${p.project}/${p.repo}/${p.name}` === entry!.key,
            ) ?? fail('NOT_FOUND', 'The plan is no longer available.');
          undos.delete(String(input.token));
          plan.status = entry!.status;
          plan.tone = entry!.tone;
          plan.revision = entry!.revision;
          publish();
          value = {
            plan: {
              key: entry!.key,
              status: plan.status,
              revision: plan.revision,
            },
          };
          break;
        }
        case 'tasks:move-legacy':
        case 'tasks:move-all': {
          const results: PlanMove[] = [
            {
              key: 'personal/Ledger/Kế hoạch cũ',
              from: 'C:\\Sample\\Workspace\\old.md',
              to: data.settings.tasksDir + '\\Ledger\\old.md',
              ok: true,
            },
            {
              key: 'personal/Ledger/locked',
              from: 'C:\\Sample\\PreviousTasks\\locked.md',
              to: '',
              ok: false,
              error: 'The file is locked. It was left in place.',
            },
          ];
          data.settings.legacyPlanCount = 0;
          if (channel === 'tasks:move-all') data.settings.previousPlanCount = 1;
          publish();
          value = {
            results,
            moved: 1,
            failed: 1,
            backup: 'C:\\Sample\\AgentOps\\backups\\move',
            settings: data.settings,
          };
          break;
        }
        case 'skills:list':
          value = data.skills;
          break;
        case 'skills:add': {
          const info = request as TargetInput & { skillDir: string };
          if (!info.skillDir.trim())
            fail('INVALID_REQUEST', 'Enter a full Skills folder path.');
          const id = `tool-${++nextId}`;
          data.skills.targets.push({
            id,
            label: info.label || 'AI tool',
            skillDir: info.skillDir,
            skillFile: info.skillDir + '\\task-plan\\SKILL.md',
            enabled: true,
            source: 'custom',
            state: 'not-installed',
            installedVersion: 0,
            kept: false,
            instructions: {
              path: info.instructionFile || '',
              state: info.instructionFile ? 'off' : 'none',
              line: '',
            },
          });
          data.skills.added = id;
          value = data.skills;
          break;
        }
        case 'skills:edit': {
          const target = skill(String(input.id));
          if (typeof input.instructionFile === 'string')
            target.instructions.path = input.instructionFile;
          for (const key of ['label', 'skillDir', 'enabled'] as const)
            if (input[key] !== undefined)
              Object.assign(target, { [key]: input[key] });
          value = data.skills;
          break;
        }
        case 'skills:remove-target':
          data.skills.targets = data.skills.targets.filter(
            (t) => t.id !== input.id,
          );
          value = data.skills;
          break;
        case 'skills:diff':
          value = {
            path: skill(String(input.id)).skillFile,
            identical: false,
            lines: [
              { op: '-', text: '<owner-written instruction>' },
              { op: '+', text: 'Read the shared task-plan format.' },
            ],
          };
          break;
        case 'skills:keep':
          skill(String(input.id)).kept = true;
          value = data.skills;
          break;
        case 'skills:instructions-on':
        case 'skills:instructions-off':
          skill(String(input.id)).instructions.state = channel.endsWith('-on')
            ? 'on'
            : 'off';
          value = data.skills;
          break;
        case 'skills:remove-skill':
          skill(String(input.id)).state = 'not-installed';
          value = data.skills;
          break;
        case 'skills:install':
        case 'skills:update':
        case 'skills:replace':
          skill(String(input.id)).state = 'installed';
          skill(String(input.id)).installedVersion = 2;
          value = data.skills;
          break;
        case 'shell:pick':
          value = await new Promise((resolve) => {
            picks.set(String(input.requestId), resolve);
            setTimeout(() => {
              if (!picks.has(String(input.requestId))) return;
              picks.delete(String(input.requestId));
              resolve({
                path:
                  input.purpose === 'instruction-file'
                    ? 'C:\\Sample\\AI tools\\INSTRUCTIONS.md'
                    : `C:\\Sample\\Chosen-${String(input.purpose)}`,
              });
            }, 300);
          });
          break;
        case 'shell:cancel-pick': {
          const pick = picks.get(String(input.requestId));
          pick?.({ cancelled: true });
          picks.delete(String(input.requestId));
          value = { cancelled: !!pick };
          break;
        }
        case 'shell:open-folder':
        case 'shell:open-external':
          value = { opened: true };
          break;
        case 'diagnostics:get':
          value = {
            text:
              'Agent Ops v0.5.0\nPlans: ' + data.snapshot.state.plans.length,
          };
          break;
        case 'diagnostics:copy':
          value = { copied: true };
          break;
        case 'diagnostics:dismiss-crash':
          data.snapshot.crash = null;
          publish();
          value = { dismissed: true };
          break;
        case 'app:get-instance':
          value = { pid: 1, version: data.settings.version };
          break;
        case 'app:open':
          emit('app:activate', {
            plan: typeof input.plan === 'string' ? input.plan : null,
            route: input.plan ? 'plan' : 'overview',
          });
          value = { pid: 1 };
          break;
        case 'updates:get':
          value = data.update;
          break;
        case 'updates:check':
          if (mode === 'error')
            fail('UNAVAILABLE', 'The sample update check could not finish.');
          data.update.phase = 'available';
          data.update.available = true;
          data.update.skipped = false;
          value = data.update;
          emit('updates:changed', data.update);
          break;
        case 'updates:skip':
          data.update.skipped = true;
          value = data.update;
          emit('updates:changed', data.update);
          break;
        case 'updates:apply':
          data.update.phase = 'downloading';
          emit('updates:changed', data.update);
          progressUpdate();
          value = data.update;
          break;
      }
      return structuredClone({ ok: true, value }) as Result<ResponseMap[C]>;
    } catch (error) {
      return { ok: false, error: error as AppError };
    }
  };
  return createBridge(invoke, subscribe);
}
