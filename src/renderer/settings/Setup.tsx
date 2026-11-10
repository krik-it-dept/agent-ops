import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLedger } from '../store';
import { useAction } from './hooks';
import { Preferences, Tasks, Workspaces } from './Settings';
import { Skills } from './Skills';

export function Setup() {
  const { settings, client, setSettings, reload } = useLedger();
  const navigate = useNavigate();
  const action = useAction();
  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [skip, setSkip] = useState(false);
  // A Tasks folder the owner chose but has not confirmed must not be
  // replaced by the suggested folder when setup finishes.
  const [tasksPending, setTasksPending] = useState(false);
  const panel = useRef<HTMLElement>(null);
  function go(next: number) {
    setStep(next);
    setVisited((value) => Math.max(value, next));
    setSkip(false);
  }
  async function finish() {
    const ok = await action.run(async () => {
      if (
        visited >= 3 &&
        settings &&
        !settings.tasksDir &&
        settings.tasksDirSuggested
      ) {
        setSettings(
          await client.settings.set({ tasksDir: settings.tasksDirSuggested }),
        );
      }
      const next = await client.settings.set({ setupComplete: true });
      setSettings(next);
      await reload();
    });
    if (ok) navigate('/');
    else await reload();
  }
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [step]);
  useEffect(() => {
    if (skip)
      panel.current
        ?.querySelector<HTMLElement>('[data-initial-focus]')
        ?.focus();
  }, [skip]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSkip((value) => !value);
      }
      if (event.ctrlKey && event.key === 'Enter') {
        event.preventDefault();
        if (step === 3) {
          if (!tasksPending) void finish();
        } else if (step !== 2) go(step + 1);
        else
          panel.current
            ?.querySelector<HTMLButtonElement>('.skills-next')
            ?.click();
      }
      if (event.key === 'Tab') {
        const controls = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            'button,input,select,a[href],[tabindex="0"]',
          ) || []),
        ].filter(
          (el) =>
            !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [step, visited, settings, tasksPending]);
  return (
    <main
      className="setup-page"
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Agent Ops setup"
    >
      <header className="row">
        <strong>Agent Ops</strong>
        <nav className="setup-progress" aria-label="Setup steps">
          {['Welcome', 'Workspace', 'Skills', 'Tasks'].map((title, i) => (
            <button
              key={title}
              disabled={i > visited || action.busy}
              aria-label={`Step ${i + 1}: ${title}`}
              aria-current={step === i ? 'step' : undefined}
              onClick={() => go(i)}
            >
              {i + 1} <span>{title}</span>
            </button>
          ))}
        </nav>
        <small>Step {step + 1} of 4</small>
      </header>
      <section className="setup-body">
        {step === 0 && (
          <>
            <p className="eyebrow">Welcome to Agent Ops</p>
            <h1 tabIndex={-1}>Your plans, together in one place</h1>
            <p>
              Choose a Workspace, connect your AI tools with Skills, and keep
              all plans in one Tasks folder. See goals, next steps and progress
              together.
            </p>
            <ul className="feature-list">
              <li>
                <strong>One Tasks folder</strong>
                <p>Every AI tool keeps its plans in the same folder.</p>
              </li>
              <li>
                <strong>Updates live</strong>
                <p>Changes appear as soon as a plan file is saved.</p>
              </li>
              <li>
                <strong>Stays on this PC</strong>
                <p>Your plans and settings stay on this computer.</p>
              </li>
            </ul>
          </>
        )}
        {step === 1 && (
          <>
            <h1 tabIndex={-1}>Add your workspace</h1>
            <p>
              Choose the folders where your work lives. You can change them any
              time in Settings &gt; Workspace.
            </p>
            <Workspaces setup />
          </>
        )}
        {step === 2 && <Skills setup next={() => go(3)} />}
        {step === 3 && (
          <>
            <h1 tabIndex={-1}>Tasks</h1>
            <Tasks onPending={setTasksPending} />
            <h2>Preferences</h2>
            <Preferences setup />
          </>
        )}
        {action.error && <p role="alert">{action.error}</p>}
      </section>
      <footer className="setup-footer">
        {skip ? (
          <section role="alertdialog" aria-label="Skip setup?">
            <strong>Skip setup?</strong>
            <p>You can finish it later from Settings.</p>
            <div className="actions">
              <button data-initial-focus onClick={() => setSkip(false)}>
                Keep going
              </button>
              <button
                disabled={action.busy}
                onClick={() => {
                  void finish();
                }}
              >
                Skip
              </button>
            </div>
          </section>
        ) : (
          <>
            <button disabled={action.busy} onClick={() => setSkip(true)}>
              Set up later
            </button>
            <div className="actions">
              {step > 0 && <button onClick={() => go(step - 1)}>Back</button>}
              {step === 3 && tasksPending && (
                <small id="setup-tasks-pending">
                  Confirm or cancel the new Tasks folder first.
                </small>
              )}
              {step !== 2 && (
                <button
                  className="primary"
                  disabled={action.busy || (step === 3 && tasksPending)}
                  aria-describedby={
                    step === 3 && tasksPending
                      ? 'setup-tasks-pending'
                      : undefined
                  }
                  onClick={() => {
                    if (step === 3) void finish();
                    else go(step + 1);
                  }}
                >
                  {step === 3
                    ? action.busy
                      ? 'Opening…'
                      : 'Open ledger'
                    : 'Continue'}
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </main>
  );
}
