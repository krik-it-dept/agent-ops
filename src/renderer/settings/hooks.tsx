import { useEffect, useRef, useState } from 'react';
import type { PickPurpose } from '../../shared/contracts';
import { useLedger } from '../store';

export function useAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // A confirmation such as "Saved" fades on its own; errors stay until the next action.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function run(work: () => Promise<void>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      return true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The request could not be completed.',
      );
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, error, notice, setError, setNotice, run };
}
export function usePicker() {
  const { client } = useLedger();
  const [requestId, setRequestId] = useState('');
  async function pick(purpose: PickPurpose) {
    if (requestId)
      throw new Error('A folder picker is already open. Cancel it first.');
    const id = crypto.randomUUID();
    setRequestId(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const choice = await Promise.race([
        client.shell.pick({ requestId: id, purpose }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void client.shell
              .cancelPick({ requestId: id })
              .catch(() => undefined);
            reject(
              new Error(
                'Choosing a folder took too long. Paste a path instead.',
              ),
            );
          }, 125_000);
        }),
      ]);
      return choice.path ?? '';
    } finally {
      if (timer) clearTimeout(timer);
      setRequestId('');
    }
  }
  const controls = requestId ? (
    <div className="callout" role="status">
      <p>Choose a folder in the Windows dialog.</p>
      <button
        onClick={() => {
          void client.shell.cancelPick({ requestId }).catch(() => undefined);
        }}
      >
        Cancel picker
      </button>
    </div>
  ) : null;
  return { pick, controls };
}
