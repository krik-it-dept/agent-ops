import { ServiceFault } from './errors';
import type { RequestMap } from '../../shared/contracts';

interface Rule<T> {
  read(value: unknown): T;
}
interface Optional<T> extends Rule<T> {
  optional: true;
}
type Value<R> = R extends Rule<infer T> ? T : never;
type Shape = Record<string, Rule<unknown>>;
type ObjectValue<S extends Shape> = {
  [K in keyof S as S[K] extends Optional<unknown> ? never : K]: Value<S[K]>;
} & {
  [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: Value<S[K]>;
};
function invalid(): never {
  throw new ServiceFault('INVALID_REQUEST', 'This request is not valid.');
}
function record(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
export function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 40) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((v: unknown) => jsonValue(v, depth + 1));
  return (
    record(value) &&
    Object.entries(value).every(
      ([key, v]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        jsonValue(v, depth + 1),
    )
  );
}
const text = (max = 32767, min = 1, pattern?: RegExp): Rule<string> => ({
  read: (v) =>
    typeof v === 'string' &&
    !v.includes('\0') &&
    Buffer.byteLength(v) >= min &&
    Buffer.byteLength(v) <= max &&
    (!pattern || pattern.test(v))
      ? v
      : invalid(),
});
const bool: Rule<boolean> = {
  read: (v) => (typeof v === 'boolean' ? v : invalid()),
};
const literal = <T extends string | boolean>(...values: T[]): Rule<T> => ({
  read: (v) => (values.includes(v as T) ? (v as T) : invalid()),
});
const integer: Rule<number> = {
  read: (v) =>
    Number.isSafeInteger(v) && Number(v) > 0 ? (v as number) : invalid(),
};
const optional = <T>(rule: Rule<T>): Optional<T> => ({
  ...rule,
  optional: true,
});
const array = <T>(rule: Rule<T>): Rule<T[]> => ({
  read: (v) =>
    Array.isArray(v) ? v.map((item: unknown) => rule.read(item)) : invalid(),
});
function object<S extends Shape>(shape: S): Rule<ObjectValue<S>> {
  return {
    read(value) {
      if (
        !record(value) ||
        Object.keys(value).some((key) => !Object.hasOwn(shape, key))
      )
        invalid();
      const out: Record<string, unknown> = {};
      for (const [key, rule] of Object.entries(shape)) {
        if (!Object.hasOwn(value, key)) {
          if ('optional' in rule) continue;
          invalid();
        }
        out[key] = rule.read(value[key]);
      }
      return out as ObjectValue<S>;
    },
  };
}
function union<A, B>(a: Rule<A>, b: Rule<B>): Rule<A | B> {
  return {
    read(v) {
      try {
        return a.read(v);
      } catch {
        return b.read(v);
      }
    },
  };
}
const empty = object({});
const id = text(40, 1, /^[a-z0-9][a-z0-9-]{0,39}$/);
const key = text(1024);
const revision = text(64, 64, /^[a-f0-9]{64}$/);
const version = text(80, 1, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const target = {
  skillDir: optional(text()),
  instructionFile: optional(text(32767, 0)),
  label: optional(text(1024)),
  enabled: optional(bool),
};
const byId = object({ id });
export const requestSchemas = {
  'app:renderer-ready': empty,
  'state:get': empty,
  'state:refresh': empty,
  'settings:get': empty,
  'settings:set': object({
    notifications: optional(bool),
    setupComplete: optional(bool),
    startWithWindows: optional(bool),
    theme: optional(literal('system', 'light', 'dark')),
    shortcuts: optional(bool),
    autoArchiveDone: optional(bool),
    tasksDir: optional(text()),
    allowInsideWorkspace: optional(bool),
    moveExisting: optional(bool),
  }),
  'workspaces:add': object({ path: text() }),
  'workspaces:edit': object({
    id,
    name: optional(text(480)),
    enabled: optional(bool),
  }),
  'workspaces:remove': byId,
  'tasks:move-legacy': object({ keys: optional(array(key)) }),
  'tasks:move-all': object({ from: text() }),
  'plans:archive': object({ key, archived: bool }),
  'plans:recycle': object({ key, revision, confirm: literal(true) }),
  'skills:list': empty,
  'skills:add': object({ ...target, skillDir: text() }),
  'skills:edit': object({ id, ...target }),
  'skills:remove-target': byId,
  'skills:diff': byId,
  'skills:install': byId,
  'skills:update': byId,
  'skills:replace': byId,
  'skills:keep': byId,
  'skills:remove-skill': byId,
  'skills:instructions-on': byId,
  'skills:instructions-off': byId,
  'shell:pick': object({
    requestId: text(64, 1, /^[a-zA-Z0-9_-]+$/),
    purpose: literal('workspace', 'skills', 'tasks', 'instruction-file'),
  }),
  'shell:cancel-pick': object({ requestId: text(64, 1, /^[a-zA-Z0-9_-]+$/) }),
  'shell:open-folder': union(
    union(
      object({ target: literal('data', 'logs', 'tasks') }),
      object({ target: literal('project'), id }),
    ),
    object({ target: literal('plan'), key }),
  ),
  'shell:open-external': union(
    object({ target: literal('release'), version }),
    object({ target: literal('pull-request'), key, number: integer }),
  ),
  'diagnostics:get': empty,
  'diagnostics:copy': empty,
  'diagnostics:dismiss-crash': empty,
  'app:get-info': empty,
  'app:get-instance': empty,
  'app:open': object({ plan: optional(key) }),
  'updates:get': empty,
  'updates:check': empty,
  'updates:apply': object({ version }),
  'updates:skip': object({ version }),
} as const satisfies { [C in keyof RequestMap]: Rule<RequestMap[C]> };
export type Channel = keyof RequestMap;
export type Request<C extends Channel> = RequestMap[C];
export function parseRequest<C extends Channel>(
  channel: C,
  value: unknown,
): Request<C> {
  if (!jsonValue(value)) invalid();
  const max =
    channel === 'tasks:move-legacy'
      ? 1024 * 1024
      : ['updates:apply', 'updates:skip'].includes(channel)
        ? 1024
        : 8192;
  if (Buffer.byteLength(JSON.stringify(value)) > max) invalid();
  return requestSchemas[channel].read(value) as Request<C>;
}
