import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fold, placeLabel, planKey, stage, type DisplayPlan } from '../model';
import { Modal, planRoute } from './ui';

export const shortcuts = [
  ['/', 'Search'],
  [',', 'Settings'],
  ['R', 'Refresh plans'],
  ['?', 'Keyboard shortcuts'],
  ['Ctrl K', 'Plans and commands'],
  ['Ctrl 1 / 2 / 3 / 4', 'Summary / List / Board / Timeline'],
  ['Ctrl B', 'Toggle sidebar'],
  ['Alt ↑ / ↓', 'Previous / next plan'],
  ['Ctrl F', 'Search Settings'],
  ['Ctrl ,', 'Settings'],
  ['F5', 'Refresh plans'],
  ['Esc', 'Close or go back'],
];
export function CommandSearch({
  plans,
  close,
  viewRoute,
  toggleSidebar,
  refresh,
}: {
  plans: DisplayPlan[];
  close(): void;
  /** Adds the current search and agent filter to a view path. */
  viewRoute(path: string): string;
  toggleSidebar(): void;
  refresh(): void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const actions = [
    {
      label: 'Summary',
      detail: 'View · Ctrl 1',
      run: () => navigate(viewRoute('/')),
    },
    {
      label: 'Board',
      detail: 'View · Ctrl 3',
      run: () => navigate(viewRoute('/board')),
    },
    {
      label: 'Timeline',
      detail: 'View · Ctrl 4',
      run: () => navigate(viewRoute('/timeline')),
    },
    {
      label: 'List',
      detail: 'View · Ctrl 2',
      run: () => navigate(viewRoute('/list')),
    },
    {
      label: 'Needs attention',
      detail: 'View',
      run: () => navigate(viewRoute('/attention')),
    },
    {
      label: 'Archive',
      detail: 'View',
      run: () => navigate(viewRoute('/archive')),
    },
    { label: 'Refresh progress', detail: 'Action · F5', run: refresh },
    {
      label: 'Toggle plans sidebar',
      detail: 'Action · Ctrl B',
      run: toggleSidebar,
    },
    {
      label: 'Settings',
      detail: 'Preferences · Ctrl ,',
      run: () => navigate('/settings/general'),
    },
  ];
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  const matches = (text: string) =>
    words.every((word) => fold(text).includes(word));
  const items = [
    ...plans
      .filter((p) => matches(p.name + ' ' + p.repo + ' ' + p.goal))
      .slice(0, query ? 30 : 5)
      .map((p) => ({
        label: p.name,
        detail: placeLabel(p) + ' · ' + stage(p.status),
        run: () => navigate(planRoute(planKey(p))),
      })),
    ...actions.filter((a) => matches(a.label + ' ' + a.detail)),
  ];
  const selected = Math.min(index, Math.max(0, items.length - 1));
  // Keep the keyboard selection visible inside the scrolling result list.
  useEffect(() => {
    document
      .getElementById(`command-option-${selected}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  function run(i: number) {
    const item = items[i];
    if (item) {
      close();
      item.run();
    }
  }
  return (
    <Modal
      title="Search plans and commands"
      close={close}
      className="command-dialog"
    >
      <div
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            setIndex(
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? Math.max(0, items.length - 1)
                  : (selected +
                      (event.key === 'ArrowDown' ? 1 : items.length - 1)) %
                    Math.max(1, items.length),
            );
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            run(selected);
          }
          if (event.ctrlKey && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            close();
          }
        }}
      >
        <input
          data-initial-focus
          type="search"
          role="combobox"
          aria-label="Search plans or commands"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="command-results"
          aria-activedescendant={
            items.length ? `command-option-${selected}` : undefined
          }
          placeholder="Search plans or commands…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
        />
        <div
          id="command-results"
          role="listbox"
          aria-label="Plans and commands"
        >
          {items.length ? (
            items.map((item, i) => (
              <button
                id={`command-option-${i}`}
                key={item.label + item.detail}
                role="option"
                aria-selected={selected === i}
                tabIndex={-1}
                onClick={() => run(i)}
              >
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </button>
            ))
          ) : (
            <p>No matching plans or commands</p>
          )}
        </div>
        <footer className="muted">↑ ↓ navigate · Enter open · Esc close</footer>
      </div>
    </Modal>
  );
}
export function ShortcutSheet({ close }: { close(): void }) {
  return (
    <Modal title="Keyboard shortcuts" close={close}>
      <dl className="shortcut-sheet">
        {shortcuts.map(([keys, label]) => (
          <div key={keys}>
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">
        Single-key shortcuts can be turned off in Settings → General.
      </p>
    </Modal>
  );
}
