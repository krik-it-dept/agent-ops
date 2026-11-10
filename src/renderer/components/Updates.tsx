import { useEffect, useRef, useState } from 'react';
import { useLedger } from '../store';
import { loadPreference, savePreference } from '../preferences';
import type { AgentOpsClient, UpdateState } from '../../shared/contracts';

type UpdateIntent = 'check' | 'apply' | 'skip';
const intents = new WeakMap<AgentOpsClient, UpdateIntent>();
export function updateRetryAction(
  update: UpdateState,
  last: UpdateIntent | null,
): 'check' | 'apply' {
  if (last === 'check' || last === 'skip') return 'check';
  return last === 'apply' || update.available ? 'apply' : 'check';
}

export function updateNoticeKey(update: UpdateState) {
  return update.phase === 'error'
    ? `error:${update.error}`
    : update.phase === 'updated'
      ? `updated:${update.current}`
      : update.phase === 'checking'
        ? 'checking'
        : update.latest || 'dismissed';
}
// Scheduled checks run at startup and every few hours. Their checking and
// failure states stay in the status bar; the card opens for them only when
// the owner started an update action in this session or an update is known.
export function updateDockWanted(
  update: UpdateState,
  asked: boolean,
  dismissed: string,
) {
  if (updating(update.phase)) return true;
  if (dismissed === updateNoticeKey(update)) return false;
  if (update.phase === 'checking') return asked;
  if (update.phase === 'error') return asked || update.available;
  return update.phase === 'updated' || (update.available && !update.skipped);
}
export const updating = (phase?: string) =>
  ['downloading', 'verifying', 'installing', 'restarting'].includes(
    phase || '',
  );
const labels = {
  downloading: 'Downloading',
  verifying: 'Verifying',
  installing: 'Installing',
  restarting: 'Restarting',
};
export function UpdatePanel({
  inline = false,
  minimized,
  minimize,
  dismiss,
}: {
  inline?: boolean;
  minimized?: boolean;
  minimize?: () => void;
  dismiss?: () => void;
}) {
  const { update, client, setUpdate, report } = useLedger();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [last, setLast] = useState<UpdateIntent | null>(
    () => intents.get(client) || null,
  );
  if (!update)
    return inline ? <p role="status">Loading update status…</p> : null;
  const phase = update.phase;
  const progress = updating(phase);
  const failed = phase === 'error';
  async function run(kind: 'check' | 'apply' | 'skip') {
    if (!update || pending.current || updating(update.phase)) return;
    pending.current = true;
    setBusy(true);
    setLast(kind);
    intents.set(client, kind);
    const before = update;
    if (kind !== 'skip')
      setUpdate({
        ...before,
        phase: kind === 'apply' ? 'downloading' : 'checking',
        error: '',
      });
    try {
      const result =
        kind === 'check'
          ? await client.updates.check({})
          : await client.updates[kind]({ version: before.latest });
      setUpdate(result);
      if (kind === 'skip') dismiss?.();
    } catch (error) {
      setUpdate({
        ...before,
        phase: 'error',
        error:
          error instanceof Error ? error.message : 'The update did not finish.',
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className={`update-panel${inline ? ' inline-update' : ''}`}
      aria-label="Software update"
      aria-live="polite"
    >
      {!minimized && (
        <>
          <div className="row">
            <strong>
              {progress
                ? phase === 'restarting'
                  ? 'Update ready'
                  : `Updating to ${update.latest}`
                : failed
                  ? last === 'check' || (!last && !update.available)
                    ? 'Couldn’t check for updates'
                    : 'Update failed'
                  : phase === 'checking'
                    ? 'Checking for updates…'
                    : phase === 'updated'
                      ? `Updated to ${update.current}`
                      : update.available && !update.skipped
                        ? 'Update available'
                        : update.skipped
                          ? `${update.latest} skipped`
                          : 'You’re on the latest version.'}
            </strong>
            {!inline && !progress && dismiss && (
              <button aria-label="Dismiss update" onClick={dismiss}>
                ×
              </button>
            )}
          </div>
          {progress ? (
            <>
              <progress
                aria-label="Update progress"
                aria-valuetext={labels[phase as keyof typeof labels]}
              />
              <p role="status">
                {labels[phase as keyof typeof labels]}…{' '}
                {phase === 'restarting'
                  ? 'Agent Ops will restart automatically.'
                  : 'Your plans and settings are kept.'}
              </p>
              {!inline && (
                <button onClick={minimize}>Minimize to status bar</button>
              )}
            </>
          ) : failed ? (
            <>
              <p role="alert">{update.error || 'The update did not finish.'}</p>
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    void run(updateRetryAction(update, last));
                  }}
                >
                  Try again
                </button>
                <button
                  onClick={() => {
                    void client.shell
                      .openFolder({ target: 'logs' })
                      .catch(report);
                  }}
                >
                  Open logs
                </button>
                {inline && (
                  <button
                    disabled={busy}
                    onClick={() => {
                      void run('check');
                    }}
                  >
                    Check for updates
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              {update.available && !update.skipped && (
                <>
                  <p>
                    Agent Ops {update.latest} is ready. Your plans and settings
                    are kept.
                  </p>
                  <details>
                    <summary>What’s new</summary>
                    <pre className="release-notes">
                      {update.notes || 'No release notes provided.'}
                    </pre>
                  </details>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => {
                        void run('apply');
                      }}
                    >
                      Update and restart
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        void run('skip');
                      }}
                    >
                      Skip this version
                    </button>
                  </div>
                </>
              )}
              {phase === 'updated' && <p>Agent Ops is up to date.</p>}
              {inline && (
                <button
                  disabled={busy || phase === 'checking'}
                  onClick={() => {
                    void run('check');
                  }}
                >
                  {phase === 'checking' ? 'Checking…' : 'Check for updates'}
                </button>
              )}
              {update.notes && inline && (
                <details>
                  <summary>Release notes</summary>
                  <pre className="release-notes">{update.notes}</pre>
                </details>
              )}
              <button
                className="link-button"
                onClick={(event) => {
                  if (!event.isTrusted) return;
                  void client.shell
                    .openExternal({
                      target: 'release',
                      version: update.current,
                    })
                    .catch(report);
                }}
              >
                Release notes
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
export function useUpdateDock() {
  const { update, client } = useLedger();
  const [prefs, setPrefs] = useState(() =>
    loadPreference('wb-update', { dismissed: '', minimized: false }),
  );
  useEffect(() => {
    if (update?.phase === 'restarting' || update?.phase === 'error')
      setPrefs((p) => ({ ...p, minimized: false }));
  }, [update?.phase]);
  useEffect(() => {
    if (update?.phase !== 'updated') return;
    const timer = setTimeout(
      () => setPrefs((p) => ({ ...p, dismissed: `updated:${update.current}` })),
      10_000,
    );
    return () => clearTimeout(timer);
  }, [update?.phase, update?.current]);
  useEffect(() => savePreference('wb-update', prefs), [prefs]);
  const noticeKey = update ? updateNoticeKey(update) : 'dismissed';
  const dismiss = () =>
    setPrefs((p) => ({
      ...p,
      dismissed: noticeKey,
    }));
  return {
    visible:
      !!update &&
      !prefs.minimized &&
      updateDockWanted(update, intents.has(client), prefs.dismissed),
    minimize: () => setPrefs((p) => ({ ...p, minimized: true })),
    show: () => setPrefs((p) => ({ ...p, minimized: false, dismissed: '' })),
    dismiss,
  };
}
