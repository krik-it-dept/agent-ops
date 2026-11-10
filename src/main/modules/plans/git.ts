import { execFile } from 'node:child_process';
import { join, normalize } from 'node:path';
import { abortable, checkAbort, exists } from './io';
import type { Repo } from './overview';

export type GitRunner = (
  dir: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string | Uint8Array>;
export const GIT_TIMEOUT_MS = 5000;
const cache = new Map<string, { at: number; gh: string }>();

/**
 * Variables that make git use another repository than `-C dir` names. They are
 * set inside Git hooks and some shells; the app may inherit them.
 */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (
      REPOSITORY_VARIABLES.includes(upper) ||
      /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(upper)
    )
      continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

export const defaultGit: GitRunner = (dir, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, ...args],
      {
        signal,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1 << 20,
        env: gitEnvironment(),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });

/** Every call, including a supplied runner, is bounded independently. */
export async function runGit(
  runner: GitRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<string> {
  const bounded = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(signal ? [signal] : []),
  ]);
  const output = await abortable(
    Promise.resolve().then(() => runner(root, args, bounded)),
    bounded,
  );
  return typeof output === 'string'
    ? output
    : Buffer.from(output).toString('utf8');
}

export async function gitDetails(
  repos: Repo[],
  runner?: GitRunner,
  signal?: AbortSignal,
  timeout = GIT_TIMEOUT_MS,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, repos.length) }, async () => {
      for (;;) {
        checkAbort(signal);
        const repo = repos[next++];
        if (!repo) return;
        if (!(await abortable(exists(join(repo.root, '.git')), signal)))
          continue;
        const key = normalize(repo.root).toLowerCase();
        const cached = !runner ? cache.get(key) : undefined;
        if (cached && Date.now() - cached.at < 60_000) {
          repo.gh = cached.gh;
          continue;
        }
        try {
          const remote = await runGit(
            runner ?? defaultGit,
            repo.root,
            ['remote', 'get-url', 'origin'],
            signal,
            timeout,
          );
          const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote.trim());
          if (match) repo.gh = `https://github.com/${match[1]}`;
        } catch {
          checkAbort(signal);
        }
        if (!runner) cache.set(key, { at: Date.now(), gh: repo.gh });
      }
    }),
  );
}
