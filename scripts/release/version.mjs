#!/usr/bin/env node
// The version a build is packaged with.
//   - A tagged release build (GITHUB_REF_TYPE=tag) uses the tag without "v" and
//     fails unless the tag is a stable vMAJOR.MINOR.PATCH equal to package.json.
//   - Any other build gets a dev version, <package version>-dev.<run>, which the
//     updater never offers or replaces (src/main/modules/updater).
// Prints the version. Usage: node scripts/release/version.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function releaseVersion(packageVersion, env) {
  if (!STABLE.test(packageVersion)) {
    throw new Error(`package.json version ${packageVersion} is not MAJOR.MINOR.PATCH.`);
  }
  if (env.GITHUB_REF_TYPE === 'tag') {
    const tag = env.GITHUB_REF_NAME ?? '';
    if (!/^v/.test(tag) || !STABLE.test(tag.slice(1))) {
      throw new Error(`Tag ${tag} is not a stable vMAJOR.MINOR.PATCH version.`);
    }
    if (tag === 'v0.0.0') {
      throw new Error('v0.0.0 is the development placeholder, not a release.');
    }
    if (tag.slice(1) !== packageVersion) {
      throw new Error(`Tag ${tag} does not match package.json version ${packageVersion}.`);
    }
    return packageVersion;
  }
  const run = /^\d+$/.test(env.GITHUB_RUN_NUMBER ?? '') ? env.GITHUB_RUN_NUMBER : '0';
  return `${packageVersion}-dev.${run}`;
}

export function packageVersion(root = process.cwd()) {
  return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(`${releaseVersion(packageVersion(), process.env)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
