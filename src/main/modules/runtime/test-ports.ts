import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { UpdaterPort } from './updates';

export interface TestPorts {
  updater(
    beforeInstall: () => Promise<void>,
    afterInstallFailed: () => void,
  ): UpdaterPort;
  fixedDrive(file: string): Promise<boolean>;
}
export function sampleModeAllowed(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
): boolean {
  return !packaged && env.AGENT_OPS_UI_FIXTURES === '1';
}
/** Main-only injection for the external Electron test harness; never enabled in a packaged app. */
export function isolatedTestPorts(options: {
  packaged: boolean;
  dataDir: string;
  env: NodeJS.ProcessEnv;
}): TestPorts | undefined {
  if (
    options.packaged ||
    options.env.AGENT_OPS_E2E !== '1' ||
    !options.env.AGENT_OPS_DATA_DIR
  )
    return undefined;
  const folder = realpathSync(options.dataDir),
    root = realpathSync(tmpdir());
  const rel = relative(root, folder);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..\\') ||
    rel.startsWith('../') ||
    isAbsolute(rel) ||
    resolve(options.env.AGENT_OPS_DATA_DIR) !== resolve(options.dataDir)
  )
    throw new Error(
      'Electron tests require a separate folder under the temporary directory.',
    );
  return (globalThis as unknown as Record<symbol, TestPorts>)[
    Symbol.for('agent-ops:e2e')
  ];
}
