import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { findPlan, type DisplayPlan } from '../model';
import { movePlanTab, pinPlanTab, type Navigation } from '../preferences';
import { planRoute } from './ui';

const TAB_DRAG = 'application/x-agent-ops-plan-tab';
function PinIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <path d="M6 2h5l-1 4 2 3H4l2-3V2ZM8 9v5" />
    </svg>
  );
}
export function PlanTabs({
  plans,
  navigation,
  setNavigation,
  current,
  close,
}: {
  plans: DisplayPlan[];
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
  current: string | null;
  close(key: string): void;
}) {
  const dragging = useRef<string | null>(null);
  return navigation.openPlans.map((key) => {
    const plan = findPlan(plans, key);
    if (!plan) return null;
    const pinned = navigation.pinnedPlans.includes(key);
    return (
      <span
        key={key}
        data-plan-tab={key}
        className={`document-tab${current === key ? ' on' : ''}${pinned ? ' pinned' : ''}`}
        draggable
        onContextMenu={(event) => {
          event.preventDefault();
          const menu = event.currentTarget.querySelector('details');
          if (menu) menu.open = true;
        }}
        onDragStart={(event) => {
          if ((event.target as HTMLElement).closest('button,summary')) {
            event.preventDefault();
            return;
          }
          dragging.current = key;
          event.dataTransfer.setData(TAB_DRAG, key);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragEnd={() => {
          dragging.current = null;
          document
            .querySelectorAll('.document-tab.drag-over')
            .forEach((tab) => tab.classList.remove('drag-over'));
        }}
        onDragOver={(event) => {
          if (
            !dragging.current ||
            !event.dataTransfer.types.includes(TAB_DRAG) ||
            navigation.pinnedPlans.includes(dragging.current) !== pinned
          )
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          event.currentTarget.classList.add('drag-over');
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node))
            event.currentTarget.classList.remove('drag-over');
        }}
        onDrop={(event) => {
          event.currentTarget.classList.remove('drag-over');
          const source = dragging.current;
          dragging.current = null;
          if (!source || event.dataTransfer.getData(TAB_DRAG) !== source)
            return;
          event.preventDefault();
          setNavigation((nav) => movePlanTab(nav, source, key));
        }}
      >
        {pinned && (
          <span className="tab-pin" title="Pinned">
            <PinIcon />
          </span>
        )}
        <Link
          to={planRoute(key)}
          title={plan.name}
          aria-current={current === key ? 'page' : undefined}
        >
          {plan.name}
        </Link>
        <TabMenu
          name={plan.name}
          planKey={key}
          navigation={navigation}
          setNavigation={setNavigation}
          close={close}
        />
        {!pinned && (
          <button aria-label={`Close ${plan.name}`} onClick={() => close(key)}>
            ×
          </button>
        )}
      </span>
    );
  });
}

function TabMenu({
  name,
  planKey: key,
  navigation: nav,
  setNavigation,
  close,
}: {
  name: string;
  planKey: string;
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
  close(key: string): void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [open, setOpen] = useState(false);
  const pinned = nav.pinnedPlans.includes(key);
  const group = nav.openPlans.filter(
    (value) => nav.pinnedPlans.includes(value) === pinned,
  );
  const index = group.indexOf(key);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node) &&
        ref.current
      )
        ref.current.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  function act(action: () => void) {
    if (ref.current) ref.current.open = false;
    ref.current?.querySelector('summary')?.focus();
    action();
  }
  return (
    <details
      ref={ref}
      className="tab-menu"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) {
          const rect = event.currentTarget
            .querySelector('summary')!
            .getBoundingClientRect();
          const scale =
            document.body.getBoundingClientRect().width /
            document.body.offsetWidth;
          setPosition({
            left: Math.max(
              8,
              Math.min(rect.left / scale, innerWidth / scale - 204),
            ),
            top: rect.bottom / scale + 4,
          });
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          act(() => undefined);
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled)',
            ) ?? []),
          ];
          const at = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                  buttons.length
          ]?.focus();
        }
      }}
    >
      <summary aria-label={`Tab menu: ${name}`} aria-haspopup="menu">
        ⋯
      </summary>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="tab-menu-popup"
            role="menu"
            aria-label={`Tab menu: ${name}`}
            style={position}
          >
            <button
              role="menuitem"
              disabled={!pinned && nav.pinnedPlans.length >= 8}
              onClick={() =>
                act(() =>
                  setNavigation((value) => pinPlanTab(value, key, !pinned)),
                )
              }
            >
              {pinned ? 'Unpin tab' : 'Pin tab'}
            </button>
            <button
              role="menuitem"
              disabled={index <= 0}
              onClick={() =>
                act(() =>
                  setNavigation((value) =>
                    movePlanTab(value, key, group[index - 1]!),
                  ),
                )
              }
            >
              Move left
            </button>
            <button
              role="menuitem"
              disabled={index < 0 || index === group.length - 1}
              onClick={() =>
                act(() =>
                  setNavigation((value) =>
                    movePlanTab(value, key, group[index + 1]!),
                  ),
                )
              }
            >
              Move right
            </button>
            <button
              role="menuitem"
              disabled={pinned}
              onClick={() => act(() => close(key))}
            >
              Close tab
            </button>
          </div>,
          document.body,
        )}
    </details>
  );
}
