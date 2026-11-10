import type { EventMap, RequestMap, ResponseMap, Result } from './index';

function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function json(value: unknown, depth = 0): boolean {
  if (depth > 60) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((v: unknown) => json(v, depth + 1));
  return record(value) && Object.values(value).every((v) => json(v, depth + 1));
}
const phases = [
  'idle',
  'checking',
  'available',
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'updated',
  'error',
];
const codes = [
  'INVALID_REQUEST',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'READ_ONLY',
  'BUSY',
  'INSIDE_WORKSPACE',
  'REVISION_CHANGED',
  'UNAVAILABLE',
  'TIMEOUT',
  'IO_ERROR',
  'REFRESH_FAILED',
  'INTERNAL',
];
function update(value: unknown): boolean {
  return (
    record(value) &&
    [
      'current',
      'commit',
      'latest',
      'notes',
      'error',
      'message',
      'checkedAt',
    ].every((key) => typeof value[key] === 'string') &&
    typeof value.processId === 'number' &&
    typeof value.available === 'boolean' &&
    typeof value.skipped === 'boolean' &&
    phases.includes(String(value.phase))
  );
}
function settings(value: unknown): boolean {
  return (
    record(value) &&
    ['system', 'light', 'dark'].includes(String(value.theme)) &&
    Array.isArray(value.projects) &&
    typeof value.tasksDir === 'string' &&
    typeof value.setupComplete === 'boolean'
  );
}
function skills(value: unknown): boolean {
  return (
    record(value) &&
    Array.isArray(value.targets) &&
    Array.isArray(value.suggestions) &&
    typeof value.skillVersion === 'number' &&
    typeof value.readOnly === 'string'
  );
}
function response(channel: keyof RequestMap, value: unknown): boolean {
  if (!record(value)) return false;
  if (channel === 'app:renderer-ready') return value.ready === true;
  if (channel === 'app:get-info')
    return (
      typeof value.version === 'string' &&
      typeof value.dataDir === 'string' &&
      value.platform === 'win32'
    );
  if (channel.startsWith('updates:')) return update(value);
  if (channel === 'state:get')
    return (
      Number.isSafeInteger(value.generation) &&
      record(value.state) &&
      Array.isArray(value.state.plans) &&
      Array.isArray(value.activity) &&
      Array.isArray(value.warnings) &&
      typeof value.error === 'string'
    );
  if (
    [
      'settings:get',
      'settings:set',
      'workspaces:edit',
      'workspaces:remove',
      'plans:archive',
    ].includes(channel)
  )
    return settings(value);
  if (channel === 'workspaces:add')
    return (
      record(value.project) &&
      Array.isArray(value.repos) &&
      settings(value.settings)
    );
  if (channel.startsWith('tasks:'))
    return (
      Array.isArray(value.results) &&
      Number.isSafeInteger(value.moved) &&
      Number.isSafeInteger(value.failed) &&
      settings(value.settings)
    );
  if (channel === 'skills:diff')
    return (
      typeof value.path === 'string' &&
      Array.isArray(value.lines) &&
      typeof value.identical === 'boolean'
    );
  if (channel.startsWith('skills:')) return skills(value);
  if (channel === 'shell:pick')
    return value.cancelled === true || typeof value.path === 'string';
  if (channel === 'shell:cancel-pick')
    return typeof value.cancelled === 'boolean';
  if (channel.startsWith('shell:open-')) return value.opened === true;
  if (channel === 'plans:recycle') return value.recycled === true;
  if (channel === 'diagnostics:get') return typeof value.text === 'string';
  if (channel === 'diagnostics:copy') return value.copied === true;
  if (channel === 'diagnostics:dismiss-crash') return value.dismissed === true;
  if (channel === 'state:refresh') return typeof value.refreshedAt === 'string';
  return (
    Number.isSafeInteger(value.pid) &&
    (channel !== 'app:get-instance' || typeof value.version === 'string')
  );
}
export function parseResult<C extends keyof RequestMap>(
  channel: C,
  value: unknown,
): Result<ResponseMap[C]> {
  if (!json(value) || !record(value))
    throw new Error('Invalid response from Agent Ops.');
  if (
    value.ok === true &&
    Object.keys(value).length === 2 &&
    response(channel, value.value)
  )
    return value as unknown as Result<ResponseMap[C]>;
  if (
    value.ok === false &&
    Object.keys(value).length === 2 &&
    record(value.error) &&
    codes.includes(String(value.error.code)) &&
    typeof value.error.message === 'string' &&
    typeof value.error.retryable === 'boolean'
  )
    return value as unknown as Result<ResponseMap[C]>;
  throw new Error('Invalid response from Agent Ops.');
}
export function parseEvent<C extends keyof EventMap>(
  channel: C,
  value: unknown,
): EventMap[C] {
  if (!json(value) || !record(value))
    throw new Error('Invalid event from Agent Ops.');
  const valid =
    channel === 'settings:changed'
      ? settings(value)
      : channel === 'updates:changed'
        ? update(value)
        : channel === 'state:changed'
          ? Number.isSafeInteger(value.generation) &&
            Number(value.generation) >= 0 &&
            Object.keys(value).length === 1
          : (value.plan === null || typeof value.plan === 'string') &&
            ['overview', 'plan', 'settings'].includes(String(value.route)) &&
            Object.keys(value).length === 2;
  if (!valid) throw new Error('Invalid event from Agent Ops.');
  return value as unknown as EventMap[C];
}
