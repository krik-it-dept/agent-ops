import { contextBridge, ipcRenderer } from 'electron';
import { createBridge } from '../shared/contracts/bridge';
import { parseEvent } from '../shared/contracts/wire';
import { invokeValidated } from './transport';
import type {
  EventMap,
  RequestMap,
  ResponseMap,
  Result,
} from '../shared/contracts';

let activationSubscribed = false;
const bridge = createBridge(
  async <C extends keyof RequestMap>(
    channel: C,
    payload: RequestMap[C],
  ): Promise<Result<ResponseMap[C]>> => {
    return invokeValidated(
      channel,
      payload,
      (name, request) => ipcRenderer.invoke(name, request),
      (id, error) => console.error('Agent Ops IPC failure ' + id, error),
    );
  },
  <C extends keyof EventMap>(
    channel: C,
    listener: (event: EventMap[C]) => void,
  ) => {
    let active = true;
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (!active) return;
      try {
        listener(parseEvent(channel, value));
      } catch {
        /* Ignore malformed transport events. */
      }
    };
    ipcRenderer.on(channel, handler);
    if (channel === 'app:activate' && !activationSubscribed) {
      activationSubscribed = true;
      void invokeValidated(
        'app:renderer-ready',
        {},
        (name, payload) => ipcRenderer.invoke(name, payload),
        (id, error) => console.error('Agent Ops IPC failure ' + id, error),
      );
    }
    return () => {
      if (active) {
        active = false;
        ipcRenderer.removeListener(channel, handler);
      }
    };
  },
);
contextBridge.exposeInMainWorld('agentOps', bridge);

// Synthetic clicks and direct window.open calls cannot invoke the system browser.
document.addEventListener(
  'click',
  (event) => {
    if (!event.isTrusted || event.defaultPrevented || event.button !== 0)
      return;
    const target =
      event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    const key = target.dataset.agentOpsPlan;
    const number = Number(target.dataset.agentOpsPr);
    const version = target.dataset.agentOpsRelease;
    if (!version && !(key && Number.isSafeInteger(number) && number > 0))
      return;
    event.preventDefault();
    void bridge.shell.openExternal(
      version
        ? { target: 'release', version }
        : { target: 'pull-request', key: key!, number },
    );
  },
  true,
);
