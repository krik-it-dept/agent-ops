import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHealth, type HealthOptions } from './health';
const folders: string[] = [];
afterEach(async () => {
  for (const root of folders.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<HealthOptions> {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-health-'));
  folders.push(root);
  for (const path of ['data', 'renderer', 'main', 'preload', 'resources/icons'])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, 'renderer/index.html'),
    '<div id="root"></div><script src="./app.js"></script>',
  );
  await writeFile(join(root, 'renderer/app.js'), 'console.log("synthetic");');
  await writeFile(join(root, 'main/collector.worker-test.js'), 'synthetic');
  await writeFile(join(root, 'preload/index.cjs'), 'synthetic');
  for (const icon of ['app.ico', 'app.png', 'app-light.ico', 'app-dark.ico'])
    await writeFile(join(root, 'resources/icons', icon), 'synthetic');
  return {
    dataDir: join(root, 'data'),
    rendererDir: join(root, 'renderer'),
    mainDir: join(root, 'main'),
    preloadFile: join(root, 'preload/index.cjs'),
    resourcesDir: join(root, 'resources'),
    version: 'v1.0.0',
  };
}
describe('read-only health check', () => {
  it('checks a new install without creating defaults or runtime stores', async () => {
    const options = await fixture();
    expect(await checkHealth(options)).toMatchObject({
      ok: true,
      config: 'empty',
      resources: 'ready',
    });
    expect(await readdir(options.dataDir)).toEqual([]);
  });
  it('reads valid settings verbatim and leaves invalid/newer settings intact on failure', async () => {
    const options = await fixture();
    for (const [source, ok] of [
      ['{"version":1,"projects":[],"theme":"dark"}', true],
      ['{bad', false],
      ['{"version":999,"private":"keep"}', false],
    ] as const) {
      await writeFile(join(options.dataDir, 'config.json'), source);
      expect((await checkHealth(options)).ok).toBe(ok);
      expect(await readFile(join(options.dataDir, 'config.json'), 'utf8')).toBe(
        source,
      );
      expect(await readdir(options.dataDir)).toEqual(['config.json']);
    }
    await rm(join(options.rendererDir, 'app.js'));
    expect(await checkHealth(options)).toMatchObject({ ok: false });
  });
});
