import { describe, expect, it } from 'vitest';
import { channels } from './ipc';
import {
  parseHttpsLink,
  parseRequest,
  parseSettings,
  parseSettingsUpdate,
} from './validators';

describe('IPC validators', () => {
  it('accepts only absent payloads on read channels', () => {
    for (const channel of [channels.getInfo, channels.getSettings]) {
      expect(parseRequest(channel, undefined)).toBeUndefined();
      for (const bad of [null, {}, [], false, ''])
        expect(() => parseRequest(channel, bad)).toThrow();
    }
  });
  it('allows supported themes and an empty update', () => {
    for (const theme of ['system', 'light', 'dark'])
      expect(parseSettingsUpdate({ theme })).toEqual({ theme });
    expect(parseSettingsUpdate({})).toEqual({});
  });
  it.each([
    null,
    [],
    'dark',
    { theme: null },
    { theme: undefined },
    { theme: 'auto' },
    { tasksDir: 'x' },
    { theme: 'dark', extra: true },
    new Date(),
  ])('rejects malformed updates: %j', (value) => {
    expect(() => parseRequest(channels.updateSettings, value)).toThrow();
  });
  it('preserves unknown nested JSON keys and normalizes absent/legacy themes', () => {
    const input = {
      theme: '',
      tasksDir: 'D:\\Tasks',
      future: { list: [true, 1, null] },
    };
    expect(parseSettings(input)).toEqual({ ...input, theme: 'system' });
    expect(parseSettings({})).toEqual({ theme: 'system' });
    expect(() => parseSettings({ future: () => undefined })).toThrow();
    expect(() => parseSettings({ number: Infinity })).toThrow();
    expect(() => parseSettings([])).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseSettings(cyclic)).toThrow();
  });
  it('accepts HTTPS links only, without credentials or additional fields', () => {
    expect(parseHttpsLink({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com/',
    });
    for (const url of [
      'http://example.com',
      'file:///C:/test',
      'javascript:alert(1)',
      'https://user:secret@example.com',
      'not a URL',
    ]) {
      expect(() => parseHttpsLink({ url })).toThrow();
    }
    expect(() =>
      parseHttpsLink({ url: 'https://example.com', extra: true }),
    ).toThrow();
  });
});
