import {
  channels,
  type JsonValue,
  type Requests,
  type Settings,
  type SettingsUpdate,
  type Theme,
} from './ipc';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 50) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item: unknown) => isJson(item, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isJson(item, depth + 1))
  );
}

// Unknown JSON keys survive a read/update cycle so later modules can extend config.json.
export function parseSettings(value: unknown): Settings {
  if (!isRecord(value) || !isJson(value))
    throw new Error('Settings must be a JSON object.');
  return { ...value, theme: isTheme(value.theme) ? value.theme : 'system' };
}

export function parseSettingsUpdate(value: unknown): SettingsUpdate {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'theme') ||
    (Object.hasOwn(value, 'theme') && !isTheme(value.theme))
  ) {
    throw new Error('Only a valid theme setting can be updated.');
  }
  return Object.hasOwn(value, 'theme') ? { theme: value.theme as Theme } : {};
}

export function parseHttpsLink(value: unknown): { url: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.url !== 'string' ||
    value.url.length > 8192
  ) {
    throw new Error('Expected an HTTPS link.');
  }
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('Expected an HTTPS link.');
  return { url: url.href };
}

export function parseRequest<C extends keyof Requests>(
  channel: C,
  value: unknown,
): Requests[C] {
  let parsed: unknown;
  switch (channel) {
    case channels.getInfo:
    case channels.getSettings:
      if (value !== undefined)
        throw new Error('This request takes no payload.');
      parsed = undefined;
      break;
    case channels.updateSettings:
      parsed = parseSettingsUpdate(value);
      break;
    case channels.openExternal:
      parsed = parseHttpsLink(value);
      break;
    default:
      throw new Error('Unknown IPC channel.');
  }
  return parsed as Requests[C];
}
