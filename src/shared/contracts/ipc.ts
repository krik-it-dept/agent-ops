import type * as D from './dto';

export interface RequestMap {
  /** Private preload handshake after activation listeners are attached. */
  'app:renderer-ready': D.Empty;
  'app:get-info': D.Empty;
  'state:get': D.Empty;
  'state:refresh': D.Empty;
  'settings:get': D.Empty;
  'settings:set': D.SettingsPatch;
  'workspaces:add': { path: string };
  'workspaces:edit': { id: D.ProjectId; name?: string; enabled?: boolean };
  'workspaces:remove': { id: D.ProjectId };
  'tasks:move-legacy': { keys?: D.PlanKey[] };
  'tasks:move-all': { from: string };
  'plans:archive': { key: D.PlanKey; archived: boolean };
  'plans:recycle': { key: D.PlanKey; revision: D.Revision; confirm: true };
  'plans:mark-done': { key: D.PlanKey; revision: D.Revision };
  'plans:set-status': {
    key: D.PlanKey;
    revision: D.Revision;
    status: D.PlanState;
  };
  'plans:undo-mark-done': { key: D.PlanKey; token: string };
  'skills:list': D.Empty;
  'skills:add': D.TargetInput & { skillDir: string };
  'skills:edit': D.TargetInput & { id: D.TargetId };
  'skills:remove-target': { id: D.TargetId };
  'skills:diff': { id: D.TargetId };
  'skills:install': { id: D.TargetId };
  'skills:update': { id: D.TargetId };
  'skills:replace': { id: D.TargetId };
  'skills:keep': { id: D.TargetId };
  'skills:remove-skill': { id: D.TargetId };
  'skills:instructions-on': { id: D.TargetId };
  'skills:instructions-off': { id: D.TargetId };
  'shell:pick': D.PickRequest;
  'shell:cancel-pick': { requestId: string };
  'shell:open-folder': D.OpenFolderRequest;
  'shell:open-external': D.OpenExternalRequest;
  'diagnostics:get': D.Empty;
  'diagnostics:copy': D.Empty;
  'diagnostics:dismiss-crash': D.Empty;
  'app:get-instance': D.Empty;
  'app:open': { plan?: D.PlanKey };
  'updates:get': D.Empty;
  'updates:check': D.Empty;
  'updates:apply': { version: string };
  'updates:skip': { version: string };
}
export interface ResponseMap {
  'app:renderer-ready': { ready: true };
  'app:get-info': {
    version: string;
    dataDir: string;
    platform: 'win32';
    sampleModeAllowed?: boolean;
  };
  'state:get': D.StateResponse;
  'state:refresh': { refreshedAt: D.ISOTime };
  'settings:get': D.Settings;
  'settings:set': D.SettingsSetResponse;
  'workspaces:add': D.WorkspaceAddResponse;
  'workspaces:edit': D.Settings;
  'workspaces:remove': D.Settings;
  'tasks:move-legacy': D.MoveResponse;
  'tasks:move-all': D.MoveResponse;
  'plans:archive': D.Settings;
  'plans:recycle': { recycled: true };
  'plans:mark-done': D.MarkDoneResponse;
  'plans:set-status': D.MarkDoneResponse;
  'plans:undo-mark-done': D.UndoMarkDoneResponse;
  'skills:list': D.SkillsResponse;
  'skills:add': D.SkillsResponse;
  'skills:edit': D.SkillsResponse;
  'skills:remove-target': D.SkillsResponse;
  'skills:diff': D.SkillDiff;
  'skills:install': D.SkillsResponse;
  'skills:update': D.SkillsResponse;
  'skills:replace': D.SkillsResponse;
  'skills:keep': D.SkillsResponse;
  'skills:remove-skill': D.SkillsResponse;
  'skills:instructions-on': D.SkillsResponse;
  'skills:instructions-off': D.SkillsResponse;
  'shell:pick': D.PickResponse;
  'shell:cancel-pick': { cancelled: boolean };
  'shell:open-folder': { opened: true };
  'shell:open-external': { opened: true };
  'diagnostics:get': { text: string };
  'diagnostics:copy': { copied: true };
  'diagnostics:dismiss-crash': { dismissed: true };
  'app:get-instance': { pid: number; version: string };
  'app:open': { pid: number };
  'updates:get': D.UpdateState;
  'updates:check': D.UpdateState;
  'updates:apply': D.UpdateState;
  'updates:skip': D.UpdateState;
}
type Call<C extends keyof RequestMap> = (
  request: RequestMap[C],
) => Promise<D.Result<ResponseMap[C]>>;
type Subscribe<C extends keyof D.EventMap> = (
  listener: (event: D.EventMap[C]) => void,
) => () => void;
export interface AgentOpsBridge {
  state: {
    get: Call<'state:get'>;
    refresh: Call<'state:refresh'>;
    onChanged: Subscribe<'state:changed'>;
  };
  settings: {
    get: Call<'settings:get'>;
    set: Call<'settings:set'>;
    onChanged: Subscribe<'settings:changed'>;
  };
  workspaces: {
    add: Call<'workspaces:add'>;
    edit: Call<'workspaces:edit'>;
    remove: Call<'workspaces:remove'>;
  };
  tasks: {
    moveLegacy: Call<'tasks:move-legacy'>;
    moveAll: Call<'tasks:move-all'>;
  };
  plans: {
    archive: Call<'plans:archive'>;
    recycle: Call<'plans:recycle'>;
    markDone: Call<'plans:mark-done'>;
    setStatus: Call<'plans:set-status'>;
    undoMarkDone: Call<'plans:undo-mark-done'>;
  };
  skills: {
    list: Call<'skills:list'>;
    add: Call<'skills:add'>;
    edit: Call<'skills:edit'>;
    removeTarget: Call<'skills:remove-target'>;
    diff: Call<'skills:diff'>;
    install: Call<'skills:install'>;
    update: Call<'skills:update'>;
    replace: Call<'skills:replace'>;
    keep: Call<'skills:keep'>;
    removeSkill: Call<'skills:remove-skill'>;
    instructionsOn: Call<'skills:instructions-on'>;
    instructionsOff: Call<'skills:instructions-off'>;
  };
  shell: {
    pick: Call<'shell:pick'>;
    cancelPick: Call<'shell:cancel-pick'>;
    openFolder: Call<'shell:open-folder'>;
    openExternal: Call<'shell:open-external'>;
  };
  diagnostics: {
    get: Call<'diagnostics:get'>;
    copy: Call<'diagnostics:copy'>;
    dismissCrash: Call<'diagnostics:dismiss-crash'>;
  };
  app: {
    getInfo: Call<'app:get-info'>;
    getInstance: Call<'app:get-instance'>;
    open: Call<'app:open'>;
    onActivate: Subscribe<'app:activate'>;
  };
  updates: {
    get: Call<'updates:get'>;
    check: Call<'updates:check'>;
    apply: Call<'updates:apply'>;
    skip: Call<'updates:skip'>;
    onChanged: Subscribe<'updates:changed'>;
  };
}

export type Client<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<D.Result<infer V>>
    ? (...args: A) => Promise<V>
    : T[K] extends object
      ? T[K] extends (...args: never[]) => unknown
        ? T[K]
        : Client<T[K]>
      : T[K];
};
export type AgentOpsClient = Client<AgentOpsBridge>;
