import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentOpsClient,
  Settings,
  StateResponse,
  UpdateState,
} from '../shared/contracts';
import { selectBridge } from './client';
import { acceptSnapshot, type Snapshot } from './model';

/** Toast is a short result with an optional action, such as Undo. */
export interface Toast {
  message: string;
  action?: { label: string; run(): void };
  /** How long the toast stays, in milliseconds. */
  timeout?: number;
}
interface LedgerContext {
  client: AgentOpsClient;
  fixture: boolean;
  snapshot: Snapshot | null;
  settings: Settings | null;
  update: UpdateState | null;
  error: string;
  dismissActionError(): void;
  loading: boolean;
  reload(): Promise<void>;
  refresh(): Promise<void>;
  setSettings(settings: Settings): void;
  setUpdate(update: UpdateState): void;
  report(error: unknown): void;
  announce(message: string): void;
  showToast(toast: Toast | null): void;
}
// Fast-changing status lives in its own context, so a refresh announcement
// does not re-render every plan row that only reads ledger data.
interface LedgerStatus {
  actionError: string;
  refreshing: boolean;
  notice: string;
  toast: (Toast & { id: number }) | null;
}
const Context = createContext<LedgerContext | null>(null);
const StatusContext = createContext<LedgerStatus | null>(null);
/**
 * Orders settings snapshots: a settings:get started before a newer settings
 * event or action response must not put the older settings back.
 */
export function settingsGate() {
  let version = 0;
  return {
    begin: () => version,
    changed: () => {
      version += 1;
    },
    current: (token: number) => token === version,
  };
}
export function LedgerProvider({
  children,
  source,
  initial,
}: {
  children: ReactNode;
  source?: { client: AgentOpsClient; fixture: boolean };
  initial?: {
    snapshot: StateResponse;
    settings: Settings;
    update: UpdateState;
  };
}) {
  const [selected] = useState(() => source ?? selectBridge());
  const { client, fixture } = selected;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() =>
    initial ? acceptSnapshot(null, initial.snapshot) : null,
  );
  const [settings, storeSettings] = useState<Settings | null>(
    initial?.settings || null,
  );
  const [gate] = useState(settingsGate);
  const setSettings = useCallback(
    (value: Settings) => {
      gate.changed();
      storeSettings(value);
    },
    [gate],
  );
  const [update, setUpdate] = useState<UpdateState | null>(
    initial?.update || null,
  );
  const [error, setError] = useState('');
  // Failed owner actions are kept apart from plan read failures so an
  // Archive or Copy link error is never shown as "Couldn't read plans".
  const [actionError, setActionError] = useState('');
  const [notice, announce] = useState('');
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback((next: Toast | null) => {
    setToast(next ? { ...next, id: ++toastId.current } : null);
  }, []);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const active = useRef(true);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const message = (failure: unknown) =>
    failure instanceof Error
      ? failure.message
      : 'The request could not be completed.';
  const readFailed = useCallback(
    (failure: unknown) => setError(message(failure)),
    [],
  );
  const report = useCallback(
    (failure: unknown) => setActionError(message(failure)),
    [],
  );
  const dismissActionError = useCallback(() => setActionError(''), []);
  const reload = useCallback((): Promise<void> => {
    if (pending.current) {
      dirty.current = true;
      return pending.current;
    }
    pending.current = (async () => {
      do {
        dirty.current = false;
        const token = gate.begin();
        try {
          const [next, prefs] = await Promise.all([
            client.state.get({}),
            client.settings.get({}),
          ]);
          if (active.current) {
            setSnapshot((before) => acceptSnapshot(before, next));
            if (gate.current(token)) storeSettings(prefs);
            setError(next.error);
          }
        } catch (failure) {
          if (active.current) readFailed(failure);
        } finally {
          if (active.current) setLoading(false);
        }
      } while (dirty.current && active.current);
    })().finally(() => {
      pending.current = null;
    });
    return pending.current;
  }, [client, readFailed, gate]);
  const refresh = useCallback((): Promise<void> => {
    if (refreshRequest.current) return refreshRequest.current;
    setRefreshing(true);
    announce('Checking progress…');
    refreshRequest.current = client.state
      .refresh({})
      .then(async () => {
        await reload();
        announce('Progress updated');
      })
      .catch((failure: unknown) => {
        readFailed(failure);
        announce('Progress check failed');
      })
      .finally(() => {
        setRefreshing(false);
        refreshRequest.current = null;
      });
    return refreshRequest.current;
  }, [client, reload, readFailed]);
  useEffect(() => {
    active.current = true;
    const off = client.state.onChanged(() => {
      void reload();
    });
    const offUpdates = client.updates.onChanged(setUpdate);
    const offSettings = client.settings.onChanged(setSettings);
    void reload();
    void client.updates
      .get({})
      .then(setUpdate)
      .catch(() => undefined);
    const timer = setInterval(() => {
      void reload();
    }, 30_000);
    return () => {
      active.current = false;
      off();
      offUpdates();
      offSettings();
      clearInterval(timer);
    };
  }, [client, reload, setSettings]);
  useEffect(() => {
    if (settings) {
      document.documentElement.dataset.theme = settings.theme;
      document.documentElement.dataset.textSize = settings.textSize;
      try {
        localStorage.setItem(
          'wb-prefs',
          JSON.stringify({
            theme: settings.theme,
            textSize: settings.textSize,
            shortcuts: settings.shortcuts,
            autoArchiveDone: settings.autoArchiveDone,
          }),
        );
      } catch {
        /* Optional first-paint preferences. */
      }
    }
  }, [settings]);
  const value = useMemo(
    () => ({
      client,
      fixture,
      snapshot,
      settings,
      update,
      error,
      dismissActionError,
      loading,
      reload,
      refresh,
      setSettings,
      setUpdate,
      report,
      announce,
      showToast,
    }),
    [
      client,
      fixture,
      snapshot,
      settings,
      update,
      error,
      dismissActionError,
      loading,
      reload,
      refresh,
      setSettings,
      report,
      showToast,
    ],
  );
  const status = useMemo(
    () => ({ actionError, refreshing, notice, toast }),
    [actionError, refreshing, notice, toast],
  );
  return (
    <Context.Provider value={value}>
      <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
    </Context.Provider>
  );
}
export function useLedger() {
  const value = useContext(Context);
  if (!value) throw new Error('LedgerProvider is required.');
  return value;
}
export function useLedgerStatus() {
  const value = useContext(StatusContext);
  if (!value) throw new Error('LedgerProvider is required.');
  return value;
}
export type { StateResponse };
