import { PROTOCOL } from './registration';
import type { Dispose } from './types';

export function validPlanKey(key: string): boolean {
  if (Buffer.byteLength(key, 'utf8') > 1024) return false;
  const parts = key.split('/');
  // Legacy repo/name keys are lookup-only and must be resolved unambiguously by main.
  return (
    (parts.length === 2 || parts.length === 3) &&
    parts.every(
      (part) =>
        !!part &&
        part !== '.' &&
        part !== '..' &&
        part.trim() === part &&
        !/[\\<>:"|?*]/u.test(part) &&
        !Array.from(part).some(
          (character) =>
            character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
        ) &&
        !/[. ]$/.test(part),
    )
  );
}
export function parsePlanLink(uri: string): string | null {
  if (
    Buffer.byteLength(uri) > 4096 ||
    !uri.startsWith(`${PROTOCOL}:open?`) ||
    /%(?![0-9a-f]{2})/i.test(uri)
  )
    return null;
  try {
    const url = new URL(uri);
    if (
      url.protocol !== `${PROTOCOL}:` ||
      url.pathname !== 'open' ||
      url.host ||
      url.hash ||
      url.username ||
      url.password
    )
      return null;
    if (
      [...url.searchParams.keys()].some((k) => k !== 'plan') ||
      url.searchParams.getAll('plan').length !== 1
    )
      return null;
    const key = url.searchParams.get('plan');
    return key && validPlanKey(key) ? key : null;
  } catch {
    return null;
  }
}
export function planLink(key: string): string {
  if (!validPlanKey(key)) throw new Error('Invalid plan key.');
  return `${PROTOCOL}:open?${new URLSearchParams({ plan: key })}`;
}
export interface InstancePort {
  requestLock(): boolean;
  quit(): void;
  onSecondInstance(callback: (argv: readonly string[]) => void): Dispose;
  onOpenURL(callback: (url: string) => void): Dispose;
}
export interface InstanceController {
  primary: boolean;
  ready(): void;
  dispose(): void;
}
/** Call before app.whenReady; deliver activations only after the trusted UI is ready. */
export function installSingleInstance(
  port: InstancePort,
  argv: readonly string[],
  open: (plan?: string) => void,
): InstanceController {
  if (!port.requestLock()) {
    port.quit();
    return { primary: false, ready() {}, dispose() {} };
  }
  let ready = false;
  const pending: (string | undefined)[] = [];
  const deliver = (key?: string): void => {
    if (ready) open(key);
    else {
      pending.push(key);
      if (pending.length > 32) pending.shift();
    }
  };
  const commandLine = (args: readonly string[]): void => {
    const links = args.filter(
      (arg) => /^[a-z][a-z0-9+.-]*:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg),
    );
    if (links.length) {
      for (const link of links) {
        const key = parsePlanLink(link);
        if (key) deliver(key);
      }
    } else if (!args.includes('--background')) deliver();
  };
  const offSecond = port.onSecondInstance(commandLine);
  const offURL = port.onOpenURL((uri) => {
    const key = parsePlanLink(uri);
    if (key) deliver(key);
  });
  commandLine(argv);
  return {
    primary: true,
    ready() {
      if (ready) return;
      ready = true;
      for (const key of pending.splice(0)) open(key);
    },
    dispose() {
      offSecond();
      offURL();
      pending.length = 0;
    },
  };
}
