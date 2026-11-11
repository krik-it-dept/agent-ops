import { useEffect, useState } from 'react';
import type {
  SkillsResponse,
  SkillDiff,
  TargetStatus,
  TargetInput,
} from '../../shared/contracts';
import { Empty } from '../components/ui';
import { whenLabel } from '../model';
import { useLedger } from '../store';
import { useAction, usePicker } from './hooks';

export function skillStateText(target: TargetStatus) {
  return (
    {
      'missing-folder': 'Missing folder',
      'not-installed': 'Not installed',
      installed: `Installed v${target.installedVersion}`,
      'update-available': `Update available · v${target.installedVersion} installed`,
      modified: `Modified locally${target.kept ? ' · your version is kept' : ''}`,
    } as const
  )[target.state];
}
export function Skills({
  setup = false,
  next,
}: {
  setup?: boolean;
  next?: () => void;
}) {
  const { client } = useLedger();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const action = useAction();
  const picker = usePicker();
  const [path, setPath] = useState('');
  const [instruction, setInstruction] = useState('');
  const [pasting, setPasting] = useState(false);
  const [edit, setEdit] = useState('');
  const [draft, setDraft] = useState({
    label: '',
    skillDir: '',
    instructionFile: '',
  });
  const [confirm, setConfirm] = useState('');
  const [diff, setDiff] = useState<{ id: string; value: SkillDiff } | null>(
    null,
  );
  const [picks, setPicks] = useState<string[]>([]);
  // Settings changes (Tasks folder, another window) can change the Skills
  // state, so the list follows settings:changed as well as the first load.
  useEffect(
    () =>
      client.settings.onChanged(() => {
        void client.skills
          .list({})
          .then(setData)
          .catch(() => undefined);
      }),
    [client],
  );
  useEffect(() => {
    void client.skills
      .list({})
      .then(setData)
      .catch((e: unknown) =>
        action.setError(
          e instanceof Error ? e.message : 'Skills could not be loaded.',
        ),
      );
  }, [client]);
  const locked = action.busy || !!data?.readOnly;
  async function add(info: TargetInput & { skillDir: string }) {
    await action.run(async () => {
      const result = await client.skills.add(info);
      setData(result);
      setPath('');
      setInstruction('');
      setPasting(false);
      action.setNotice('Folder added. Install the skill when you are ready.');
    });
  }
  async function chooseFolder() {
    await action.run(async () => {
      try {
        const chosen = await picker.pick('skills');
        if (chosen) {
          setData(
            await client.skills.add({
              skillDir: chosen,
              ...(instruction.trim()
                ? { instructionFile: instruction.trim() }
                : {}),
            }),
          );
          action.setNotice(
            'Folder added. Install the skill when you are ready.',
          );
        }
      } catch (error) {
        setPasting(true);
        throw error;
      }
    });
  }
  async function operate(
    target: TargetStatus,
    operation:
      | 'install'
      | 'update'
      | 'replace'
      | 'keep'
      | 'removeSkill'
      | 'instructionsOn'
      | 'instructionsOff'
      | 'removeTarget',
  ) {
    const token = target.id + ':' + operation;
    if (
      ['replace', 'removeSkill', 'removeTarget'].includes(operation) &&
      confirm !== token
    ) {
      setConfirm(token);
      return;
    }
    await action.run(async () => {
      setData(await client.skills[operation]({ id: target.id }));
      setConfirm('');
      setDiff(null);
    });
  }
  async function continueSetup() {
    const ok = await action.run(async () => {
      for (const key of picks) {
        if (key.startsWith('suggestion:')) {
          const s = data?.suggestions[Number(key.slice(11))];
          if (!s) continue;
          const added = await client.skills.add({
            skillDir: s.skillDir,
            ...(s.instructionFile
              ? { instructionFile: s.instructionFile }
              : {}),
            label: s.label,
          });
          if (added.added)
            setData(await client.skills.install({ id: added.added }));
        } else {
          const t = data?.targets.find((t) => t.id === key);
          if (t)
            setData(
              await client.skills[
                t.state === 'update-available' ? 'update' : 'install'
              ]({ id: t.id }),
            );
        }
      }
    });
    if (ok) next?.();
  }
  if (!data)
    return (
      <section>
        <p role={action.error ? 'alert' : 'status'}>
          {action.error || 'Loading Skills…'}
        </p>
        {action.error && (
          <button
            onClick={() => {
              void action.run(async () =>
                setData(await client.skills.list({})),
              );
            }}
          >
            Try again
          </button>
        )}
      </section>
    );
  const migration = data.migration;
  // Update all touches only Skills with a newer version available; files the
  // owner changed ('modified') are never part of it.
  const outdated = data.targets.filter(
    (t) => t.enabled && t.state === 'update-available',
  );
  async function updateAll() {
    await action.run(async () => {
      const failed: string[] = [];
      let updated = 0;
      for (const t of outdated) {
        try {
          setData(await client.skills.update({ id: t.id }));
          updated++;
        } catch (failure) {
          failed.push(
            `${t.label}: ${failure instanceof Error ? failure.message : 'could not be updated'}`,
          );
        }
      }
      if (failed.length)
        throw new Error(
          `${updated} updated, ${failed.length} not updated. ${failed.join(' ')}`,
        );
      action.setNotice(
        `${updated} ${updated === 1 ? 'Skill' : 'Skills'} updated to v${data!.skillVersion}`,
      );
    });
  }
  if (setup) {
    const options = [
      ...data.suggestions.map((s, i) => ({
        key: `suggestion:${i}`,
        label: s.label,
        path: s.skillDir,
      })),
      ...data.targets
        .filter(
          (t) =>
            t.enabled &&
            ['not-installed', 'update-available'].includes(t.state),
        )
        .map((t) => ({ key: t.id, label: t.label, path: t.skillDir })),
    ];
    return (
      <>
        <h1>Connect your AI tools</h1>
        <p>
          Optional. Choose your AI tools to install the shared plan format.
          Every tool keeps plans in your Tasks folder.
        </p>
        {data.readOnly && <p role="alert">{data.readOnly}</p>}
        {options.length ? (
          options.map((o) => (
            <label className="choice-card" key={o.key}>
              <input
                type="checkbox"
                checked={picks.includes(o.key)}
                disabled={locked}
                onChange={(e) =>
                  setPicks(
                    e.target.checked
                      ? [...picks, o.key]
                      : picks.filter((k) => k !== o.key),
                  )
                }
              />
              <span>
                <strong>{o.label}</strong>
                <code className="path">{o.path}</code>
              </span>
            </label>
          ))
        ) : (
          <p>
            No Skills folders were found. You can add folders later in Settings
            → Skills.
          </p>
        )}
        {action.error && <p role="alert">{action.error}</p>}
        <footer className="actions">
          <button disabled={action.busy} onClick={next}>
            Skip
          </button>
          <button
            className="primary skills-next"
            disabled={action.busy}
            onClick={() => {
              void continueSetup();
            }}
          >
            {action.busy ? 'Installing…' : 'Continue'}
          </button>
        </footer>
      </>
    );
  }
  return (
    <section className="skills">
      <p>
        Choose the Skills folders used by your AI tools. Agent Ops installs the
        shared plan format (v{data.skillVersion}) there so every tool keeps
        plans in your Tasks folder. Files you changed are never overwritten
        without asking.
      </p>
      {data.readOnly && (
        <p className="callout warning" role="alert">
          {data.readOnly}
        </p>
      )}
      {action.error && <p role="alert">{action.error}</p>}
      {action.notice && <p role="status">{action.notice}</p>}
      {picker.controls}
      <div className="row">
        <button
          disabled={locked}
          onClick={() => {
            void chooseFolder();
          }}
        >
          Add folder…
        </button>
        <button disabled={locked} onClick={() => setPasting(!pasting)}>
          Paste a path instead
        </button>
        {outdated.length > 0 && (
          <button
            className="primary"
            disabled={locked}
            onClick={() => {
              void updateAll();
            }}
          >
            Update all ({outdated.length})
          </button>
        )}
      </div>
      {pasting && (
        <form
          className="settings-card"
          onSubmit={(e) => {
            e.preventDefault();
            void add({
              skillDir: path.trim(),
              ...(instruction.trim()
                ? { instructionFile: instruction.trim() }
                : {}),
            });
          }}
        >
          <label>
            Skills folder
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
            />
          </label>
          <label>
            Instruction file (optional)
            <input
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                void action.run(async () => {
                  const picked = await picker.pick('instruction-file');
                  if (picked) setInstruction(picked);
                });
              }}
            >
              Choose file…
            </button>
            <button className="primary" disabled={locked}>
              Add
            </button>
          </div>
        </form>
      )}
      <ul className="card-list">
        {data.targets.map((t) => {
          const reminderOn = ['on', 'outdated'].includes(t.instructions.state);
          const oldCopy = [
            'installed',
            'update-available',
            'modified',
          ].includes(t.state);
          const actionButton = (
            operation: Parameters<typeof operate>[1],
            label: string,
            disabled = locked,
          ) => (
            <button
              key={operation}
              disabled={disabled}
              onClick={() => {
                void operate(t, operation);
              }}
            >
              {confirm === `${t.id}:${operation}`
                ? operation === 'replace'
                  ? 'Click again to replace'
                  : 'Click again to remove'
                : label}
            </button>
          );
          return (
            <li key={t.id} className="settings-card" aria-label={t.label}>
              <div className="row">
                <h3>{t.label}</h3>
                <label className="switch-label">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={t.enabled}
                    disabled={locked}
                    onChange={(e) => {
                      void action.run(async () =>
                        setData(
                          await client.skills.edit({
                            id: t.id,
                            enabled: e.target.checked,
                          }),
                        ),
                      );
                    }}
                  />
                  Use this folder
                </label>
              </div>
              <code className="path">{t.skillDir}</code>
              <p>
                Skill: {skillStateText(t)} ·{' '}
                {t.source === 'detected' ? 'Detected' : 'Added by you'}
                {!t.enabled && ' · Off'}
              </p>
              <div className="actions">
                {t.enabled &&
                  t.state === 'not-installed' &&
                  actionButton('install', 'Install')}
                {t.enabled &&
                  t.state === 'update-available' &&
                  actionButton('update', 'Update')}
                {t.enabled && t.state === 'modified' && (
                  <>
                    <button
                      disabled={action.busy}
                      aria-expanded={diff?.id === t.id}
                      onClick={() => {
                        if (diff?.id === t.id) setDiff(null);
                        else
                          void action.run(async () =>
                            setDiff({
                              id: t.id,
                              value: await client.skills.diff({ id: t.id }),
                            }),
                          );
                      }}
                    >
                      {diff?.id === t.id ? 'Hide changes' : 'Show changes'}
                    </button>
                    {!t.kept && actionButton('keep', 'Keep mine')}
                    {actionButton('replace', 'Replace')}
                  </>
                )}
                {['installed', 'update-available'].includes(t.state) &&
                  actionButton('removeSkill', 'Remove skill')}
                <button
                  disabled={locked}
                  aria-expanded={edit === t.id}
                  onClick={() => {
                    setEdit(edit === t.id ? '' : t.id);
                    setDraft({
                      label: t.label,
                      skillDir: t.skillDir,
                      instructionFile: t.instructions.path,
                    });
                  }}
                >
                  Edit path
                </button>
                {actionButton(
                  'removeTarget',
                  'Remove from list',
                  locked || reminderOn,
                )}
              </div>
              {confirm.startsWith(t.id + ':') && (
                <p className="muted">
                  {confirm.endsWith('removeTarget')
                    ? 'Agent Ops stops managing this folder. Files on disk are not changed.'
                    : 'A backup is kept before Agent Ops changes the skill file.'}
                </p>
              )}
              {reminderOn && (
                <p className="muted">
                  Turn the reminder off before removing this folder from the
                  list.
                </p>
              )}
              {edit === t.id && (
                <form
                  aria-label={`Edit ${t.label}`}
                  className="edit-grid"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (locked) return;
                    void action.run(async () => {
                      const patch: TargetInput & { id: string } = { id: t.id };
                      if (draft.label.trim() !== t.label)
                        patch.label = draft.label.trim();
                      if (draft.skillDir.trim() !== t.skillDir)
                        patch.skillDir = draft.skillDir.trim();
                      if (draft.instructionFile.trim() !== t.instructions.path)
                        patch.instructionFile = draft.instructionFile.trim();
                      if (Object.keys(patch).length > 1)
                        setData(await client.skills.edit(patch));
                      setEdit('');
                    });
                  }}
                >
                  <label>
                    Name
                    <input
                      value={draft.label}
                      onChange={(e) =>
                        setDraft({ ...draft, label: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Skills folder
                    <input
                      value={draft.skillDir}
                      onChange={(e) =>
                        setDraft({ ...draft, skillDir: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Instruction file (optional)
                    <input
                      disabled={reminderOn}
                      value={draft.instructionFile}
                      onChange={(e) =>
                        setDraft({ ...draft, instructionFile: e.target.value })
                      }
                    />
                  </label>
                  {oldCopy && (
                    <p className="muted">
                      A new skills folder does not move the skill: the copy in{' '}
                      {t.skillDir} stays.
                    </p>
                  )}
                  <div className="actions">
                    <button
                      type="button"
                      disabled={locked || reminderOn}
                      onClick={() => {
                        void action.run(async () => {
                          const chosen = await picker.pick('instruction-file');
                          if (chosen)
                            setDraft({ ...draft, instructionFile: chosen });
                        });
                      }}
                    >
                      Choose file…
                    </button>
                    <button disabled={locked} className="primary">
                      Save
                    </button>
                    <button type="button" onClick={() => setEdit('')}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              {diff?.id === t.id && (
                <section
                  className="diff"
                  aria-label={`Differences for ${t.label}`}
                >
                  <code>{diff.value.path}</code>
                  {diff.value.identical ? (
                    <p>The file on disk matches what Agent Ops would write.</p>
                  ) : (
                    diff.value.lines.map((line, i) => (
                      <pre
                        key={i}
                        className={
                          line.op === '-'
                            ? 'diff-remove'
                            : line.op === '+'
                              ? 'diff-add'
                              : ''
                        }
                      >
                        {line.op} {line.text}
                      </pre>
                    ))
                  )}
                </section>
              )}
              {t.instructions.path && t.instructions.state !== 'none' && (
                <div className="reminder">
                  <label>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={
                        reminderOn || t.instructions.state === 'modified'
                      }
                      disabled={
                        locked ||
                        t.instructions.state === 'missing-folder' ||
                        (!t.enabled && !reminderOn)
                      }
                      onChange={(e) => {
                        void operate(
                          t,
                          e.target.checked
                            ? 'instructionsOn'
                            : 'instructionsOff',
                        );
                      }}
                    />
                    Add a one-line reminder to{' '}
                    {t.instructions.path.split(/[\\/]/).pop()}
                  </label>
                  <small>
                    {
                      (
                        {
                          on: 'On',
                          off: 'Off',
                          outdated: 'On, but the reminder text is out of date',
                          modified: 'Edited by hand',
                          'missing-folder': 'Its folder is missing',
                          none: '',
                        } as const
                      )[t.instructions.state]
                    }
                  </small>
                  <code className="path">{t.instructions.path}</code>
                  {t.instructions.state === 'outdated' &&
                    t.enabled &&
                    actionButton('instructionsOn', 'Refresh reminder')}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!data.targets.length && (
        <Empty title="No folders yet">
          <p>Add a folder, or one found on this computer below.</p>
        </Empty>
      )}
      {data.suggestions.length > 0 && (
        <section>
          <h3>Found on this computer</h3>
          <p className="muted">
            Suggestions only. Nothing is added until you choose it.
          </p>
          {data.suggestions.map((s, i) => (
            <div className="settings-card" key={i}>
              <strong>{s.label}</strong>
              <code className="path">{s.skillDir}</code>
              <button
                disabled={locked}
                onClick={() => {
                  void add({
                    skillDir: s.skillDir,
                    label: s.label,
                    ...(s.instructionFile
                      ? { instructionFile: s.instructionFile }
                      : {}),
                  });
                }}
              >
                Add
              </button>
            </div>
          ))}
        </section>
      )}
      {migration &&
        ((migration.checklist?.length ||
          migration.kept?.length ||
          migration.errors?.length) ??
          0) > 0 && (
          <section>
            <h3>Review by hand</h3>
            {!migration.done && migration.nextRetryAt && (
              <p>
                Cleanup from the earlier release is not finished. Agent Ops
                tries again when it starts after{' '}
                <time dateTime={migration.nextRetryAt}>
                  {whenLabel(migration.nextRetryAt, new Date().toISOString()) ||
                    'the next start'}
                </time>
                .
              </p>
            )}
            {migration.errors?.map((e, i) => (
              <p role="alert" key={i}>
                {e}
              </p>
            ))}
            <p>
              These files need your review. Agent Ops does not change text you
              wrote.
            </p>
            {migration.backup && (
              <code className="path">Backups: {migration.backup}</code>
            )}
            {migration.checklist?.map((item, i) => (
              <article className="entry" key={i}>
                <code>
                  {item.file}:{item.line}
                </code>
                <p>{item.text}</p>
              </article>
            ))}
            {migration.kept?.map((text, i) => (
              <p key={i}>Kept unchanged: {text}</p>
            ))}
          </section>
        )}
    </section>
  );
}
