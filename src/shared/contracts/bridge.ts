import type {
  AgentOpsBridge,
  EventMap,
  RequestMap,
  ResponseMap,
  Result,
} from './index';

export type Invoker = <C extends keyof RequestMap>(
  channel: C,
  request: RequestMap[C],
) => Promise<Result<ResponseMap[C]>>;
export type Subscriber = <C extends keyof EventMap>(
  channel: C,
  listener: (event: EventMap[C]) => void,
) => () => void;

export function createBridge(
  invoke: Invoker,
  subscribe: Subscriber,
): AgentOpsBridge {
  const call =
    <C extends keyof RequestMap>(channel: C) =>
    (request: RequestMap[C]) =>
      invoke(channel, request);
  return {
    state: {
      get: call('state:get'),
      refresh: call('state:refresh'),
      onChanged: (listener) => subscribe('state:changed', listener),
    },
    settings: {
      get: call('settings:get'),
      set: call('settings:set'),
      onChanged: (listener) => subscribe('settings:changed', listener),
    },
    workspaces: {
      add: call('workspaces:add'),
      edit: call('workspaces:edit'),
      remove: call('workspaces:remove'),
    },
    tasks: {
      moveLegacy: call('tasks:move-legacy'),
      moveAll: call('tasks:move-all'),
    },
    plans: {
      archive: call('plans:archive'),
      recycle: call('plans:recycle'),
      markDone: call('plans:mark-done'),
      setStatus: call('plans:set-status'),
      undoMarkDone: call('plans:undo-mark-done'),
    },
    skills: {
      list: call('skills:list'),
      add: call('skills:add'),
      edit: call('skills:edit'),
      removeTarget: call('skills:remove-target'),
      diff: call('skills:diff'),
      install: call('skills:install'),
      update: call('skills:update'),
      replace: call('skills:replace'),
      keep: call('skills:keep'),
      removeSkill: call('skills:remove-skill'),
      instructionsOn: call('skills:instructions-on'),
      instructionsOff: call('skills:instructions-off'),
    },
    shell: {
      pick: call('shell:pick'),
      cancelPick: call('shell:cancel-pick'),
      openFolder: call('shell:open-folder'),
      openExternal: call('shell:open-external'),
    },
    diagnostics: {
      get: call('diagnostics:get'),
      copy: call('diagnostics:copy'),
      dismissCrash: call('diagnostics:dismiss-crash'),
    },
    app: {
      getInfo: call('app:get-info'),
      getInstance: call('app:get-instance'),
      open: call('app:open'),
      onActivate: (listener) => subscribe('app:activate', listener),
    },
    updates: {
      get: call('updates:get'),
      check: call('updates:check'),
      apply: call('updates:apply'),
      skip: call('updates:skip'),
      onChanged: (listener) => subscribe('updates:changed', listener),
    },
  };
}
