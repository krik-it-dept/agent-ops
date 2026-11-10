#!/usr/bin/env node
// Smoke test of the unpacked packaged app (dist/electron/win-unpacked), in an
// isolated data folder. It never runs the installer or uninstaller and never
// writes the registry, the Start menu or %LOCALAPPDATA%\Programs.
//   1. Package contents: app.asar holds only out/, package.json and the runtime
//      packages (electron-updater and its dependencies); resources hold the
//      skill, the legacy stubs and app-update.yml for the public GitHub feed.
//   2. The app starts with AGENT_OPS_DATA_DIR set to a temporary folder, shows
//      the ledger and reports the packaged version and that data folder.
// Usage: node scripts/release/smoke-packaged.mjs [path to win-unpacked] [--dir]
// --dir checks an unpacked-only build, which has no installer update metadata.
import { listPackage, extractFile } from '@electron/asar';
import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dirOnly = process.argv.includes('--dir');
const unpacked = resolve(process.argv.slice(2).find((arg) => arg !== '--dir') ?? join('dist', 'electron', 'win-unpacked'));
const exe = join(unpacked, 'agent-ops.exe');
const resources = join(unpacked, 'resources');
const failures = [];
const check = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) failures.push(text);
};

check(existsSync(exe), `executable ${exe}`);
const asarFile = join(resources, 'app.asar');
check(existsSync(asarFile), 'app.asar (asar packing on)');
const entries = listPackage(asarFile, { isPack: false }).map((e) => e.replaceAll('\\', '/'));
check(entries.includes('/out/main/index.cjs'), 'main bundle packed');
check(entries.includes('/out/preload/index.cjs'), 'preload bundle packed');
check(entries.includes('/out/renderer/index.html'), 'renderer packed');
check(entries.includes('/node_modules/electron-updater/package.json'), 'electron-updater packed');
check(!entries.some((e) => e.startsWith('/src/')), 'no TypeScript sources packed');
check(!entries.some((e) => e.endsWith('.map')), 'no source maps packed');
const modules = new Set(
  entries
    .filter((e) => e.startsWith('/node_modules/'))
    .map((e) => e.split('/')[2])
    .filter(Boolean),
);
for (const bundled of ['react', 'react-dom', 'react-router-dom', 'electron', 'electron-builder', 'vite', 'typescript']) {
  check(!modules.has(bundled), `${bundled} not packed`);
}
console.log(`     packed runtime packages: ${[...modules].sort().join(', ')}`);
const metadata = JSON.parse(extractFile(asarFile, 'package.json').toString('utf8'));
check(/^\d+\.\d+\.\d+(-dev\.\d+)?$/.test(metadata.version), `packaged version ${metadata.version}`);

check(existsSync(join(resources, 'skills', 'task-plan', 'SKILL.md')), 'task-plan skill resource');
for (const icon of ['app.ico', 'app.png', 'app-light.ico', 'app-light.png', 'app-dark.ico', 'app-dark.png']) {
  const file = join(resources, 'icons', icon);
  check(existsSync(file) && statSync(file).size > 0, `native icon resource ${icon}`);
}
for (const stub of ['task-sync.mjs', 'task-report.mjs']) {
  check(existsSync(join(resources, 'legacy-stubs', stub)), `legacy stub ${stub}`);
}
{
  // The process/path helper the app shares with the installer, byte for byte.
  const helper = join(resources, 'installer-helper.ps1');
  check(
    existsSync(helper) && readFileSync(helper).equals(readFileSync(resolve('build', 'installer-helper.ps1'))),
    'installer helper resource matches build/installer-helper.ps1',
  );
}
const feed = join(resources, 'app-update.yml');
if (existsSync(feed)) {
  const text = readFileSync(feed, 'utf8');
  check(/provider: github/.test(text) && /owner: krik-it-dept/.test(text) && /repo: agent-ops/.test(text), 'app-update.yml points at krik-it-dept/agent-ops on GitHub');
} else if (dirOnly) {
  console.log('skip app-update.yml: unpacked-only build (--dir), no NSIS artifact was built');
} else {
  check(false, 'app-update.yml (build the installer, not --dir)');
}

const temp = mkdtempSync(join(tmpdir(), 'agent-ops-packaged-smoke-'));
const env = Object.fromEntries(
  Object.entries({
    ...process.env,
    AGENT_OPS_DATA_DIR: temp,
    USERPROFILE: join(temp, 'profile'),
    LOCALAPPDATA: join(temp, 'profile', 'AppData', 'Local'),
    APPDATA: join(temp, 'profile', 'AppData', 'Roaming'),
    AGENT_OPS_UI_FIXTURES: '1', // Packaged builds must ignore this development flag.
  }).filter(([, v]) => v !== undefined),
);
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
// Electron's Windows startup requires these profile roots to exist before main runs.
// They belong to this temporary test profile, never to the real user profile.
for (const folder of [env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA]) mkdirSync(folder, { recursive: true });
let app;
try {
  app = await electron.launch({ executablePath: exe, args: [], env, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.getByRole('dialog', { name: 'Agent Ops setup' }).waitFor({ timeout: 30_000 });
  check(true, 'first-run setup opens');
  const result = await page.evaluate(() => window.agentOps.app.getInfo({}));
  if (!result.ok) throw new Error(result.error.message);
  const info = result.value;
  check(info.version === metadata.version, `app reports version ${info.version}`);
  check(info.dataDir === temp, 'app uses the isolated data folder');
  const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);
  check(packaged === true, 'app runs as a packaged app');
  check(info.sampleModeAllowed === false, 'packaged sample mode is disabled despite the flag');
  await page.getByRole('button', { name: 'Set up later', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Skip setup?' }).getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  check(true, 'the real ledger opens after setup');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window.loadURL(window.webContents.getURL().split('#')[0] + '#/?fixture=demo');
  });
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
  check(await page.getByText('Sample workspace', { exact: true }).count() === 0, 'sample URL cannot replace packaged data');
  await app.close(); app = undefined;
  const snapshot = (root) => {
    const files = {};
    const walk = (folder, prefix = '') => {
      for (const name of readdirSync(folder).sort()) {
        const file = join(folder, name), key = prefix + name;
        if (statSync(file).isDirectory()) { files[key + '/'] = 'directory'; walk(file, key + '/'); }
        else files[key] = readFileSync(file).toString('base64');
      }
    };
    walk(root); return JSON.stringify(files);
  };
  const before = snapshot(temp);
  const health = spawnSync(exe, ['--health-check'], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  check(health.status === 0, `packaged health exits 0: ${health.status === 0 ? '' : health.stdout || health.stderr || health.error?.message || ''}`);
  const lines = health.stdout?.trim().split(/\r?\n/) ?? [];
  check(lines.length === 1, 'packaged health prints one JSON line');
  const receipt = JSON.parse(lines[0] || '{}');
  check(receipt.kind === 'agent-ops-health' && receipt.ok === true && receipt.version === metadata.version, 'packaged health verifies config and resources');
  check(snapshot(temp) === before, 'packaged health leaves the temporary data folder unchanged');
} catch (error) {
  check(false, `packaged app run: ${error.message}`);
} finally {
  await app?.close().catch(() => undefined);
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nPackaged smoke passed.');
