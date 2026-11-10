// External test entry: fake only native effects/provider, then load the normal composition root.
import { app, dialog, shell } from 'electron';
import { realpathSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { UpdaterService } from '../src/main/modules/updater/service';
import { UpdateStore } from '../src/main/modules/updater/store';
import type { TestPorts } from '../src/main/modules/runtime/test-ports';

export interface BackendControls {
  picks: string[];
  opened: string[];
  trashed: string[];
  installs: number;
  failCheck: boolean;
  failInstall: boolean;
  completeDownload?: () => void;
}
const dataDir = process.env.AGENT_OPS_DATA_DIR!;
const root = process.env.AGENT_OPS_TEST_ROOT!;
const controls: BackendControls = {
  picks: [],
  opened: [],
  trashed: [],
  installs: 0,
  failCheck: false,
  failInstall: false,
};
Object.assign(globalThis, { agentOpsE2E: controls });
// The app reports canonical long paths; on CI the temp root is an 8.3 short name.
const canonical = (file: string): string => {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};
function assertInside(file: string): void {
  const rel = relative(canonical(root), canonical(file));
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith('..\\') ||
    rel.startsWith('../') ||
    isAbsolute(rel)
  )
    throw new Error('Effect escaped the test folder');
}
shell.trashItem = async (file) => {
  assertInside(file);
  const target = join(root, 'fake-trash', `${controls.trashed.length}.md`);
  await mkdir(join(root, 'fake-trash'), { recursive: true });
  await rename(file, target);
  controls.trashed.push(target);
};
shell.openPath = async (file) => {
  assertInside(file);
  controls.opened.push(file);
  return '';
};
shell.openExternal = async (url) => {
  controls.opened.push(url);
};
dialog.showOpenDialog = (async () => {
  const file = controls.picks.shift();
  if (file) assertInside(file);
  return { canceled: !file, filePaths: file ? [file] : [] };
}) as typeof dialog.showOpenDialog;
const ports: TestPorts = {
  fixedDrive: async (file) => {
    assertInside(file);
    return true;
  },
  updater: (beforeInstall, afterInstallFailed) =>
    new UpdaterService({
      currentVersion: '1.0.0',
      packaged: true,
      store: new UpdateStore(dataDir),
      firstCheckDelayMs: 3600000,
      restartDelayMs: 100,
      beforeInstall,
      afterInstallFailed,
      provider: {
        check: async () => {
          if (controls.failCheck) {
            controls.failCheck = false;
            throw new Error('offline');
          }
          return { version: '1.1.0', notes: 'Test release <escaped> notes' };
        },
        download: async (_version, progress, signal) => {
          progress({
            percent: 50,
            total: 100,
            transferred: 50,
            bytesPerSecond: 50,
          });
          await new Promise<void>((resolve, reject) => {
            controls.completeDownload = () => {
              progress({
                percent: 100,
                total: 100,
                transferred: 100,
                bytesPerSecond: 50,
              });
              resolve();
            };
            signal.addEventListener(
              'abort',
              () => reject(new Error('cancelled')),
              { once: true },
            );
          });
        },
        install: async () => {
          if (controls.failInstall) {
            controls.failInstall = false;
            throw new Error('Installer could not start');
          }
          controls.installs++;
        },
      },
    }),
};
(globalThis as unknown as Record<symbol, TestPorts>)[
  Symbol.for('agent-ops:e2e')
] = ports;
app.setName('Agent Ops integration test');
createRequire(join(process.cwd(), 'package.json'))(
  process.env.AGENT_OPS_TEST_ENTRY!,
);
