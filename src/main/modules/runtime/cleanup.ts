import { join, resolve } from 'node:path';
import { ServiceFault } from '../../ipc/errors';
import type { SkillAction } from '../skills';

export interface InstallScope {
  packaged: boolean;
  dataDir: string;
  executable: string;
  localAppData: string | undefined;
  overridden: boolean;
}
export function installedRuntime(scope: InstallScope): boolean {
  if (!scope.packaged || scope.overridden || !scope.localAppData) return false;
  const same = (a: string, b: string) =>
    resolve(a).toLowerCase() === resolve(b).toLowerCase();
  return (
    same(scope.dataDir, join(scope.localAppData, 'AgentOps')) &&
    same(
      scope.executable,
      join(scope.localAppData, 'Programs', 'AgentOps', 'agent-ops.exe'),
    )
  );
}
export interface CleanupTarget {
  id: string;
  instructionBlock: boolean;
}
/** Used only by the owner-selected NSIS --cleanup-skills mode; no profile scan or permanent fallback. */
export async function cleanupManagedSkills(
  targets: readonly CleanupTarget[],
  run: (id: string, action: SkillAction) => Promise<unknown>,
): Promise<void> {
  for (const target of targets) {
    if (target.instructionBlock) await run(target.id, 'instructions-off');
    await run(target.id, 'remove');
  }
}
export function requireCleanupScope(scope: InstallScope): void {
  if (!installedRuntime(scope))
    throw new ServiceFault(
      'FORBIDDEN',
      'Skills cleanup is available only from the installed Agent Ops.',
    );
}
