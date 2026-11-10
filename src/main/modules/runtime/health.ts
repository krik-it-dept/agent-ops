import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultConfig, readConfig } from '../settings';
import { APP_DOCUMENT, assetHandler } from './assets';

export type HealthReceipt = {
  kind: 'agent-ops-health';
  ok: boolean;
  version: string;
  config?: 'loaded' | 'empty';
  resources?: 'ready';
  message?: string;
};
export interface HealthOptions {
  dataDir: string;
  rendererDir: string;
  mainDir: string;
  preloadFile: string;
  resourcesDir: string;
  version: string;
  timeoutMs?: number;
}
/** No SettingsStore.load, migration, session, logger, IPC or OS registration: every access is read-only. */
export async function checkHealth(
  options: HealthOptions,
): Promise<HealthReceipt> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const inspect = async (): Promise<HealthReceipt> => {
    let config: 'loaded' | 'empty' = 'loaded';
    try {
      await readConfig(join(options.dataDir, 'config.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        defaultConfig();
        config = 'empty';
      } else
        throw new Error('Settings could not be read safely.', { cause: error });
    }
    const handle = await assetHandler(options.rendererDir);
    const document = await handle(new Request(APP_DOCUMENT));
    if (document.status !== 200)
      throw new Error('The app interface is missing.');
    const html = await document.text();
    const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(
      (match) => new URL(match[1]!, APP_DOCUMENT),
    );
    if (!assets.length) throw new Error('The app interface is incomplete.');
    for (const url of assets) {
      if (
        url.protocol !== 'app:' ||
        (await handle(new Request(url))).status !== 200
      )
        throw new Error('An app resource is missing.');
    }
    const files = await readdir(options.mainDir);
    if (!files.some((file) => /^collector\.worker-.+\.js$/.test(file)))
      throw new Error('The plan reader is missing.');
    if (!(await readFile(options.preloadFile)).length)
      throw new Error('The app bridge is missing.');
    for (const name of [
      'app.ico',
      'app.png',
      'app-light.ico',
      'app-dark.ico',
    ]) {
      if (!(await stat(join(options.resourcesDir, 'icons', name))).isFile())
        throw new Error('An app icon is missing.');
    }
    return {
      kind: 'agent-ops-health',
      ok: true,
      version: options.version,
      config,
      resources: 'ready',
    };
  };
  try {
    return await Promise.race([
      inspect(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('The app check took too long.')),
          options.timeoutMs ?? 3000,
        );
      }),
    ]);
  } catch (error) {
    return {
      kind: 'agent-ops-health',
      ok: false,
      version: options.version,
      message:
        error instanceof Error &&
        /^(Settings|The app|An app|The plan)/.test(error.message)
          ? error.message
          : 'The app resources could not be read.',
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
