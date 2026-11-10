#!/usr/bin/env node
// Packages the built app (run `npm run build` first) with electron-builder.
//   node scripts/release/package.mjs        NSIS installer, latest.yml and blockmap
//   node scripts/release/package.mjs --dir  the unpacked app only (dist/electron/win-unpacked)
// Never publishes: the release workflow uploads the files to a draft release.
// Prints the artifacts with their sizes and SHA-512 (base64, as in latest.yml).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { packageVersion, releaseVersion } from './version.mjs';

const root = resolve(import.meta.dirname, '..', '..');
const output = join(root, 'dist', 'electron');
const dirOnly = process.argv.includes('--dir');

if (!existsSync(join(root, 'out', 'main', 'index.cjs'))) {
  console.error('Run `npm run build` first: out/main/index.cjs is missing.');
  process.exit(1);
}

let version;
try {
  version = releaseVersion(packageVersion(root), process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// Old artifacts would be listed (and uploaded) next to the new ones.
for (const name of existsSync(output) ? readdirSync(output) : []) {
  if (/^(agent-ops-setup-|latest\.yml$|win-unpacked$)/.test(name)) {
    rmSync(join(output, name), { recursive: true, force: true });
  }
}

const cli = join(root, 'node_modules', 'electron-builder', 'cli.js');
const args = [
  cli,
  '--win',
  dirOnly ? 'dir' : 'nsis',
  '--x64',
  '--publish',
  'never',
  `--config.extraMetadata.version=${version}`,
];
console.log(`Packaging Agent Ops ${version}${dirOnly ? ' (unpacked only)' : ''}`);
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const artifacts = readdirSync(output).filter((name) =>
  /^(agent-ops-setup-.*\.exe(\.blockmap)?|latest\.yml)$/.test(name),
);
for (const name of artifacts) {
  const file = join(output, name);
  const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64');
  console.log(`${name}\t${statSync(file).size} bytes\tsha512=${sha512}`);
}
if (!dirOnly && !artifacts.some((name) => name.endsWith('.exe'))) {
  console.error('No installer was produced.');
  process.exit(1);
}
