import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import type { Plan } from '../../shared/contracts';
import type { PlanState } from '../../shared/contracts';
import {
  archived,
  planKey,
  stage,
  statusTone,
  type DisplayPlan,
} from '../model';
import { useLedger, useLedgerStatus } from '../store';

export const planRoute = (key: string, tab = 'summary') =>
  `/plan/${encodeURIComponent(key)}/${tab}`;
export function Status({ value }: { value: string }) {
  return (
    <span className={`pill status-${statusTone(value)}`}>{stage(value)}</span>
  );
}
export function Glyph({ value }: { value: string }) {
  return (
    <span
      className={`glyph status-${statusTone(value)}`}
      role="img"
      aria-label={stage(value)}
    >
      {
        {
          done: '✓',
          blocked: '!',
          waiting: '?',
          review: '✓',
          doing: '◐',
          todo: '○',
        }[statusTone(value)]
      }
    </span>
  );
}
export function Progress({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  return (
    <span className="ledger-progress">
      <progress
        aria-label={label}
        aria-valuetext={`${done} of ${total} steps`}
        value={total ? Math.round((done * 100) / total) : 0}
        max={100}
      />
      <small>
        {done}/{total} · {total ? Math.round((done * 100) / total) : 0}%
      </small>
    </span>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className="empty">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
export function Warning({ plan }: { plan: DisplayPlan }) {
  return plan.diagnostics.length ? (
    <details className="plan-diagnostics">
      <summary>Plan warning ({plan.diagnostics.length})</summary>
      <ul>
        {plan.diagnostics.map((d, i) => (
          <li key={i}>{d.message}</li>
        ))}
      </ul>
    </details>
  ) : null;
}
export function RichText({
  text,
  plan,
}: {
  text: string;
  plan?: Plan | undefined;
}) {
  const { client, report } = useLedger();
  return (
    <>
      {String(text)
        .split(/(#\d+\b)/g)
        .map((part, i) =>
          plan?.gh &&
          /^#\d+$/.test(part) &&
          Number.isSafeInteger(Number(part.slice(1))) ? (
            <button
              key={i}
              className="link-button"
              onClick={(event) => {
                if (!event.isTrusted) return;
                void client.shell
                  .openExternal({
                    target: 'pull-request',
                    key: planKey(plan),
                    number: Number(part.slice(1)),
                  })
                  .catch(report);
              }}
            >
              {part}
            </button>
          ) : (
            part
          ),
        )}
    </>
  );
}
export function Modal({
  title,
  children,
  close,
  busy = false,
  className = '',
}: {
  title: string;
  children: ReactNode;
  close(): void;
  busy?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const before = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      dialog?.close();
      if (before instanceof HTMLElement && before.isConnected)
        before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <header className="dialog-head">
        <h2 id={id}>{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
/** isDone reports a plan whose stage is Done; it has no Mark as Done. */
export function isDone(plan: Pick<Plan, 'status'>): boolean {
  return stage(plan.status).trim().toLowerCase() === 'done';
}
/** Undo lasts as long as main accepts it. */
const UNDO_FOR_MS = 2 * 60 * 1000;
/**
 * useMarkDone returns the owner's Mark as Done: main writes Done into the
 * plan's Status line, a toast offers Undo for 2 minutes, and a refusal is
 * shown plainly while the plan stays where it was.
 */
export function usePlanStatus() {
  const { client, reload, report, showToast, settings } = useLedger();
  const readOnly = !!settings?.readOnly;
  return useCallback(
    async (plan: Plan, status: PlanState): Promise<boolean> => {
      if (readOnly) return false;
      const key = planKey(plan);
      const origin =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const focusUndo = !!origin?.closest('.plan-actions, .plan-state-picker');
      try {
        const request = { key, revision: plan.revision };
        const result =
          status === 'Done'
            ? await client.plans.markDone(request)
            : await client.plans.setStatus({ ...request, status });
        await reload();
        const token = result.undo?.token;
        if (!result.changed || !token) {
          showToast({ message: `${plan.name} is already ${status}` });
          return true;
        }
        showToast({
          message:
            status === 'Done'
              ? `Marked ${plan.name} Done`
              : `${plan.name}: ${status}`,
          timeout: UNDO_FOR_MS,
          focusAction: focusUndo,
          action: {
            label: 'Undo',
            run: () => {
              showToast(null);
              void client.plans
                .undoMarkDone({ key, token })
                .then(async (undone) => {
                  await reload();
                  showToast({
                    message: `${plan.name} is back to ${stage(undone.plan.status) || 'its previous stage'}`,
                  });
                  if (focusUndo)
                    requestAnimationFrame(() => {
                      const target = origin?.isConnected
                        ? origin
                        : document.querySelector<HTMLElement>(
                            `.work-card[data-plan-key="${CSS.escape(key)}"] .plan-actions summary`,
                          );
                      target?.focus({ preventScroll: true });
                    });
                })
                .catch(report);
            },
          },
        });
        return true;
      } catch (failure) {
        report(failure);
        return false;
      }
    },
    [client, reload, report, showToast, readOnly],
  );
}
export function useMarkDone() {
  const change = usePlanStatus();
  return useCallback((plan: Plan) => change(plan, 'Done'), [change]);
}
/** ToastHost shows the latest toast at the bottom of the window. */
export function ToastHost() {
  const { toast } = useLedgerStatus();
  const { showToast } = useLedger();
  const action = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (toast?.focusAction) action.current?.focus({ preventScroll: true });
  }, [toast]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => showToast(null), toast.timeout ?? 6000);
    return () => clearTimeout(timer);
  }, [toast, showToast]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div className="toast" key={toast.id}>
          <span>{toast.message}</span>
          {toast.action && (
            <button ref={action} onClick={toast.action.run}>
              {toast.action.label}
            </button>
          )}
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => showToast(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
export function PlanActions({
  plan,
  afterDelete,
  children,
}: {
  plan: Plan;
  afterDelete?: () => void;
  children?: ReactNode;
}) {
  const { client, settings, setSettings, reload, report, announce } =
    useLedger();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isArchived = settings ? archived(plan, settings) : false;
  const locked = busy || !!settings?.readOnly;
  const markDone = useMarkDone();
  async function archive() {
    if (locked) return;
    setBusy(true);
    try {
      setSettings(
        await client.plans.archive({
          key: planKey(plan),
          archived: !isArchived,
        }),
      );
      announce(isArchived ? 'Plan restored' : 'Plan archived');
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  }
  async function recycle() {
    if (locked) return;
    setBusy(true);
    setError('');
    try {
      await client.plans.recycle({
        key: planKey(plan),
        revision: plan.revision,
        confirm: true,
      });
      setConfirm(false);
      afterDelete?.();
      await reload();
      announce('Moved to the Recycle Bin. You can restore it from there.');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'This plan could not be moved.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <details className="plan-actions">
        <summary aria-label={`Actions for ${plan.name}`}>⋯</summary>
        <div>
          {children}
          {!isDone(plan) && (
            <button
              disabled={locked}
              onClick={(event) => {
                const menu = event.currentTarget.closest('details');
                menu?.removeAttribute('open');
                menu?.querySelector('summary')?.focus();
                setBusy(true);
                void markDone(plan).finally(() => setBusy(false));
              }}
            >
              Mark as Done
            </button>
          )}
          <button
            disabled={locked}
            onClick={() => {
              void archive();
            }}
          >
            {isArchived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            disabled={locked}
            onClick={(event) => {
              const menu = event.currentTarget.closest('details');
              menu?.removeAttribute('open');
              menu?.querySelector('summary')?.focus();
              setError('');
              setConfirm(true);
            }}
          >
            Delete…
          </button>
        </div>
      </details>
      {confirm && (
        <Modal
          title="Move this plan to the Recycle Bin?"
          busy={busy}
          close={() => setConfirm(false)}
        >
          <p>{plan.name}</p>
          <code className="path">
            {plan.file || plan.spec || `${plan.name}.md`}
          </code>
          <p>You can restore the file from the Windows Recycle Bin.</p>
          {error && <p role="alert">{error}</p>}
          <footer className="actions">
            <button
              data-initial-focus
              disabled={busy}
              onClick={() => setConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                void recycle();
              }}
            >
              {busy ? 'Moving…' : 'Move to Recycle Bin'}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
export function PlanLink({
  plan,
  children,
}: {
  plan: Plan;
  children?: ReactNode;
}) {
  return (
    <Link className="work-link" to={planRoute(planKey(plan))}>
      {children ?? plan.name}
    </Link>
  );
}
export function SourceLabel({ plan }: { plan: Plan }) {
  return plan.source === 'legacy' ? (
    <small className="source-label">In workspace</small>
  ) : null;
}
