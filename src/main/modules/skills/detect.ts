// Detection of AI tool folders. This is a suggestion provider only: it never
// adds anything to the list by itself; the owner decides. It is the only file of
// the module that knows AI tool folder names (see the no-client-paths test).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { cleanPath, isDir, isLocalAbsolute, PathTools } from './paths.js';
import type { TargetSuggestion } from './types.js';

/** Where to look. Tests pass a temporary folder as homeDir and nothing else. */
export interface DetectionEnvironment {
  /** The user's profile folder (a temporary folder in tests). */
  homeDir: string;
  /** %APPDATA% for the real profile; <homeDir>\AppData\Roaming otherwise. */
  roamingAppData: string;
  /** CLAUDE_CONFIG_DIR, only for the real profile. */
  claudeConfigDir?: string;
}

/**
 * The environment for homeDir. Values from the process environment (APPDATA,
 * CLAUDE_CONFIG_DIR) are used only when homeDir is this user's real home, so a
 * test or an isolated install never reaches the real AI tool configuration.
 */
export function detectionEnvironment(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  realHomeDir: string,
  paths: PathTools,
): DetectionEnvironment {
  const real = paths.samePath(homeDir, realHomeDir);
  const out: DetectionEnvironment = {
    homeDir,
    roamingAppData:
      real && env['APPDATA']
        ? env['APPDATA']
        : path.join(homeDir, 'AppData', 'Roaming'),
  };
  const configDir = env['CLAUDE_CONFIG_DIR'];
  if (real && configDir && isLocalAbsolute(configDir)) {
    out.claudeConfigDir = cleanPath(configDir);
  }
  return out;
}

function orcaProfilesDir(env: DetectionEnvironment): string {
  return path.join(env.roamingAppData, 'orca', 'claude-profiles');
}

/**
 * The Claude Code configuration folders: ~/.claude, CLAUDE_CONFIG_DIR, and every
 * Orca Claude profile (Orca runs Claude with CLAUDE_CONFIG_DIR set to
 * %APPDATA%\orca\claude-profiles\<id>\home).
 */
export async function claudeHomes(
  env: DetectionEnvironment,
  paths: PathTools,
): Promise<string[]> {
  const homes = [path.join(env.homeDir, '.claude')];
  if (env.claudeConfigDir) {
    homes.push(env.claudeConfigDir);
  }
  let profiles: string[];
  try {
    profiles = (await fs.readdir(orcaProfilesDir(env), { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(orcaProfilesDir(env), d.name, 'home'));
  } catch {
    profiles = [];
  }
  const orca: string[] = [];
  for (const home of profiles.sort()) {
    if (await isDir(home)) {
      orca.push(home);
    }
  }
  const out: string[] = [];
  for (const h of [...homes, ...orca]) {
    if (!out.some((o) => paths.samePath(o, h))) {
      out.push(h);
    }
  }
  return out;
}

function shortId(id: string): string {
  const chars = [...id];
  return chars.length > 8 ? chars.slice(0, 8).join('') : id;
}

/**
 * The AI tool folders found on this computer, in a fixed order, without folders
 * that resolve (through links or junctions) to one already suggested or to one
 * of existing. An Orca profile whose skills folder links to the Claude Code
 * skills folder is therefore not suggested twice.
 */
export async function detectTargets(
  env: DetectionEnvironment,
  existing: readonly string[],
  paths: PathTools,
): Promise<TargetSuggestion[]> {
  const candidates: TargetSuggestion[] = [];
  const claude = path.join(env.homeDir, '.claude');
  const orcaDir = orcaProfilesDir(env);
  for (const home of await claudeHomes(env, paths)) {
    if (!(await isDir(home))) {
      continue;
    }
    const s: TargetSuggestion = {
      client: 'claude',
      label: 'Claude Code',
      skillDir: path.join(home, 'skills'),
      instructionFile: path.join(home, 'CLAUDE.md'),
    };
    const rel = path.relative(orcaDir, home);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      s.client = 'orca';
      s.label = `Orca Claude profile ${shortId(path.basename(path.dirname(home)))}`;
    } else if (!paths.samePath(home, claude)) {
      s.label = 'Claude Code (CLAUDE_CONFIG_DIR)';
    }
    candidates.push(s);
  }
  const codex = path.join(env.homeDir, '.codex');
  const agents = path.join(env.homeDir, '.agents');
  const hasCodex = await isDir(codex);
  if (hasCodex || (await isDir(agents))) {
    const s: TargetSuggestion = {
      client: 'codex',
      label: 'Codex / shared skills',
      skillDir: path.join(agents, 'skills'),
    };
    if (hasCodex) {
      s.instructionFile = path.join(codex, 'AGENTS.md');
    }
    candidates.push(s);
  }
  const gemini = path.join(env.homeDir, '.gemini');
  if (await isDir(gemini)) {
    candidates.push({
      client: 'gemini',
      label: 'Antigravity / Gemini',
      skillDir: path.join(gemini, 'skills'),
      instructionFile: path.join(gemini, 'GEMINI.md'),
    });
  }
  const out: TargetSuggestion[] = [];
  for (const c of candidates) {
    let taken = false;
    for (const other of [...existing, ...out.map((o) => o.skillDir)]) {
      if (await paths.samePlace(other, c.skillDir)) {
        taken = true;
        break;
      }
    }
    if (!taken) {
      out.push(c);
    }
  }
  return out;
}
