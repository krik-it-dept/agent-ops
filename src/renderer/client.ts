import type {
  AgentOpsBridge,
  AgentOpsClient,
  AppError,
  Result,
  Settings,
} from '../shared/contracts';
import { createFixtureBridge, type FixtureMode } from './dev/fixture-bridge';

export class BridgeFailure extends Error {
  constructor(readonly detail: AppError) {
    super(detail.message);
    this.name = 'BridgeFailure';
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new BridgeFailure(result.error);
  return result.value;
}
export function createClient(bridge: AgentOpsBridge): AgentOpsClient {
  function wrap(value: object): object {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        key,
        typeof item === 'function'
          ? (...args: unknown[]) => {
              const result: unknown = (
                item as (...values: unknown[]) => unknown
              )(...args);
              return result &&
                typeof (result as Promise<unknown>).then === 'function'
                ? (result as Promise<Result<unknown>>).then(unwrap)
                : result;
            }
          : wrap(item as object),
      ]),
    );
  }
  return wrap(bridge) as AgentOpsClient;
}

let fixtureModeAllowed = false;
export function allowFixtureMode(allowed: boolean): void {
  fixtureModeAllowed = allowed;
}
export function selectBridge(): { client: AgentOpsClient; fixture: boolean } {
  const query = new URLSearchParams(window.location.hash.split('?')[1]);
  let storedMode: string | null = null;
  try {
    storedMode = sessionStorage.getItem('agent-ops-ui-fixture');
  } catch {
    /* Optional navigation storage. */
  }
  const mode = query.get('fixture') ?? storedMode;
  if (
    fixtureModeAllowed &&
    mode &&
    ['demo', 'setup', 'empty', 'hidden', 'error', 'loading', 'update'].includes(
      mode,
    )
  ) {
    try {
      sessionStorage.setItem('agent-ops-ui-fixture', mode);
    } catch {
      /* The explicit fixture URL still works. */
    }
    return {
      client: createClient(
        createFixtureBridge(
          mode as FixtureMode,
          (() => {
            let saved: Record<string, unknown> = {};
            try {
              const parsed: unknown = JSON.parse(
                localStorage.getItem('wb-prefs') || '{}',
              );
              if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
              )
                saved = parsed as Record<string, unknown>;
            } catch {
              /* Use fixture defaults. */
            }
            const theme = query.get('theme') || saved.theme;
            return {
              ...(['system', 'light', 'dark'].includes(String(theme))
                ? { theme: theme as 'system' | 'light' | 'dark' }
                : {}),
              ...(['small', 'default', 'large', 'larger'].includes(
                String(saved.textSize),
              )
                ? { textSize: saved.textSize as Settings['textSize'] }
                : {}),
              ...(typeof saved.shortcuts === 'boolean'
                ? { shortcuts: saved.shortcuts }
                : {}),
              ...(typeof saved.autoArchiveDone === 'boolean'
                ? { autoArchiveDone: saved.autoArchiveDone }
                : {}),
            };
          })(),
        ),
      ),
      fixture: true,
    };
  }
  return { client: createClient(window.agentOps), fixture: false };
}
