import { readdir, stat } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { gitDetails, type GitRunner } from './git';
import {
  abortable,
  checkAbort,
  errorCode,
  exists,
  longPath,
  MAX_PLAN_BYTES,
  readPlanFile,
  slash,
} from './io';
import {
  buildOverview,
  buildPlan,
  type DiagnosticKind,
  type Overview,
  type Plan,
  type ProjectResult,
  type Repo,
} from './overview';
import { parseMarkdown } from './parse';

export interface Project {
  id: string;
  name?: string;
  path: string;
  kind: 'repo' | 'folder';
  enabled?: boolean;
}
export interface CollectConfig {
  projects?: readonly Project[];
  tasksDir?: string;
}
export interface CollectOptions {
  signal?: AbortSignal;
  now?: () => Date;
  git?: GitRunner;
  readFile?: (file: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Defaults to five seconds, also enforced for injected runners. */
  gitTimeoutMs?: number;
}

export function repoNameOf(path: string): string {
  const clean = normalize(path).replace(/[\\/]+$/, '');
  const name = basename(clean);
  if (name && name !== '.' && !/[\\/:]/.test(name)) return name;
  return (
    clean
      .replace(/[\\/:]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? 'root'
  );
}
async function requireDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory())
    throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
}
export async function tasksWorkspaces(dir: string): Promise<string[]> {
  await requireDirectory(dir);
  const names: string[] = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue;
    try {
      if ((await stat(join(dir, name))).isDirectory()) names.push(name);
    } catch {
      /* Skip vanished entries. */
    }
  }
  return names.sort();
}
export async function projectRepos(
  project: Project,
): Promise<{ name: string; root: string }[]> {
  await requireDirectory(project.path);
  if (project.kind === 'repo')
    return [{ name: repoNameOf(project.path), root: project.path }];
  const repos: { name: string; root: string }[] = [];
  for (const name of (await readdir(project.path)).sort()) {
    const root = join(project.path, name);
    try {
      await requireDirectory(root);
    } catch {
      continue;
    }
    if (
      (await exists(join(root, '.git'))) ||
      (await exists(join(root, '.tasks')))
    )
      repos.push({ name, root });
  }
  return repos;
}
export async function listPlans(dir: string): Promise<string[]> {
  try {
    // os.ReadDir in Go sorts UTF-8 bytes; workspace/project lists use UTF-16 instead.
    return (await readdir(dir))
      .filter((name) => name.endsWith('.md') && name !== 'tong-hop.md')
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(errorCode(error))) return [];
    throw error;
  }
}
const duplicateKey = (workspace: string, plan: string): string =>
  `${workspace.toLowerCase()}/${plan.toLowerCase()}`;

/** Read only explicitly configured roots. Per-file failures become diagnostics. */
export async function collectOverview(
  config: CollectConfig,
  options: CollectOptions = {},
): Promise<Overview> {
  const { signal } = options;
  checkAbort(signal);
  const io = <T>(operation: Promise<T>): Promise<T> =>
    abortable(operation, signal);
  const out: Omit<Overview, 'generatedAt'> = {
    projects: [],
    repos: [],
    plans: [],
    diagnostics: [],
  };
  const diag = (
    project: string,
    repo: string,
    plan: string,
    file: string,
    kind: DiagnosticKind,
    message: string,
  ): void => {
    out.diagnostics.push({
      project,
      repo,
      plan,
      file: slash(file),
      kind,
      message,
    });
  };
  const missing = (result: ProjectResult, error: unknown): void => {
    result.status = 'missing';
    result.message =
      errorCode(error) === 'ENOENT'
        ? 'Folder not found.'
        : `Folder cannot be opened (${errorCode(error)}).`;
  };
  const read = async (
    project: string,
    repo: string,
    file: string,
    name: string,
  ): Promise<Plan | undefined> => {
    checkAbort(signal);
    const problem = (kind: DiagnosticKind, message: string): void =>
      diag(project, repo, name, file, kind, message);
    let info;
    try {
      info = await io(stat(file));
    } catch (error) {
      checkAbort(signal);
      problem('unreadable', `The plan cannot be read (${errorCode(error)}).`);
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_PLAN_BYTES) {
      problem(
        'too-large',
        `The plan is ${Math.floor(info.size / (1 << 20))} MB; plans over 8 MB are not read.`,
      );
      return;
    }
    let source: Uint8Array;
    try {
      source = await io((options.readFile ?? readPlanFile)(file, signal));
    } catch (error) {
      checkAbort(signal);
      problem('unreadable', `The plan cannot be read (${errorCode(error)}).`);
      return;
    }
    if (source.length > MAX_PLAN_BYTES) {
      problem('too-large', 'The plan grew over 8 MB while it was read.');
      return;
    }
    try {
      info = await io(stat(file));
    } catch {
      checkAbort(signal);
    }
    checkAbort(signal);
    const parsed = parseMarkdown(source);
    if (parsed.invalidUTF8)
      problem(
        'invalid-utf8',
        'The plan is not valid UTF-8; unreadable characters are shown as �.',
      );
    if (parsed.unclosedFence)
      problem(
        'unclosed-fence',
        `The code block opened on line ${parsed.unclosedFence} is never closed, so the lines after it are not read.`,
      );
    return buildPlan(parsed, {
      project,
      repo,
      name,
      workspace: repo,
      file: slash(await io(longPath(file))),
      mtime: info.mtime,
    });
  };
  const inTasks = new Map<string, string>();
  if (config.tasksDir) {
    const result: ProjectResult = {
      id: 'tasks',
      name: 'Tasks',
      path: config.tasksDir,
      kind: 'tasks',
      status: 'ok',
      message: '',
      repos: 0,
      plans: 0,
    };
    let workspaces: string[] = [];
    try {
      workspaces = await io(tasksWorkspaces(config.tasksDir));
    } catch (error) {
      checkAbort(signal);
      missing(result, error);
    }
    result.repos = workspaces.length;
    for (const ws of workspaces) {
      checkAbort(signal);
      const dir = join(config.tasksDir, ws);
      let files: string[];
      try {
        files = await io(listPlans(dir));
      } catch (error) {
        checkAbort(signal);
        diag(
          'tasks',
          ws,
          '',
          dir,
          'folder-unreadable',
          `The workspace folder cannot be listed (${errorCode(error)}).`,
        );
        continue;
      }
      for (const name of files) {
        const plan = await read(
          'tasks',
          ws,
          join(dir, name),
          name.slice(0, -3),
        );
        if (!plan) continue;
        plan.projectName = 'Tasks';
        plan.source = 'tasks';
        out.plans.push(plan);
        inTasks.set(duplicateKey(ws, plan.name), plan.file);
        result.plans++;
      }
    }
    out.projects.push(result);
  }
  for (const project of config.projects ?? []) {
    if (project.enabled === false) continue;
    checkAbort(signal);
    const result: ProjectResult = {
      id: project.id,
      name: project.name || project.path,
      path: project.path,
      kind: project.kind,
      status: 'ok',
      message: '',
      repos: 0,
      plans: 0,
    };
    let repos: { name: string; root: string }[];
    try {
      repos = await io(projectRepos(project));
    } catch (error) {
      checkAbort(signal);
      missing(result, error);
      out.projects.push(result);
      continue;
    }
    result.repos = repos.length;
    for (const r of repos) {
      checkAbort(signal);
      const repo: Repo = {
        project: project.id,
        name: r.name,
        root: slash(await io(longPath(r.root))),
        gh: '',
        plans: 0,
        worktrees: [],
      };
      out.repos.push(repo);
      const dir = join(r.root, '.tasks');
      let files: string[];
      try {
        files = await io(listPlans(dir));
      } catch (error) {
        checkAbort(signal);
        diag(
          project.id,
          r.name,
          '',
          dir,
          'folder-unreadable',
          `The older plan folder of this workspace cannot be listed (${errorCode(error)}).`,
        );
        continue;
      }
      for (const name of files) {
        const file = join(dir, name),
          planName = name.slice(0, -3);
        const other = inTasks.get(duplicateKey(r.name, planName));
        if (other) {
          diag(
            project.id,
            r.name,
            planName,
            file,
            'duplicate',
            `The Tasks folder has a plan with the same name (${other}); this older copy inside the workspace is not shown. Delete it once it is no longer needed.`,
          );
          continue;
        }
        const plan = await read(project.id, r.name, file, planName);
        if (!plan) continue;
        plan.projectName = result.name;
        plan.root = repo.root;
        plan.source = 'legacy';
        out.plans.push(plan);
        repo.plans++;
        result.plans++;
      }
    }
    out.projects.push(result);
  }
  await gitDetails(out.repos, options.git, signal, options.gitTimeoutMs);
  checkAbort(signal);
  for (const plan of out.plans) {
    const matches = out.repos.filter((r) =>
      plan.source === 'tasks'
        ? r.name.toLowerCase() === plan.workspace.toLowerCase()
        : r.project === plan.project && r.name === plan.repo,
    );
    if (matches.length === 1) {
      plan.root = matches[0]!.root;
      plan.gh = matches[0]!.gh;
    }
  }
  return buildOverview(out, (options.now ?? (() => new Date()))());
}
