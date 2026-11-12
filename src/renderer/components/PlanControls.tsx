import { useState } from 'react';
import { PLAN_STATES, type Plan, type PlanState } from '../../shared/contracts';
import { stage } from '../model';
import { useLedger } from '../store';
import { Glyph, Status, usePlanStatus } from './ui';

/** A native select keeps the icon picker keyboard- and screen-reader-accessible. */
export function PlanStatePicker({
  plan,
  showLabel = false,
}: {
  plan: Plan;
  showLabel?: boolean;
}) {
  const { settings } = useLedger();
  const [busy, setBusy] = useState(false);
  const change = usePlanStatus();
  const value = stage(plan.status);
  return (
    <span
      className={`plan-state-picker${busy ? ' busy' : ''}`}
      title={`Change Plan state: ${value}`}
    >
      {showLabel ? (
        <Status value={plan.status} />
      ) : (
        <Glyph value={plan.status} />
      )}
      <select
        aria-label={`Plan state for ${plan.name}`}
        value={value}
        disabled={busy || !!settings?.readOnly}
        onChange={(event) => {
          const next = event.target.value as PlanState;
          if (next === value) return;
          setBusy(true);
          void change(plan, next).finally(() => setBusy(false));
        }}
      >
        {!PLAN_STATES.includes(value as PlanState) && (
          <option value={value}>{value}</option>
        )}
        {PLAN_STATES.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </select>
    </span>
  );
}

export function PlanPinButton({
  name,
  pinned,
  toggle,
}: {
  name: string;
  pinned: boolean;
  toggle(): void;
}) {
  return (
    <button
      className="plan-pin-button"
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name} on Board`}
      aria-pressed={pinned}
      title={pinned ? 'Unpin from Board' : 'Pin on Board'}
      onClick={toggle}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill={pinned ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden="true"
      >
        <path d="M6 2h5l-1 4 2 3H4l2-3V2ZM8 9v5" />
      </svg>
    </button>
  );
}
