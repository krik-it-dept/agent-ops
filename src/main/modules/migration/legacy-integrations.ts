import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFileRetry, writeFileAtomic } from '../../lib/safe-io';
import { isAbsolutePath, samePath } from '../../lib/safe-io/paths';
import { SettingsStore, OwnerError } from '../settings';
import { targetIdFor } from '../skills';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Port of legacyIntegrationTargets: paths and content hashes survive the folder-list migration. */
export function legacyIntegrationTargets(
  old: RecordValue,
  profile: string,
): RecordValue[] {
  const clients = [
    {
      id: 'claude',
      label: 'Claude Code',
      dir: '.claude',
      instructions: 'CLAUDE.md',
    },
    {
      id: 'codex',
      label: 'Codex / shared skills',
      dir: '.agents',
      instructions: 'AGENTS.md',
    },
    {
      id: 'gemini',
      label: 'Antigravity / Gemini',
      dir: '.agents',
      instructions: 'GEMINI.md',
    },
  ];
  const out: RecordValue[] = [];
  const find = (dir: string) =>
    out.findIndex((t) => samePath(text(t.skillDir), dir));
  for (const c of clients) {
    const rec = old[c.id];
    if (!record(rec)) continue;
    let dir = path.join(profile, c.dir, 'skills');
    if (isAbsolutePath(text(rec.path)))
      dir = path.dirname(path.dirname(text(rec.path)));
    let instructionFile = path.join(profile, `.${c.id}`, c.instructions);
    const instructions = record(rec.instructions)
      ? rec.instructions
      : undefined;
    if (instructions && isAbsolutePath(text(instructions.path)))
      instructionFile = text(instructions.path);
    const part =
      path
        .relative(profile, path.join(dir, 'task-plan', 'SKILL.md'))
        .replace(/\\/g, '/') + '#file';
    const legacy = record(rec.legacy) ? text(rec.legacy[part]) : '';
    if (!rec.path && !rec.kept && !instructions && !legacy) continue;
    let index = find(dir);
    if (
      index >= 0 &&
      instructions &&
      out[index]?.instructionBlock === true &&
      !samePath(text(out[index]?.instructionFile), instructionFile)
    ) {
      dir = path.join(profile, `.${c.id}`, 'skills');
      if (find(dir) >= 0) continue;
      index = -1;
    }
    if (index < 0) {
      out.push({
        id: targetIdFor(dir),
        label: c.label,
        skillDir: dir,
        instructionFile,
        instructionBlock: false,
        enabled: true,
        source: 'detected',
      });
      index = out.length - 1;
    }
    const target = out[index]!;
    if (rec.sha256 && !target.sha256) {
      target.version = Number.isInteger(rec.version) ? rec.version : 0;
      target.sha256 = text(rec.sha256);
      target.installedAt = text(rec.installedAt);
    }
    if (rec.kept && !target.kept) target.kept = text(rec.kept);
    if (legacy) target.legacySha256 = legacy;
    if (instructions) {
      target.instructionFile = instructionFile;
      target.instructionBlock = true;
      target.instructionSha256 = text(instructions.sha256);
    }
  }
  return out;
}

/** Startup only, before any renderer/Skills write. Back up the exact config; never touch client files. */
export async function migrateLegacyIntegrations(
  store: SettingsStore,
  profile: string,
): Promise<string | undefined> {
  if (store.readOnly) return undefined;
  const old = store.get().integrations;
  if (!record(old)) return undefined;
  const converted = legacyIntegrationTargets(old, profile);
  const original = await readFileRetry(store.file, store.io);
  const backup = path.join(
    store.dataDir,
    'backups',
    `migration-integrations-${randomUUID()}`,
    'config.json',
  );
  await writeFileAtomic(backup, original, store.io);
  const result = await store.mutate(async (draft) => {
    if (
      JSON.stringify(draft.integrations) !== JSON.stringify(old) ||
      !(await readFileRetry(store.file, store.io)).equals(original)
    )
      throw new OwnerError(
        'CONFLICT',
        'Settings changed during the Skills upgrade. Restart Agent Ops.',
      );
    if (converted.length) draft.integrations = converted;
    else delete draft.integrations;
  });
  if (!result.ok) throw new OwnerError(result.error.code, result.error.message);
  return backup;
}
