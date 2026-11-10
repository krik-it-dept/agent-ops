import path, { win32 } from 'node:path';

export interface DataDirOptions {
  env: NodeJS.ProcessEnv;
  development: boolean;
  repoDir: string;
  platform?: NodeJS.Platform;
}

export function resolveDataDir({
  env,
  development,
  repoDir,
  platform = process.platform,
}: DataDirOptions): string {
  const paths = platform === 'win32' ? win32 : path;
  const local = (value: string): boolean =>
    !value.includes('\0') &&
    (platform === 'win32'
      ? /^[a-z]:[\\/]/i.test(value) && !/^[\\/]{2}/.test(value)
      : paths.isAbsolute(value) && !value.startsWith('//'));
  const protectDevelopment = (value: string): string => {
    const result = paths.resolve(value);
    const localData = env.LOCALAPPDATA;
    if (development && localData && local(localData)) {
      const installed = paths.resolve(localData, 'AgentOps').toLowerCase();
      const rel = paths.relative(installed, result.toLowerCase());
      if (!rel || (!rel.startsWith('..') && !paths.isAbsolute(rel)))
        throw new Error('Development must use a separate data folder.');
    }
    return result;
  };
  const override = env.AGENT_OPS_DATA_DIR;
  if (override !== undefined) {
    if (!override.trim() || !local(override))
      throw new Error(
        'AGENT_OPS_DATA_DIR must be an absolute local folder path.',
      );
    return protectDevelopment(override);
  }
  if (development) return protectDevelopment(paths.join(repoDir, '.dev-data'));
  if (!env.LOCALAPPDATA || !local(env.LOCALAPPDATA))
    throw new Error('LOCALAPPDATA must be an absolute path.');
  return paths.join(env.LOCALAPPDATA, 'AgentOps');
}
